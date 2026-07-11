import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { closeDb, getDb } from "../../db/sqlite";
import { runMigrations } from "../../db/migrate";
import {
  BASELINE_INDEX_SCHEMA_VERSION,
  bumpDocumentVersionContentRevision,
  cancelProjectIndexing,
  deterministicChunkId,
  drainIndexQueueForTests,
  enqueueDocumentIndex,
  ensureProjectBaselineCurrent,
  getProjectIndexStatus,
  listProjectBaselineIndexWork,
} from "./indexer";

let testRoot = "";

before(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docket-b0-indexer-test-"));
  process.env.APP_DATA_PATH = path.join(testRoot, "app-data");
  delete process.env.WORKSPACE_PATH;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  runMigrations();
});

after(() => {
  closeDb();
  if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
});

test("deterministic chunk ids are stable for an identical document version", () => {
  const source = {
    documentId: "document-a",
    versionId: "version-a",
    chunkIndex: 4,
    content: "Exact evidence used by a citation.",
  };
  assert.equal(deterministicChunkId(source), deterministicChunkId(source));
  assert.notEqual(
    deterministicChunkId(source),
    deterministicChunkId({ ...source, content: "Changed evidence." }),
  );
});

function insertDocument(args: {
  projectId: string;
  documentId: string;
  versionId: string;
  filename: string;
  contentRevision?: number;
  index?: {
    status: "pending" | "indexing" | "ready" | "error" | "cancelled";
    indexedContentRevision?: number;
    indexSchemaVersion?: number;
  };
}): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, 'pdf', 'ready', ?)",
  ).run(
    args.documentId,
    args.projectId,
    "owner",
    args.filename,
    args.versionId,
  );
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number, content_revision) VALUES (?, ?, ?, 'upload', 1, ?)",
  ).run(
    args.versionId,
    args.documentId,
    `${args.documentId}.pdf`,
    args.contentRevision ?? 1,
  );
  if (!args.index) return;
  db.prepare(
    `INSERT INTO document_index_files (
       id, document_id, version_id, status, indexed_content_revision,
       index_schema_version
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `index-${args.documentId}`,
    args.documentId,
    args.versionId,
    args.index.status,
    args.index.indexedContentRevision ?? 0,
    args.index.indexSchemaVersion ?? 0,
  );
}

test("baseline revision migration adds version and index identity columns", () => {
  const db = getDb();
  const versionColumns = db
    .prepare("PRAGMA table_info(document_versions)")
    .all() as { name: string }[];
  const indexColumns = db
    .prepare("PRAGMA table_info(document_index_files)")
    .all() as { name: string }[];
  assert.ok(
    versionColumns.some((column) => column.name === "content_revision"),
  );
  assert.ok(
    indexColumns.some((column) => column.name === "indexed_content_revision"),
  );
  assert.ok(
    indexColumns.some((column) => column.name === "index_schema_version"),
  );
  assert.ok(indexColumns.some((column) => column.name === "ocr_pages"));
  assert.ok(indexColumns.some((column) => column.name === "ocr_engine"));
  const regionColumns = getDb()
    .prepare("PRAGMA table_info(document_ocr_regions)")
    .all() as { name: string }[];
  assert.deepEqual(
    regionColumns.map((column) => column.name),
    [
      "document_id",
      "version_id",
      "page_number",
      "region_index",
      "text",
      "confidence",
      "bbox_x",
      "bbox_y",
      "bbox_width",
      "bbox_height",
    ],
  );
});

test("baseline reconciliation selects only missing interrupted and stale current indexes", () => {
  const db = getDb();
  const projectId = "project-b0-work";
  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, 'owner', 'B0', '[]')",
  ).run(projectId);

  insertDocument({
    projectId,
    documentId: "doc-current",
    versionId: "version-current",
    filename: "current.pdf",
    index: {
      status: "ready",
      indexedContentRevision: 1,
      indexSchemaVersion: BASELINE_INDEX_SCHEMA_VERSION,
    },
  });
  insertDocument({
    projectId,
    documentId: "doc-missing",
    versionId: "version-missing",
    filename: "missing.pdf",
  });
  insertDocument({
    projectId,
    documentId: "doc-pending",
    versionId: "version-pending",
    filename: "pending.pdf",
    index: { status: "pending" },
  });
  insertDocument({
    projectId,
    documentId: "doc-indexing",
    versionId: "version-indexing",
    filename: "indexing.pdf",
    index: { status: "indexing" },
  });
  insertDocument({
    projectId,
    documentId: "doc-stale-revision",
    versionId: "version-stale-revision",
    filename: "stale-revision.pdf",
    contentRevision: 2,
    index: {
      status: "ready",
      indexedContentRevision: 1,
      indexSchemaVersion: BASELINE_INDEX_SCHEMA_VERSION,
    },
  });
  insertDocument({
    projectId,
    documentId: "doc-stale-schema",
    versionId: "version-stale-schema",
    filename: "stale-schema.pdf",
    index: {
      status: "ready",
      indexedContentRevision: 1,
      indexSchemaVersion: BASELINE_INDEX_SCHEMA_VERSION - 1,
    },
  });
  insertDocument({
    projectId,
    documentId: "doc-error",
    versionId: "version-error",
    filename: "error.pdf",
    index: { status: "error" },
  });
  insertDocument({
    projectId,
    documentId: "doc-cancelled",
    versionId: "version-cancelled",
    filename: "cancelled.pdf",
    index: { status: "cancelled" },
  });

  assert.deepEqual(
    listProjectBaselineIndexWork(projectId).map((item) => [
      item.documentId,
      item.reason,
    ]),
    [
      ["doc-missing", "missing"],
      ["doc-pending", "interrupted"],
      ["doc-indexing", "interrupted"],
      ["doc-stale-revision", "stale-content"],
      ["doc-stale-schema", "stale-schema"],
    ],
  );
});

test("same-version byte mutations advance a monotonic content revision", () => {
  const db = getDb();
  const projectId = "project-b0-revision";
  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, 'owner', 'Revision', '[]')",
  ).run(projectId);
  insertDocument({
    projectId,
    documentId: "doc-revision",
    versionId: "version-revision",
    filename: "revision.docx",
    contentRevision: 4,
  });

  assert.equal(
    bumpDocumentVersionContentRevision("doc-revision", "version-revision"),
    5,
  );
  const row = db
    .prepare("SELECT content_revision FROM document_versions WHERE id = ?")
    .get("version-revision") as { content_revision: number };
  assert.equal(row.content_revision, 5);
});

test("overlapping baseline ensures enqueue one explicit current-version job", () => {
  const db = getDb();
  const projectId = "project-b0-dedupe";
  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, 'owner', 'Dedupe', '[]')",
  ).run(projectId);
  insertDocument({
    projectId,
    documentId: "doc-dedupe",
    versionId: "version-dedupe",
    filename: "dedupe.pdf",
  });

  assert.equal(ensureProjectBaselineCurrent(projectId), 1);
  assert.equal(ensureProjectBaselineCurrent(projectId), 0);
  assert.equal(getProjectIndexStatus(projectId).queued_jobs, 1);
  assert.equal(cancelProjectIndexing(projectId), 1);
});

test("failed refresh keeps a prior complete raw generation searchable", async () => {
  const db = getDb();
  const projectId = "project-b0-last-ready";
  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, 'owner', 'Last ready', '[]')",
  ).run(projectId);
  insertDocument({
    projectId,
    documentId: "doc-last-ready",
    versionId: "version-last-ready",
    filename: "last-ready.pdf",
    index: { status: "ready" },
  });
  db.prepare(
    `INSERT INTO document_index_chunks (
       id, document_id, version_id, chunk_index, content, start_char,
       end_char, token_count
     ) VALUES ('chunk-last-ready', 'doc-last-ready', 'version-last-ready', 0,
       'Existing source evidence', 0, 24, 3)`,
  ).run();

  assert.equal(
    enqueueDocumentIndex("doc-last-ready", "version-last-ready"),
    true,
  );
  await drainIndexQueueForTests();

  const row = db
    .prepare(
      "SELECT status, error_message FROM document_index_files WHERE document_id = ? AND version_id = ?",
    )
    .get("doc-last-ready", "version-last-ready") as {
    status: string;
    error_message: string | null;
  };
  assert.equal(row.status, "ready");
  assert.match(row.error_message ?? "", /not available/i);
});
