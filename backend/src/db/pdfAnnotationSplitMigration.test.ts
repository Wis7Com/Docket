import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { runMigrationsForDb } from "./migrate";

type AnnotationRow = {
  id: string;
  annotation_type: "highlight" | "comment";
  quote: string | null;
  comment: string | null;
  color: string;
  rects_json: string;
  source: string;
  source_citation_json: string | null;
  deleted_at: string | null;
};

function seedDocument(db: Database.Database) {
  db.prepare(
    "INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)",
  ).run("project-1", "user-1", "Matter");
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, current_version_id) VALUES (?, ?, ?, ?, ?)",
  ).run("doc-1", "project-1", "user-1", "brief.pdf", "version-1");
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, version_number) VALUES (?, ?, ?, ?)",
  ).run("version-1", "doc-1", "brief.pdf", 1);
}

function insertAnnotation(
  db: Database.Database,
  overrides: Partial<AnnotationRow> & { id: string },
) {
  db.prepare(
    `INSERT INTO pdf_annotations (
      id, document_id, version_id, user_id, page_number, annotation_type,
      color, quote, comment, rects_json, source, source_citation_json, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id,
    "doc-1",
    "version-1",
    "user-1",
    2,
    overrides.annotation_type ?? "highlight",
    overrides.color ?? "#ffe066",
    overrides.quote ?? "Quoted text",
    overrides.comment ?? null,
    overrides.rects_json ?? '[{"x":1,"y":2,"width":3,"height":4}]',
    overrides.source ?? "citation_promotion",
    overrides.source_citation_json ?? '{"chunk_id":"chunk-1"}',
    overrides.deleted_at ?? null,
  );
}

function annotationRows(db: Database.Database): AnnotationRow[] {
  return db
    .prepare(
      `SELECT id, annotation_type, quote, comment, color, rects_json, source,
              source_citation_json, deleted_at
       FROM pdf_annotations
       ORDER BY id`,
    )
    .all() as AnnotationRow[];
}

test("pdf annotation migration splits highlight comments into independent comment rows", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    runMigrationsForDb(db);
    seedDocument(db);
    insertAnnotation(db, {
      id: "highlight-active",
      comment: "User note",
      color: "#ff8787",
    });
    insertAnnotation(db, {
      id: "highlight-empty",
      comment: "   ",
    });
    insertAnnotation(db, {
      id: "highlight-deleted",
      comment: "Deleted note",
      deleted_at: "2026-07-17T00:00:00Z",
    });
    insertAnnotation(db, {
      id: "comment-existing",
      annotation_type: "comment",
      comment: "Already separate",
      source: "user",
      source_citation_json: null,
    });

    const migration = fs.readFileSync(
      path.resolve(
        __dirname,
        "..",
        "..",
        "migrations",
        "024_split_highlight_comments.sqlite.sql",
      ),
      "utf8",
    );
    db.exec(migration);
    db.exec(migration);

    const rows = annotationRows(db);
    assert.deepEqual(
      rows.map((row) => row.id),
      [
        "comment-existing",
        "highlight-active",
        "highlight-deleted",
        "highlight-empty",
        "split-comment-highlight-active",
      ],
    );

    const source = rows.find((row) => row.id === "highlight-active");
    assert.equal(source?.annotation_type, "highlight");
    assert.equal(source?.comment, null);
    assert.equal(source?.source, "citation_promotion");
    assert.equal(source?.source_citation_json, '{"chunk_id":"chunk-1"}');

    const split = rows.find(
      (row) => row.id === "split-comment-highlight-active",
    );
    assert.equal(split?.annotation_type, "comment");
    assert.equal(split?.quote, "Quoted text");
    assert.equal(split?.comment, "User note");
    assert.equal(split?.color, "#ff8787");
    assert.equal(split?.rects_json, '[{"x":1,"y":2,"width":3,"height":4}]');
    assert.equal(split?.source, "user");
    assert.equal(split?.source_citation_json, null);

    assert.equal(
      rows.find((row) => row.id === "highlight-empty")?.comment,
      "   ",
    );
    assert.equal(
      rows.find((row) => row.id === "highlight-deleted")?.comment,
      "Deleted note",
    );
  } finally {
    db.close();
  }
});
