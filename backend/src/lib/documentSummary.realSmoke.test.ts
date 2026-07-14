import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";
import {
  summarizeDocumentWithCoverage,
  type DocumentSummaryChunk,
} from "./documentSummary";
import { completeText, type UserApiKeys } from "./llm";

const enabled = process.env.RUN_LIVE_DOCUMENT_SUMMARY === "1";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function profileKeys(): UserApiKeys {
  const profileDbPath = process.env.DOCKET_LIVE_PROFILE_DB?.trim();
  if (!profileDbPath) return {};
  assert.ok(
    fs.existsSync(profileDbPath),
    `missing profile DB: ${profileDbPath}`,
  );
  const db = new Database(profileDbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = db
      .prepare(
        `SELECT gemini_api_key, openrouter_api_key
         FROM user_profiles
         WHERE user_id = ?
         LIMIT 1`,
      )
      .get(process.env.DOCKET_LIVE_USER_ID?.trim() || "local-user") as
      | {
          gemini_api_key: string | null;
          openrouter_api_key: string | null;
        }
      | undefined;
    return {
      gemini: row?.gemini_api_key ?? null,
      openrouter: row?.openrouter_api_key ?? null,
    };
  } finally {
    db.close();
  }
}

test(
  "live indexed long-document summary covers and cites the real document",
  { skip: !enabled, timeout: 3_600_000 },
  async (t) => {
    const projectDbPath = requiredEnvironment("DOCKET_LIVE_PROJECT_DB");
    const documentId = requiredEnvironment("DOCKET_LIVE_DOCUMENT_ID");
    const versionId = requiredEnvironment("DOCKET_LIVE_VERSION_ID");
    const model =
      process.env.DOCKET_LIVE_SUMMARY_MODEL?.trim() || "ollama:gemma4:12b-mlx";
    assert.ok(
      fs.existsSync(projectDbPath),
      `missing project DB: ${projectDbPath}`,
    );

    const db = new Database(projectDbPath, {
      readonly: true,
      fileMustExist: true,
    });
    let chunks: DocumentSummaryChunk[];
    let metadata:
      | {
          filename: string;
          page_count: number | null;
          ocr_pages: number | null;
          ocr_scanned_pages: number | null;
          ocr_truncated: number | null;
        }
      | undefined;
    try {
      chunks = db
        .prepare(
          `SELECT id AS chunk_id, chunk_index, page_number, content,
                  start_char, end_char
           FROM document_index_chunks
           WHERE document_id = ? AND version_id = ?
           ORDER BY chunk_index ASC`,
        )
        .all(documentId, versionId) as DocumentSummaryChunk[];
      metadata = db
        .prepare(
          `SELECT d.filename, d.page_count, f.ocr_pages,
                  f.ocr_scanned_pages, f.ocr_truncated
           FROM documents d
           LEFT JOIN document_index_files f
             ON f.document_id = d.id AND f.version_id = ?
           WHERE d.id = ?`,
        )
        .get(versionId, documentId) as typeof metadata;
    } finally {
      db.close();
    }
    assert.ok(metadata, "document metadata was not found");
    assert.ok(chunks.length > 0, "document has no indexed chunks");
    const chunkOffset = Math.max(
      0,
      Math.floor(Number(process.env.DOCKET_LIVE_CHUNK_OFFSET?.trim() || 0)),
    );
    if (chunkOffset > 0) chunks = chunks.slice(chunkOffset);
    const chunkLimit = Number(
      process.env.DOCKET_LIVE_CHUNK_LIMIT?.trim() || chunks.length,
    );
    const isLimited =
      chunkOffset > 0 ||
      (Number.isFinite(chunkLimit) && chunkLimit < chunks.length);
    if (isLimited) {
      chunks = chunks.slice(0, Math.max(1, Math.floor(chunkLimit)));
    }
    const pageCount = isLimited
      ? chunks.reduce((max, chunk) => Math.max(max, chunk.page_number ?? 0), 0)
      : (metadata.page_count ??
        chunks.reduce(
          (max, chunk) => Math.max(max, chunk.page_number ?? 0),
          0,
        ));
    const expectedPages = Number(
      process.env.DOCKET_LIVE_EXPECTED_PAGES?.trim() || pageCount,
    );
    assert.equal(pageCount, expectedPages);

    const started = Date.now();
    const result = await summarizeDocumentWithCoverage(
      {
        model,
        apiKeys: profileKeys(),
        filename: metadata.filename,
        docId: "doc-0",
        documentId,
        versionId,
        chunks,
        pageCount,
        language: "Korean",
        maxStageAttempts: process.env.DOCKET_LIVE_STAGE_ATTEMPTS
          ? Number(process.env.DOCKET_LIVE_STAGE_ATTEMPTS)
          : undefined,
        focus:
          "문서 전체의 구조와 각 장·판례의 쟁점, 결론, 논거, 예외 및 비교법적 함의를 빠짐없이 요약",
        ocrStatus: {
          truncated: Boolean(metadata.ocr_truncated),
          ocrPages: metadata.ocr_pages ?? undefined,
          scannedPages: metadata.ocr_scanned_pages ?? undefined,
        },
        onProgress: ({ completedBatches, totalBatches, pageRange }) => {
          t.diagnostic(
            `map ${completedBatches}/${totalBatches}, pages ${pageRange?.start ?? "?"}-${pageRange?.end ?? "?"}`,
          );
        },
      },
      process.env.DOCKET_LIVE_DEBUG_RESPONSES === "1"
        ? {
            complete: async (params) => {
              const raw = await completeText(params);
              process.stderr.write(
                `[live-summary/raw] ${raw.slice(0, 2_000)}\n`,
              );
              t.diagnostic(`raw completion: ${raw.slice(0, 2_000)}`);
              return raw;
            },
          }
        : undefined,
    );
    const elapsed = Date.now() - started;

    assert.equal(result.coverage.processedChunkCount, chunks.length);
    assert.equal(result.coverage.indexedChunkCount, chunks.length);
    assert.ok(result.citations.length >= result.coverage.batchCount);
    assert.match(result.preparedText, /[가-힣]/);
    assert.ok(
      result.preparedText.split("\n").filter((line) => line.startsWith("- "))
        .length >= result.coverage.batchCount,
    );
    const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
    for (const citation of result.citations) {
      const chunk = chunkById.get(citation.chunk_id);
      assert.ok(
        chunk,
        `citation references unknown chunk ${citation.chunk_id}`,
      );
      assert.equal(
        chunk.content.slice(citation.quote_start, citation.quote_end),
        citation.quote,
      );
    }
    t.diagnostic(
      JSON.stringify({
        model,
        elapsed_ms: elapsed,
        pages: pageCount,
        chunks: chunks.length,
        batches: result.coverage.batchCount,
        citations: result.citations.length,
        index_coverage_complete: result.coverage.complete,
        warnings: result.coverage.warnings.map((warning) => warning.code),
      }),
    );
    t.diagnostic(
      result.preparedText
        .replace(/<CITATIONS>[\s\S]*<\/CITATIONS>/, "")
        .slice(0, 4_000),
    );
  },
);
