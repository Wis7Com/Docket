import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getDb } from "../../db/sqlite";
import { runMigrations } from "../../db/migrate";
import { searchProjectIndex } from "./search";

let testRoot = "";
const projectId = "role-filter-project";

before(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docket-role-filter-"));
  process.env.APP_DATA_PATH = path.join(testRoot, "app-data");
  process.env.DOCKET_EMBEDDING_ENABLED = "0";
  delete process.env.WORKSPACE_PATH;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  runMigrations();
  getDb()
    .prepare(
      "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, 'owner', ?, '[]')",
    )
    .run(projectId, projectId);
});

after(() => {
  closeDb();
  delete process.env.DOCKET_EMBEDDING_ENABLED;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function insertIndexedDocument(args: {
  id: string;
  role: "brief" | "evidence";
  partyRole: string;
  partySide: "A" | "B";
}): void {
  const db = getDb();
  const versionId = `version-${args.id}`;
  const chunkId = `chunk-${args.id}`;
  const content = `common merits argument ${args.id}`;
  db.prepare(
    `INSERT INTO documents
      (id, project_id, user_id, filename, file_type, status,
       current_version_id, doc_role, party_role, party_side)
     VALUES (?, ?, 'owner', ?, 'pdf', 'ready', ?, ?, ?, ?)`,
  ).run(
    args.id,
    projectId,
    `${args.id}.pdf`,
    versionId,
    args.role,
    args.partyRole,
    args.partySide,
  );
  db.prepare(
    `INSERT INTO document_versions
      (id, document_id, storage_path, source, version_number)
     VALUES (?, ?, ?, 'upload', 1)`,
  ).run(versionId, args.id, `${args.id}.pdf`);
  db.prepare(
    `INSERT INTO document_index_files
      (id, document_id, version_id, status, chunk_count, text_bytes)
     VALUES (?, ?, ?, 'ready', 1, ?)`,
  ).run(`index-${args.id}`, args.id, versionId, content.length);
  db.prepare(
    `INSERT INTO document_index_chunks
      (id, document_id, version_id, chunk_index, page_number, content,
       start_char, end_char, token_count)
     VALUES (?, ?, ?, 0, 1, ?, 0, ?, 4)`,
  ).run(chunkId, args.id, versionId, content, content.length);
  for (const table of [
    "document_index_chunks_fts",
    "document_index_chunks_fts_trigram",
  ]) {
    db.prepare(
      `INSERT INTO ${table} (chunk_id, document_id, version_id, content)
       VALUES (?, ?, ?, ?)`,
    ).run(chunkId, args.id, versionId, content);
  }
}

test("role, actual party role, and stable party-side filters compose", async () => {
  insertIndexedDocument({
    id: "brief-plaintiff",
    role: "brief",
    partyRole: "원고",
    partySide: "A",
  });
  insertIndexedDocument({
    id: "brief-defendant",
    role: "brief",
    partyRole: "피고",
    partySide: "B",
  });
  insertIndexedDocument({
    id: "brief-appellant",
    role: "brief",
    partyRole: "항소인",
    partySide: "B",
  });
  insertIndexedDocument({
    id: "evidence-plaintiff",
    role: "evidence",
    partyRole: "원고",
    partySide: "A",
  });

  const ids = async (filters: {
    docRoles?: string[];
    partyRoles?: string[];
    partySides?: string[];
  }) =>
    new Set(
      (
        await searchProjectIndex({
          projectId,
          query: "common",
          limit: 20,
          ...filters,
        })
      ).map((result) => result.document_id),
    );

  assert.deepEqual(await ids({ partyRoles: ["항소인"] }), new Set(["brief-appellant"]));
  assert.deepEqual(
    await ids({ docRoles: ["brief"], partyRoles: ["원고"] }),
    new Set(["brief-plaintiff"]),
  );
  assert.deepEqual(
    await ids({ partySides: ["A"] }),
    new Set(["brief-plaintiff", "evidence-plaintiff"]),
  );
});
