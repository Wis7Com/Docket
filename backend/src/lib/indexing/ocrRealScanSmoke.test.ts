/**
 * Opt-in real OCR smoke test.
 *
 * Run from backend/ with:
 * DOCKET_OCR_REAL_SCAN_SMOKE=1 \
 * DOCKET_OCR_SMOKE_PDF=/abs/path/scan.pdf \
 * node --import tsx --test src/lib/indexing/ocrRealScanSmoke.test.ts
 *
 * The fixture should be a low-quality Korean/English scanned PDF containing
 * the Korean query in DOCKET_OCR_SMOKE_QUERY (defaults to "손해배상").
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getDb } from "../../db/sqlite";
import { runMigrations } from "../../db/migrate";
import { validateCitationEvidence } from "../chatTools";
import { createLocalOcrEngine } from "../ocr";
import { uploadFile } from "../storage";
import { getUserOcrSettings } from "../userSettings";
import { indexDocumentVersion } from "./indexer";
import { listProjectPartialOcr, searchProjectIndex } from "./search";

const fixturePath = process.env.DOCKET_OCR_SMOKE_PDF;
const enabled = process.env.DOCKET_OCR_REAL_SCAN_SMOKE === "1" && Boolean(fixturePath);
let root = "";

before(() => {
  if (!enabled) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "docket-real-ocr-smoke-"));
  process.env.APP_DATA_PATH = path.join(root, "app-data");
  delete process.env.WORKSPACE_PATH;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  runMigrations();
});

after(() => {
  if (!enabled) return;
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  "a real scanned PDF is searchable and produces source-backed OCR citations",
  { skip: !enabled },
  async () => {
    assert.ok(fixturePath);
    assert.ok(fs.existsSync(fixturePath), `OCR smoke fixture not found: ${fixturePath}`);

    const db = getDb();
    const userId = "real-ocr-smoke-user";
    const projectId = "real-ocr-smoke-project";
    const documentId = "real-ocr-smoke-document";
    const versionId = "real-ocr-smoke-version";
    const storagePath = "documents/real-ocr-smoke.pdf";
    const maxPages = Math.max(
      1,
      Number.parseInt(process.env.DOCKET_OCR_SMOKE_MAX_PAGES ?? "2", 10) || 2,
    );

    db.prepare("INSERT INTO user_profiles (id, user_id) VALUES (?, ?)").run(
      "real-ocr-smoke-profile",
      userId,
    );
    db.prepare(
      `INSERT INTO projects
        (id, user_id, name, shared_with, ocr_max_pages_override)
       VALUES (?, ?, ?, '[]', ?)`,
    ).run(projectId, userId, "Real OCR Smoke", maxPages);
    db.prepare(
      `INSERT INTO documents
        (id, project_id, user_id, filename, file_type, status, current_version_id)
       VALUES (?, ?, ?, ?, 'pdf', 'ready', ?)`,
    ).run(documentId, projectId, userId, path.basename(fixturePath), versionId);
    db.prepare(
      `INSERT INTO document_versions
        (id, document_id, storage_path, source, version_number)
       VALUES (?, ?, ?, 'upload', 1)`,
    ).run(versionId, documentId, storagePath);

    const fixture = fs.readFileSync(fixturePath);
    await uploadFile(
      storagePath,
      fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength),
      "application/pdf",
    );

    const ocrEngine = createLocalOcrEngine(await getUserOcrSettings(userId));
    await indexDocumentVersion({ documentId, versionId, ocrEngine });

    const coverage = db
      .prepare(
        `SELECT ocr_pages, ocr_scanned_pages, ocr_truncated
         FROM document_index_files
         WHERE document_id = ? AND version_id = ?`,
      )
      .get(documentId, versionId) as {
      ocr_pages: number;
      ocr_scanned_pages: number;
      ocr_truncated: number;
    };
    assert.ok(coverage.ocr_pages > 0);

    const query = process.env.DOCKET_OCR_SMOKE_QUERY ?? "손해배상";
    const hits = await searchProjectIndex({ projectId, userId, query });
    assert.ok(hits.length > 0, `No OCR search hit for query: ${query}`);
    const quote = hits[0].content.slice(0, 160).trim();
    assert.ok(quote.length > 0);
    const evidence = validateCitationEvidence(
      [{ ref: 1, doc_id: "doc-0", page: hits[0].page_number ?? 1, quote }],
      {
        "doc-0": {
          document_id: documentId,
          filename: path.basename(fixturePath),
          version_id: versionId,
        },
      },
    );
    assert.equal(evidence.errors.length, 0);

    if (coverage.ocr_scanned_pages > maxPages) {
      assert.equal(coverage.ocr_truncated, 1);
      assert.ok(
        listProjectPartialOcr(projectId).some(
          (document) => document.document_id === documentId,
        ),
      );
    }
  },
);
