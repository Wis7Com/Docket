import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrationsForDb } from "./migrate";

test("document summary batch migration creates columns and a unique batch key", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    runMigrationsForDb(db);
    runMigrationsForDb(db);

    const columns = db
      .prepare("PRAGMA table_info(document_summary_batches)")
      .all() as { name: string }[];
    assert.deepEqual(
      columns.map(({ name }) => name),
      [
        "document_id",
        "version_id",
        "batch_key",
        "summary_json",
        "model",
        "content_revision",
        "created_at",
      ],
    );

    const indexes = db
      .prepare("PRAGMA index_list(document_summary_batches)")
      .all() as { name: string; unique: number }[];
    const unique = indexes.find((index) => index.unique === 1);
    assert.ok(unique);
    const uniqueColumns = db
      .prepare(`PRAGMA index_info(${JSON.stringify(unique.name)})`)
      .all() as { name: string }[];
    assert.deepEqual(
      uniqueColumns.map(({ name }) => name),
      ["document_id", "version_id", "batch_key"],
    );
  } finally {
    db.close();
  }
});
