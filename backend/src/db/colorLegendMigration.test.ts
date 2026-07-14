import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrationsForDb } from "./migrate";

test("color legend migration creates constraints and is idempotent", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    runMigrationsForDb(db);
    runMigrationsForDb(db);

    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("project_color_legend") as { name?: string } | undefined;
    assert.equal(table?.name, "project_color_legend");

    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_project_color_legend_project") as { name?: string } | undefined;
    assert.equal(index?.name, "idx_project_color_legend_project");

    db.prepare("INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)").run(
      "project-1",
      "user-1",
      "Matter",
    );
    const insert = db.prepare(
      "INSERT INTO project_color_legend (id, project_id, color_family, label) VALUES (?, ?, ?, ?)",
    );
    insert.run("legend-1", "project-1", "green", "undisputed");
    assert.throws(
      () => insert.run("legend-2", "project-1", "teal", "invalid"),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insert.run("legend-3", "project-1", "green", "duplicate"),
      /UNIQUE constraint failed/,
    );
  } finally {
    db.close();
  }
});
