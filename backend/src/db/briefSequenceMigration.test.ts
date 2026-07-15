import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrationsForDb } from "./migrate";

test("brief sequence migration is idempotent and enforces positive integers", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    runMigrationsForDb(db);
    runMigrationsForDb(db);

    const column = (
      db.prepare("PRAGMA table_info(documents)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find(({ name }) => name === "brief_sequence");
    assert.equal(column?.name, "brief_sequence");
    assert.equal(column?.notnull, 0);

    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_documents_project_party_side_brief_sequence") as
      | { name?: string }
      | undefined;
    assert.equal(
      index?.name,
      "idx_documents_project_party_side_brief_sequence",
    );
    const indexColumns = db
      .prepare(
        "PRAGMA index_info(idx_documents_project_party_side_brief_sequence)",
      )
      .all() as { name: string }[];
    assert.deepEqual(
      indexColumns.map(({ name }) => name),
      ["project_id", "party_side", "brief_sequence"],
    );

    db.prepare("INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)").run(
      "project-1",
      "user-1",
      "Matter",
    );
    const insert = db.prepare(
      `INSERT INTO documents
       (id, project_id, user_id, filename, brief_sequence)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("doc-null", "project-1", "user-1", "Unordered.pdf", null);
    insert.run("doc-one", "project-1", "user-1", "First Brief.pdf", 1);
    assert.throws(
      () => insert.run("doc-zero", "project-1", "user-1", "Zero.pdf", 0),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run("doc-float", "project-1", "user-1", "Float.pdf", 1.5),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});
