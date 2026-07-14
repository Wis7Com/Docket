import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getDb } from "../../db/sqlite";
import { runMigrations } from "../../db/migrate";
import { getProjectIndexStatus } from "./indexer";
import { listProjectPartialOcr } from "./search";

let root = "";

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "docket-ocr-scale-"));
  process.env.APP_DATA_PATH = path.join(root, "app-data");
  delete process.env.WORKSPACE_PATH;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  runMigrations();
});

after(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("partial OCR coverage is persisted, listed, and aggregated", () => {
  const db = getDb();
  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with, ocr_max_pages_override) VALUES ('p', 'u', 'P', '[]', 0)",
  ).run();
  db.prepare(
    `INSERT INTO documents
      (id, project_id, user_id, filename, file_type, status, current_version_id)
     VALUES ('d', 'p', 'u', 'scan.pdf', 'pdf', 'ready', 'v')`,
  ).run();
  db.prepare(
    `INSERT INTO document_versions
      (id, document_id, storage_path, source, version_number)
     VALUES ('v', 'd', 'scan.pdf', 'upload', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO document_index_files
      (id, document_id, version_id, status, ocr_pages, ocr_scanned_pages,
       ocr_truncated)
     VALUES ('f', 'd', 'v', 'ready', 2, 9, 1)`,
  ).run();

  assert.deepEqual(listProjectPartialOcr("p"), [
    {
      document_id: "d",
      version_id: "v",
      filename: "scan.pdf",
      file_type: "pdf",
      ocr_pages: 2,
      ocr_scanned_pages: 9,
    },
  ]);
  const status = getProjectIndexStatus("p");
  assert.equal(status.ocr_pages, 2);
  assert.equal(status.ocr_scanned_pages, 9);
  assert.equal(status.ocr_truncated_documents, 1);
});
