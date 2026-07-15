import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { closeDb, getDb } from "../../db/sqlite";
import { runMigrations } from "../../db/migrate";
import { readProjectIndexChunk, searchProjectIndex } from "./search";

let testRoot = "";

before(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docket-search-b0-"));
  process.env.APP_DATA_PATH = path.join(testRoot, "app-data");
  process.env.DOCKET_EMBEDDING_ENABLED = "0";
  delete process.env.WORKSPACE_PATH;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  runMigrations();
});

after(() => {
  closeDb();
  delete process.env.DOCKET_EMBEDDING_ENABLED;
  if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
});

function insertProject(projectId: string): void {
  getDb()
    .prepare(
      "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
    )
    .run(projectId, "owner", projectId, "[]");
}

function insertIndexedDocument(args: {
  projectId: string;
  documentId: string;
  filename: string;
  content: string;
  displayName?: string | null;
  fileType?: string;
  folderId?: string | null;
  indexStatus?: "ready" | "indexing";
  chunkCount?: number;
  populateFts?: boolean;
}): void {
  const db = getDb();
  const versionId = `version-${args.documentId}`;
  const fileType = args.fileType ?? "pdf";
  const chunkCount = args.chunkCount ?? 1;
  db.prepare(
    `INSERT INTO documents
      (id, project_id, user_id, filename, file_type, status, folder_id, current_version_id)
     VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`,
  ).run(
    args.documentId,
    args.projectId,
    "owner",
    args.filename,
    fileType,
    args.folderId ?? null,
    versionId,
  );
  db.prepare(
    `INSERT INTO document_versions
      (id, document_id, storage_path, source, version_number, display_name)
     VALUES (?, ?, ?, 'upload', 1, ?)`,
  ).run(versionId, args.documentId, args.filename, args.displayName ?? null);
  db.prepare(
    `INSERT INTO document_index_files
      (id, document_id, version_id, status, chunk_count, text_bytes)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `index-${args.documentId}`,
    args.documentId,
    versionId,
    args.indexStatus ?? "ready",
    chunkCount,
    Buffer.byteLength(args.content) * chunkCount,
  );

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const chunkId = `chunk-${args.documentId}-${chunkIndex}`;
    const content = `${args.content} ${chunkIndex}`;
    db.prepare(
      `INSERT INTO document_index_chunks
        (id, document_id, version_id, chunk_index, page_number, content,
         start_char, end_char, token_count)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      chunkId,
      args.documentId,
      versionId,
      chunkIndex,
      chunkIndex + 1,
      content,
      content.length,
      content.split(/\s+/).length,
    );
    if (args.populateFts) {
      db.prepare(
        `INSERT INTO document_index_chunks_fts
          (chunk_id, document_id, version_id, content)
         VALUES (?, ?, ?, ?)`,
      ).run(chunkId, args.documentId, versionId, content);
      db.prepare(
        `INSERT INTO document_index_chunks_fts_trigram
          (chunk_id, document_id, version_id, content)
         VALUES (?, ?, ?, ?)`,
      ).run(chunkId, args.documentId, versionId, content);
    }
  }
}

test("title lane finds filename and current display-name mentions as raw chunks", async () => {
  const projectId = "b0-title-project";
  insertProject(projectId);
  insertIndexedDocument({
    projectId,
    documentId: "b0-samuels",
    filename: "Samuels_v_Lido.pdf",
    content: "A neutral opening paragraph without party names.",
  });
  insertIndexedDocument({
    projectId,
    documentId: "b0-ooki",
    filename: "opaque-2024-17.pdf",
    displayName: "CFTC v Ooki DAO Decision.pdf",
    content: "Jurisdiction and service are discussed in the source.",
    indexStatus: "indexing",
  });

  const filenameResults = await searchProjectIndex({
    projectId,
    query: "Apply the HCCH connecting factors to Samuels v Lido",
  });
  assert.equal(filenameResults[0]?.document_id, "b0-samuels");
  assert.equal(filenameResults[0]?.chunk_id, "chunk-b0-samuels-0");
  assert.equal(filenameResults[0]?.quote, filenameResults[0]?.content);
  assert.ok(filenameResults[0]?.match_reasons?.includes("filename"));

  const displayNameResults = await searchProjectIndex({
    projectId,
    query: "How would the CFTC v Ooki DAO Decision resolve this issue?",
  });
  assert.equal(displayNameResults[0]?.document_id, "b0-ooki");
  assert.equal(displayNameResults[0]?.chunk_id, "chunk-b0-ooki-0");
  assert.ok(displayNameResults[0]?.match_reasons?.includes("filename"));
});

test("generic title words alone cannot create a title candidate", async () => {
  const projectId = "b0-generic-title-project";
  insertProject(projectId);
  insertIndexedDocument({
    projectId,
    documentId: "b0-generic-title",
    filename: "agreement.pdf",
    displayName: "Final Contract Document",
    content: "Citrus harvest figures appear in this unrelated source.",
  });
  insertIndexedDocument({
    projectId,
    documentId: "b0-generic-korean",
    filename: "계약서.pdf",
    displayName: "최종 문서",
    content: "이 원문은 감귤 수확량만 다룹니다.",
  });

  const english = await searchProjectIndex({
    projectId,
    query: "find the final agreement contract document",
  });
  assert.deepEqual(english, []);

  const korean = await searchProjectIndex({
    projectId,
    query: "최종 계약서 문서 찾아줘",
  });
  assert.deepEqual(korean, []);
});

test("reserved FTS operators in model-authored queries do not abort search", async () => {
  const projectId = "b0-reserved-operator-project";
  insertProject(projectId);
  insertIndexedDocument({
    projectId,
    documentId: "b0-reserved-operator",
    filename: "mail-voting.pdf",
    content: "Project 1599 discussed voting by mail and absentee ballots.",
    populateFts: true,
  });

  const results = await searchProjectIndex({
    projectId,
    query: '"Project 1599" OR "mail" AND "absentee"',
  });
  assert.equal(results[0]?.document_id, "b0-reserved-operator");
});

test("title candidates obey file, folder, and explicit document filters", async () => {
  const db = getDb();
  const projectId = "b0-title-filter-project";
  const folderA = "b0-title-folder-a";
  const folderB = "b0-title-folder-b";
  insertProject(projectId);
  db.prepare(
    `INSERT INTO project_subfolders
      (id, project_id, user_id, name)
     VALUES (?, ?, 'owner', ?), (?, ?, 'owner', ?)`,
  ).run(folderA, projectId, "A", folderB, projectId, "B");
  insertIndexedDocument({
    projectId,
    documentId: "b0-sample-pdf",
    filename: "Sample_Source_Analysis.pdf",
    content: "First source text.",
    fileType: "pdf",
    folderId: folderA,
  });
  insertIndexedDocument({
    projectId,
    documentId: "b0-sample-md",
    filename: "Sample_Source_Analysis.md",
    content: "Second source text.",
    fileType: "md",
    folderId: folderB,
  });

  const pdfOnly = await searchProjectIndex({
    projectId,
    query: "Compare the Sample Source Analysis with other authorities",
    fileTypes: ["pdf"],
  });
  assert.deepEqual(
    pdfOnly.map((row) => row.document_id),
    ["b0-sample-pdf"],
  );

  const folderOnly = await searchProjectIndex({
    projectId,
    query: "Compare the Sample Source Analysis with other authorities",
    folderId: folderB,
  });
  assert.deepEqual(
    folderOnly.map((row) => row.document_id),
    ["b0-sample-md"],
  );

  const documentOnly = await searchProjectIndex({
    projectId,
    query: "Compare the Sample Source Analysis with other authorities",
    documentIds: ["b0-sample-md"],
  });
  assert.deepEqual(
    documentOnly.map((row) => row.document_id),
    ["b0-sample-md"],
  );
});

test("document grouping aggregates bounded fallback candidates before final top-k", async () => {
  const projectId = "b0-group-before-limit-project";
  insertProject(projectId);
  insertIndexedDocument({
    projectId,
    documentId: "a-b0-many-chunks",
    filename: "alpha.pdf",
    content: "needle ordered clause",
    chunkCount: 5,
  });
  insertIndexedDocument({
    projectId,
    documentId: "b-b0-one-chunk",
    filename: "beta.pdf",
    content: "needle ordered clause",
  });

  const grouped = await searchProjectIndex({
    projectId,
    query: "needle ordered",
    group: "documents",
    limit: 2,
  });
  assert.deepEqual(
    new Set(grouped.map((row) => row.document_id)),
    new Set(["a-b0-many-chunks", "b-b0-one-chunk"]),
  );
  assert.equal(grouped[0]?.grouped_chunk_count, 5);

  const ordinaryChunks = await searchProjectIndex({
    projectId,
    query: "needle ordered",
    limit: 2,
  });
  assert.equal(ordinaryChunks.length, 2);
  assert.ok(
    ordinaryChunks.every((row) => row.document_id === "a-b0-many-chunks"),
  );
  assert.ok(
    ordinaryChunks.every((row) => row.match_reasons?.includes("basic")),
  );
});

test("ordinary chunk FTS retrieval remains available without a title match", async () => {
  const projectId = "b0-ordinary-chunk-project";
  insertProject(projectId);
  insertIndexedDocument({
    projectId,
    documentId: "b0-ordinary-chunk",
    filename: "unrelated-name.pdf",
    content: "The indemnity obligation survives termination.",
    populateFts: true,
  });

  const results = await searchProjectIndex({
    projectId,
    query: "indemnity termination",
  });
  assert.equal(results[0]?.chunk_id, "chunk-b0-ordinary-chunk-0");
  assert.ok(results[0]?.match_reasons?.includes("keyword"));
});

test("current last-ready chunks remain searchable while their index row is refreshing", async () => {
  const projectId = "b0-indexing-search-project";
  insertProject(projectId);
  insertIndexedDocument({
    projectId,
    documentId: "b0-indexing-search",
    filename: "refreshing-source.pdf",
    content: "The connecting factor remains the place of effective control.",
    indexStatus: "indexing",
    populateFts: true,
  });

  const results = await searchProjectIndex({
    projectId,
    query: "connecting factor",
  });
  assert.equal(results[0]?.chunk_id, "chunk-b0-indexing-search-0");
  assert.ok(results[0]?.match_reasons?.includes("keyword"));

  const directRead = readProjectIndexChunk({
    projectId,
    documentId: "b0-indexing-search",
    versionId: "version-b0-indexing-search",
    chunkIndex: 0,
  });
  assert.equal(directRead[0]?.chunk_id, "chunk-b0-indexing-search-0");
});
