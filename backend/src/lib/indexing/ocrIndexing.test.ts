import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { closeDb, getDb } from "../../db/sqlite";
import { runMigrations } from "../../db/migrate";
import { uploadFile } from "../storage";
import type { OcrEngine, OcrResult } from "../ocr/types";
import { indexDocumentVersion } from "./indexer";
import { searchProjectIndex } from "./search";
import {
  extractAnnotationContext,
  reassembleIndexedDocumentText,
  runToolCalls,
  validateCitationEvidence,
} from "../chatTools";
import { createServerSupabase } from "../supabase";

let testRoot = "";

before(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docket-ocr-index-test-"));
  process.env.APP_DATA_PATH = path.join(testRoot, "app-data");
  delete process.env.WORKSPACE_PATH;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  runMigrations();
});

after(() => {
  closeDb();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

async function rasterPdf(): Promise<ArrayBuffer> {
  const canvas = createCanvas(300, 400);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  context.fillRect(25, 25, 250, 25);
  const pdf = await PDFDocument.create();
  const png = await pdf.embedPng(canvas.toBuffer("image/png"));
  const page = pdf.addPage([216, 288]);
  page.drawImage(png, { x: 0, y: 0, width: 216, height: 288 });
  const bytes = await pdf.save();
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

class FixedOcrEngine implements OcrEngine {
  readonly name = "fixture-local-ocr";
  constructor(private readonly text: string) {}
  async recognize(): Promise<OcrResult> {
    return {
      text: this.text,
      confidence: 0.99,
      regions: [
        {
          text: this.text,
          confidence: 0.99,
          bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
        },
      ],
    };
  }
}

test("scanned PDF indexing feeds search, citation evidence, and full-read fallback", async () => {
  const db = getDb();
  const userId = "ocr-user";
  const projectId = "ocr-project";
  const documentId = "ocr-document";
  const versionId = "ocr-version";
  const storagePath = "documents/ocr-scan.pdf";
  db.prepare("INSERT INTO user_profiles (id, user_id) VALUES (?, ?)").run(
    "ocr-profile",
    userId,
  );
  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, '[]')",
  ).run(projectId, userId, "OCR Project");
  db.prepare(
    `INSERT INTO documents
      (id, project_id, user_id, filename, file_type, status, current_version_id)
     VALUES (?, ?, ?, 'scan.pdf', 'pdf', 'ready', ?)`,
  ).run(documentId, projectId, userId, versionId);
  db.prepare(
    `INSERT INTO document_versions
      (id, document_id, storage_path, source, version_number)
     VALUES (?, ?, ?, 'upload', 1)`,
  ).run(versionId, documentId, storagePath);
  await uploadFile(storagePath, await rasterPdf(), "application/pdf");

  const words = Array.from({ length: 720 }, (_, index) => `word${index}`);
  words[10] = "손해배상";
  await indexDocumentVersion({
    documentId,
    versionId,
    ocrEngine: new FixedOcrEngine(words.join(" ")),
  });

  const status = db
    .prepare(
      "SELECT status, chunk_count, ocr_pages, ocr_engine FROM document_index_files WHERE document_id = ? AND version_id = ?",
    )
    .get(documentId, versionId) as {
    status: string;
    chunk_count: number;
    ocr_pages: number;
    ocr_engine: string;
  };
  assert.equal(status.status, "ready");
  assert.equal(status.chunk_count, 2);
  assert.equal(status.ocr_pages, 1);
  assert.equal(status.ocr_engine, "fixture-local-ocr");

  const storedRegion = db
    .prepare(
      `SELECT page_number, region_index, text, confidence,
              bbox_x, bbox_y, bbox_width, bbox_height
       FROM document_ocr_regions
       WHERE document_id = ? AND version_id = ?`,
    )
    .get(documentId, versionId) as Record<string, unknown>;
  assert.deepEqual(storedRegion, {
    page_number: 1,
    region_index: 0,
    text: words.join(" "),
    confidence: 0.99,
    bbox_x: 0.1,
    bbox_y: 0.1,
    bbox_width: 0.8,
    bbox_height: 0.2,
  });

  const hits = await searchProjectIndex({
    projectId,
    userId,
    query: "손해배상",
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].page_number, 1);

  const evidence = validateCitationEvidence(
    [{ ref: 1, doc_id: "doc-0", page: 99, quote: "손해배상" }],
    {
      "doc-0": {
        document_id: documentId,
        filename: "scan.pdf",
        version_id: versionId,
      },
    },
  );
  assert.equal(evidence.errors.length, 0);
  assert.equal(evidence.citations[0].page, 1);

  const reassembled = reassembleIndexedDocumentText(documentId, versionId);
  assert.match(reassembled, /^\[Page 1\]\n/);
  assert.equal((reassembled.match(/word450/g) ?? []).length, 1);
  assert.match(reassembled, /word719$/);

  const toolRun = await runToolCalls(
    [
      {
        id: "read-ocr",
        function: {
          name: "read_document",
          arguments: JSON.stringify({ doc_id: "doc-0" }),
        },
      },
    ],
    new Map([
      [
        "doc-0",
        { storage_path: storagePath, file_type: "pdf", filename: "scan.pdf" },
      ],
    ]),
    userId,
    createServerSupabase(),
    () => undefined,
    undefined,
    undefined,
    {
      "doc-0": {
        document_id: documentId,
        filename: "scan.pdf",
        version_id: versionId,
      },
    },
  );
  const toolContent = (toolRun.toolResults[0] as { content: string }).content;
  assert.match(toolContent, /^\[Page 1\]\n/);
  assert.equal((toolContent.match(/word450/g) ?? []).length, 1);
  assert.match(toolContent, /word719$/);

  db.prepare(
    `INSERT INTO document_index_chunks
      (id, document_id, version_id, chunk_index, page_number, content, start_char, end_char, token_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("boundary-start", documentId, versionId, 100, 2, "before boundary overlap", 0, 23, 3);
  db.prepare(
    `INSERT INTO document_index_chunks
      (id, document_id, version_id, chunk_index, page_number, content, start_char, end_char, token_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("boundary-end", documentId, versionId, 101, 2, "overlap phrase after", 16, 36, 3);

  const spanningContext = extractAnnotationContext({
    quote: "boundary overlap phrase",
    page: 2,
    radius: 20,
    chunks: [
      {
        chunk_id: "boundary-start",
        chunk_index: 100,
        page_number: 2,
        content: "before boundary overlap",
        start_char: 0,
        end_char: 23,
      },
      {
        chunk_id: "boundary-end",
        chunk_index: 101,
        page_number: 2,
        content: "overlap phrase after",
        start_char: 16,
        end_char: 36,
      },
    ],
  });
  assert.equal(spanningContext.located, true);
  assert.equal(spanningContext.chunk_id, "boundary-start");
  assert.equal(
    "before boundary overlap".includes(spanningContext.indexed_quote ?? ""),
    true,
  );
  const indexedQuoteEvidence = validateCitationEvidence(
    [{
      ref: 1,
      doc_id: "doc-0",
      page: 2,
      quote: spanningContext.indexed_quote ?? "",
      chunk_id: spanningContext.chunk_id,
    }],
    {
      "doc-0": {
        document_id: documentId,
        filename: "scan.pdf",
        version_id: versionId,
      },
    },
  );
  assert.deepEqual(indexedQuoteEvidence.errors, []);
  assert.equal(indexedQuoteEvidence.citations.length, 1);

  const spanningEvidence = validateCitationEvidence(
    [{
      ref: 1,
      doc_id: "doc-0",
      page: 2,
      quote: "boundary overlap phrase",
      chunk_id: "boundary-start",
    }],
    {
      "doc-0": {
        document_id: documentId,
        filename: "scan.pdf",
        version_id: versionId,
      },
    },
  );
  assert.deepEqual(spanningEvidence.errors, []);
  assert.equal(spanningEvidence.citations[0].chunk_id, "boundary-start");
  assert.equal(spanningEvidence.citations[0].page, 2);
  assert.equal(spanningEvidence.citations[0].quote_start, undefined);
  assert.equal(spanningEvidence.citations[0].quote_end, undefined);

  const wrongChunkEvidence = validateCitationEvidence(
    [{
      ref: 1,
      doc_id: "doc-0",
      page: 2,
      quote: "boundary overlap phrase",
      chunk_id: "boundary-end",
    }],
    {
      "doc-0": {
        document_id: documentId,
        filename: "scan.pdf",
        version_id: versionId,
      },
    },
  );
  assert.deepEqual(wrongChunkEvidence.citations, []);
  assert.deepEqual(wrongChunkEvidence.errors, [{ code: "quote_not_found", ref: 1 }]);

  const wrongSpanEvidence = validateCitationEvidence(
    [{
      ref: 1,
      doc_id: "doc-0",
      page: 2,
      quote: "before",
      chunk_id: "boundary-start",
      quote_start: 7,
      quote_end: 13,
    }],
    {
      "doc-0": {
        document_id: documentId,
        filename: "scan.pdf",
        version_id: versionId,
      },
    },
  );
  assert.deepEqual(wrongSpanEvidence.citations, []);
  assert.deepEqual(wrongSpanEvidence.errors, [{ code: "quote_not_found", ref: 1 }]);

  const missingEvidence = validateCitationEvidence(
    [{ ref: 1, doc_id: "doc-0", page: 2, quote: "not present in any indexed chunk" }],
    {
      "doc-0": {
        document_id: documentId,
        filename: "scan.pdf",
        version_id: versionId,
      },
    },
  );
  assert.deepEqual(missingEvidence.citations, []);
  assert.deepEqual(missingEvidence.errors, [{ code: "quote_not_found", ref: 1 }]);
});
