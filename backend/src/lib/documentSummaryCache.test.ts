import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrationsForDb } from "../db/migrate";
import type { ValidatedBatchSummary } from "./documentSummary";
import { createSqliteDocumentSummaryBatchCache } from "./documentSummaryCache";

test("SQLite summary cache round-trips citation evidence and invalidates revisions", async () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    runMigrationsForDb(db);
    db.prepare(
      "INSERT INTO documents (id, user_id, filename) VALUES (?, ?, ?)",
    ).run("document-1", "user-1", "record.pdf");
    db.prepare(
      `INSERT INTO document_versions
       (id, document_id, storage_path, version_number, content_revision)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("version-1", "document-1", "record.pdf", 1, 7);

    const summary: ValidatedBatchSummary = {
      batchId: "batch-1",
      points: [
        {
          text: "The court granted relief.",
          evidenceIds: ["batch-1-point-1-evidence-1"],
        },
      ],
      evidence: [
        {
          id: "batch-1-point-1-evidence-1",
          sourceBatchId: "batch-1",
          claim: "The court granted relief.",
          chunk: {
            chunk_id: "chunk-9",
            chunk_index: 8,
            page_number: 12,
            page_end: 13,
            content: "Before the court granted relief after argument.",
            start_char: 900,
            end_char: 949,
          },
          quote: "the court granted relief",
          quoteStart: 7,
          quoteEnd: 31,
        },
      ],
    };
    const cache = createSqliteDocumentSummaryBatchCache({
      db,
      documentId: "document-1",
      versionId: "version-1",
      model: "ollama:gemma-12b",
    });

    await cache.set("stable-batch-key", summary);
    const loaded = await cache.get("stable-batch-key");
    assert.deepEqual(loaded, summary);
    assert.equal(loaded?.evidence[0].chunk.chunk_id, "chunk-9");
    assert.equal(loaded?.evidence[0].chunk.page_end, 13);
    assert.equal(loaded?.evidence[0].quoteStart, 7);
    assert.equal(
      (loaded?.evidence[0].chunk.start_char ?? 0) +
        (loaded?.evidence[0].quoteStart ?? 0),
      907,
    );

    db.prepare(
      "UPDATE document_versions SET content_revision = 8 WHERE id = ?",
    ).run("version-1");
    assert.equal(await cache.get("stable-batch-key"), null);
    await cache.set("stable-batch-key", summary);
    assert.deepEqual(await cache.get("stable-batch-key"), summary);
    const row = db
      .prepare(
        "SELECT model, content_revision FROM document_summary_batches WHERE batch_key = ?",
      )
      .get("stable-batch-key") as {
      model: string;
      content_revision: number;
    };
    assert.deepEqual(row, {
      model: "ollama:gemma-12b",
      content_revision: 8,
    });
  } finally {
    db.close();
  }
});
