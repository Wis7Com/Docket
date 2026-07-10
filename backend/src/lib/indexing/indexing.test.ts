import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { closeDb, getDb, runWithDatabaseContext } from "../../db/sqlite";
import { runMigrations } from "../../db/migrate";
import { chunkTextForIndex } from "./extractors";
import {
  setEmbeddingAdapterOverrideForTests,
  vectorToBlob,
} from "./embeddings";
import {
  compactProjectDatabase,
  enqueueProjectIndexRebuild,
  ensureProjectSemanticIndexQueued,
  getProjectSemanticIndexStatus,
  pauseProjectSemanticIndexing,
  startProjectSemanticIndexing,
  withSemanticIndexingPaused,
} from "./indexer";
import {
  getProjectIndexCorpusStats,
  listProjectIndexGaps,
  readProjectIndexChunk,
  searchProjectIndex,
} from "./search";

let testRoot = "";

before(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docket-index-test-"));
  const appDataDir = path.join(testRoot, "app-data");
  process.env.APP_DATA_PATH = appDataDir;
  delete process.env.WORKSPACE_PATH;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  runMigrations();
});

after(() => {
  closeDb();
  if (testRoot) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("document index migration creates searchable FTS rows that can be removed by version", () => {
  const db = getDb();
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('document_index_files', 'document_index_chunks', 'document_index_chunks_fts', 'document_index_chunks_fts_trigram', 'document_index_vectors')",
    )
    .all() as { name: string }[];
  assert.deepEqual(
    tables.map((row) => row.name).sort(),
    [
      "document_index_chunks",
      "document_index_chunks_fts",
      "document_index_chunks_fts_trigram",
      "document_index_files",
      "document_index_vectors",
    ],
  );

  db.prepare(
    "INSERT INTO document_index_chunks_fts (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
  ).run("chunk-a", "doc-a", "version-a", "alpha beta");
  const hit = db
    .prepare(
      "SELECT chunk_id FROM document_index_chunks_fts WHERE document_index_chunks_fts MATCH ?",
    )
    .get("alpha") as { chunk_id: string };
  assert.equal(hit.chunk_id, "chunk-a");

  db.prepare(
    "DELETE FROM document_index_chunks_fts WHERE document_id = ? AND version_id = ?",
  ).run("doc-a", "version-a");
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM document_index_chunks_fts")
    .get() as { count: number };
  assert.equal(count.count, 0);
});

test("chunkTextForIndex keeps PDF page metadata and overlapping chunk order", () => {
  const words = Array.from({ length: 720 }, (_, i) => `word${i}`).join(" ");
  const chunks = chunkTextForIndex(`[Page 2]\n${words}`);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].page_number, 2);
  assert.equal(chunks[1].page_number, 2);
  assert.equal(chunks[0].chunk_index, 0);
  assert.equal(chunks[1].chunk_index, 1);
  assert.ok(chunks[0].content.includes("word0"));
  assert.ok(chunks[1].content.includes("word450"));
});

test("searchProjectIndex returns current-version project chunks only", async () => {
  const db = getDb();
  const projectId = "project-search";
  const docId = "doc-search";
  const oldVersionId = "version-old";
  const versionId = "version-current";
  const chunkId = "chunk-current";

  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
  ).run(projectId, "owner", "Search Project", "[]");
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(docId, projectId, "owner", "contract.txt", "txt", "ready", versionId);
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
  ).run(oldVersionId, docId, "old.txt", "upload", 1);
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
  ).run(versionId, docId, "current.txt", "upload", 2);
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("index-current", docId, versionId, "ready", 1, 54);
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("index-old", docId, oldVersionId, "ready", 1, 28);
  db.prepare(
    "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    chunkId,
    docId,
    versionId,
    0,
    "The indemnity obligation survives termination.",
    0,
    43,
    5,
  );
  db.prepare(
    "INSERT INTO document_index_chunks_fts (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
  ).run(
    chunkId,
    docId,
    versionId,
    "The indemnity obligation survives termination.",
  );
  db.prepare(
    "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "chunk-old",
    docId,
    oldVersionId,
    0,
    "Obsolete indemnity language.",
    0,
    28,
    3,
  );
  db.prepare(
    "INSERT INTO document_index_chunks_fts (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
  ).run("chunk-old", docId, oldVersionId, "Obsolete indemnity language.");

  const results = await searchProjectIndex({
    projectId,
    query: "indemnity termination",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].chunk_id, chunkId);
  assert.equal(results[0].filename, "contract.txt");
});

test("searchProjectIndex uses trigram substring matching for Korean suffix queries", async () => {
  const db = getDb();
  const projectId = "project-korean-fallback";
  const docId = "doc-korean";
  const versionId = "version-korean";
  const chunkId = "chunk-korean";
  const content = "대한민국의 법률 문서에는 손해배상 조항이 포함됩니다.";

  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
  ).run(projectId, "owner", "Korean Search Project", "[]");
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(docId, projectId, "owner", "korean.md", "md", "ready", versionId);
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
  ).run(versionId, docId, "korean.md", "upload", 1);
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("index-korean", docId, versionId, "ready", 1, Buffer.byteLength(content));
  db.prepare(
    "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(chunkId, docId, versionId, 0, content, 0, content.length, 5);
  db.prepare(
    "INSERT INTO document_index_chunks_fts (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
  ).run(chunkId, docId, versionId, content);
  db.prepare(
    "INSERT INTO document_index_chunks_fts_trigram (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
  ).run(chunkId, docId, versionId, content);

  const excludedDocId = "doc-korean-excluded";
  const excludedVersionId = "version-korean-excluded";
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    excludedDocId,
    projectId,
    "owner",
    "excluded-korean.md",
    "md",
    "ready",
    excludedVersionId,
  );
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
  ).run(excludedVersionId, excludedDocId, "excluded-korean.md", "upload", 1);
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "index-korean-excluded",
    excludedDocId,
    excludedVersionId,
    "ready",
    1,
    Buffer.byteLength(content),
  );
  db.prepare(
    "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "chunk-korean-excluded",
    excludedDocId,
    excludedVersionId,
    0,
    content,
    0,
    content.length,
    5,
  );
  db.prepare(
    "INSERT INTO document_index_chunks_fts_trigram (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
  ).run("chunk-korean-excluded", excludedDocId, excludedVersionId, content);

  const results = await searchProjectIndex({
    projectId,
    query: "민국",
    documentIds: [docId],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].chunk_id, chunkId);
  assert.equal(results[0].basic_match, false);
  assert.ok(results[0].match_reasons?.includes("substring"));
  assert.equal(results[0].quote, content);
});

test("searchProjectIndex uses semantic vectors when the active model has ready blobs", async () => {
  const db = getDb();
  const projectId = "project-semantic-search";
  const userId = "semantic-user";
  const docId = "doc-semantic";
  const versionId = "version-semantic";
  const chunkId = "chunk-semantic";
  const content = "The tribunal may stay proceedings when arbitration is pending.";

  db.prepare(
    "INSERT INTO user_profiles (id, user_id, embedding_provider, embedding_model, embedding_dimensions_policy) VALUES (?, ?, ?, ?, ?)",
  ).run("profile-semantic", userId, "ollama", "test-embed", "native");
  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
  ).run(projectId, userId, "Semantic Search Project", "[]");
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(docId, projectId, userId, "arbitration.pdf", "pdf", "ready", versionId);
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
  ).run(versionId, docId, "arbitration.pdf", "upload", 1);
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("index-semantic", docId, versionId, "ready", 1, content.length);
  db.prepare(
    "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, page_number, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(chunkId, docId, versionId, 0, 7, content, 0, content.length, 9);
  db.prepare(
    `
    INSERT INTO document_index_vectors (
      id, chunk_id, chunk_content_hash, provider, model_id, model, dimensions,
      normalized, embedding_blob, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "vector-semantic",
    chunkId,
    crypto.createHash("sha256").update(content).digest("hex"),
    "ollama",
    "test-embed",
    "test-embed",
    3,
    1,
    vectorToBlob([1, 0, 0]),
    "ready",
  );

  const excludedDocId = "doc-semantic-excluded";
  const excludedVersionId = "version-semantic-excluded";
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    excludedDocId,
    projectId,
    userId,
    "excluded-semantic.pdf",
    "pdf",
    "ready",
    excludedVersionId,
  );
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
  ).run(
    excludedVersionId,
    excludedDocId,
    "excluded-semantic.pdf",
    "upload",
    1,
  );
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "index-semantic-excluded",
    excludedDocId,
    excludedVersionId,
    "ready",
    2,
    128,
  );
  for (let i = 0; i < 2; i += 1) {
    const excludedChunkId = `chunk-semantic-excluded-${i}`;
    const excludedContent = `Excluded semantic content ${i}`;
    db.prepare(
      "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      excludedChunkId,
      excludedDocId,
      excludedVersionId,
      i,
      excludedContent,
      0,
      excludedContent.length,
      4,
    );
    db.prepare(
      `
      INSERT INTO document_index_vectors (
        id, chunk_id, chunk_content_hash, provider, model_id, model, dimensions,
        normalized, embedding_blob, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      `vector-semantic-excluded-${i}`,
      excludedChunkId,
      crypto.createHash("sha256").update(excludedContent).digest("hex"),
      "ollama",
      "test-embed",
      "test-embed",
      4,
      1,
      vectorToBlob([1, 0, 0, 0]),
      "ready",
    );
  }

  setEmbeddingAdapterOverrideForTests({
    embedDocument: async () => [1, 0, 0],
    embedQuery: async () => [1, 0, 0],
  });
  try {
    const results = await searchProjectIndex({
      projectId,
      userId,
      query: "pause litigation for arbitral forum",
      documentIds: [docId],
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].chunk_id, chunkId);
    assert.ok(results[0].match_reasons?.includes("semantic"));
    assert.equal(results[0].semantic_score, 1);
  } finally {
    setEmbeddingAdapterOverrideForTests(null);
  }
});

test("existing ready chunks are queued for semantic indexing after migration", async () => {
  const db = getDb();
  const projectId = "project-semantic-backfill";
  const userId = "semantic-backfill-user";
  const docId = "doc-semantic-backfill";
  const versionId = "version-semantic-backfill";

  db.prepare(
    "INSERT INTO user_profiles (id, user_id, embedding_provider, embedding_model, embedding_dimensions_policy) VALUES (?, ?, ?, ?, ?)",
  ).run("profile-semantic-backfill", userId, "ollama", "test-embed", "native");
  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
  ).run(projectId, userId, "Semantic Backfill Project", "[]");
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(docId, projectId, userId, "backfill.pdf", "pdf", "ready", versionId);
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
  ).run(versionId, docId, "backfill.pdf", "upload", 1);
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("index-semantic-backfill", docId, versionId, "ready", 2, 80);

  for (let i = 0; i < 2; i += 1) {
    db.prepare(
      "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      `chunk-semantic-backfill-${i}`,
      docId,
      versionId,
      i,
      `Semantic backfill chunk ${i}`,
      i * 20,
      i * 20 + 19,
      4,
    );
  }

  setEmbeddingAdapterOverrideForTests({
    embedDocument: async () => [1, 0, 0],
    embedQuery: async () => [1, 0, 0],
  });
  try {
    await withSemanticIndexingPaused(async () => {
      const enqueued = ensureProjectSemanticIndexQueued(projectId, userId);
      assert.equal(enqueued, 2);
      const rows = db
        .prepare(
          `
          SELECT status, COUNT(*) AS count
          FROM document_index_vectors
          WHERE chunk_id LIKE 'chunk-semantic-backfill-%'
          GROUP BY status
        `,
        )
        .all() as { status: string; count: number }[];
      assert.deepEqual(rows, [{ status: "pending", count: 2 }]);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    setEmbeddingAdapterOverrideForTests(null);
  }
});

test("semantic indexing status is passive until manually started", async () => {
  const db = getDb();
  const projectId = "project-semantic-manual";
  const userId = "semantic-manual-user";
  const docId = "doc-semantic-manual";
  const versionId = "version-semantic-manual";

  db.prepare(
    "INSERT INTO user_profiles (id, user_id, embedding_provider, embedding_model, embedding_dimensions_policy) VALUES (?, ?, ?, ?, ?)",
  ).run("profile-semantic-manual", userId, "ollama", "test-embed", "native");
  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
  ).run(projectId, userId, "Manual Semantic Project", "[]");
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(docId, projectId, userId, "manual.pdf", "pdf", "ready", versionId);
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
  ).run(versionId, docId, "manual.pdf", "upload", 1);
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("index-semantic-manual", docId, versionId, "ready", 2, 80);

  for (let i = 0; i < 2; i += 1) {
    db.prepare(
      "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      `chunk-semantic-manual-${i}`,
      docId,
      versionId,
      i,
      `Manual semantic chunk ${i}`,
      i * 20,
      i * 20 + 19,
      4,
    );
  }

  const passive = getProjectSemanticIndexStatus(projectId, userId);
  assert.equal(passive.total_vectors, 2);
  assert.equal(passive.ready_vectors, 0);
  assert.equal(passive.status_counts.pending ?? 0, 0);
  assert.equal(
    (db
      .prepare(
        "SELECT COUNT(*) AS count FROM document_index_vectors WHERE chunk_id LIKE 'chunk-semantic-manual-%'",
      )
      .get() as { count: number }).count,
    0,
  );

  pauseProjectSemanticIndexing(projectId);
  assert.equal(getProjectSemanticIndexStatus(projectId, userId).paused, true);

  setEmbeddingAdapterOverrideForTests({
    embedDocument: async () => [1, 0, 0],
    embedQuery: async () => [1, 0, 0],
  });
  try {
    await withSemanticIndexingPaused(async () => {
      const enqueued = startProjectSemanticIndexing(projectId, userId);
      assert.equal(enqueued, 2);
      const started = getProjectSemanticIndexStatus(projectId, userId);
      assert.equal(started.paused, false);
      assert.equal(started.status_counts.pending, 2);
      assert.equal(started.total_vectors, 2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    setEmbeddingAdapterOverrideForTests(null);
  }
});

test("rebuild removes every project embedding model and cancels queued work", async () => {
  const db = getDb();
  const projectId = "project-embedding-clear";
  const userId = "embedding-clear-user";
  db.exec(`
    INSERT INTO user_profiles (
      id, user_id, embedding_provider, embedding_model, embedding_dimensions_policy
    ) VALUES ('profile-embedding-clear', '${userId}', 'ollama', 'current-model', 'native');
    INSERT INTO projects (id, user_id, name, shared_with) VALUES
      ('${projectId}', '${userId}', 'Embedding Clear Project', '[]'),
      ('project-embedding-clear-other', '${userId}', 'Other Project', '[]');
    INSERT INTO documents (
      id, project_id, user_id, filename, file_type, status, current_version_id
    ) VALUES
      ('doc-embedding-clear', '${projectId}', '${userId}', 'clear.txt', 'txt', 'error', 'version-embedding-clear'),
      ('doc-embedding-clear-other', 'project-embedding-clear-other', '${userId}', 'keep.txt', 'txt', 'ready', 'version-embedding-clear-other');
    INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES
      ('version-embedding-clear', 'doc-embedding-clear', 'clear.txt', 'upload', 1),
      ('version-embedding-clear-other', 'doc-embedding-clear-other', 'keep.txt', 'upload', 1);
    INSERT INTO document_index_files (
      id, document_id, version_id, status, chunk_count, text_bytes
    ) VALUES ('index-embedding-clear', 'doc-embedding-clear', 'version-embedding-clear', 'ready', 2, 32);
    INSERT INTO document_index_chunks (
      id, document_id, version_id, chunk_index, content, start_char, end_char, token_count
    ) VALUES
      ('chunk-embedding-clear-0', 'doc-embedding-clear', 'version-embedding-clear', 0, 'Clear chunk 0', 0, 12, 3),
      ('chunk-embedding-clear-1', 'doc-embedding-clear', 'version-embedding-clear', 1, 'Clear chunk 1', 13, 25, 3),
      ('chunk-embedding-clear-other', 'doc-embedding-clear-other', 'version-embedding-clear-other', 0, 'Keep vector', 0, 11, 2);
    INSERT INTO document_index_vectors (
      id, chunk_id, provider, model_id, model, dimensions, normalized, status
    ) VALUES
      ('vector-embedding-clear-old', 'chunk-embedding-clear-0', 'ollama', 'old-model', 'old-model', 3, 1, 'ready'),
      ('vector-embedding-clear-other', 'chunk-embedding-clear-other', 'ollama', 'other-model', 'other-model', 3, 1, 'ready');
  `);

  await withSemanticIndexingPaused(async () => {
    assert.equal(ensureProjectSemanticIndexQueued(projectId, userId), 2);
    assert.equal(await enqueueProjectIndexRebuild(projectId), 0);
    assert.equal(
      getProjectSemanticIndexStatus(projectId, userId).queued_vectors,
      0,
    );
  });

  const targetCount = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM document_index_vectors v
      JOIN document_index_chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE d.project_id = ?
    `,
    )
    .get(projectId) as { count: number };
  const otherCount = db
    .prepare(
      "SELECT COUNT(*) AS count FROM document_index_vectors WHERE id = ?",
    )
    .get("vector-embedding-clear-other") as { count: number };
  assert.equal(targetCount.count, 0);
  assert.equal(otherCount.count, 1);
});

test("database compaction reclaims deleted project database pages", () => {
  const dataRoot = path.join(testRoot, "compact-project");
  const dbPath = path.join(dataRoot, "project.db");
  fs.mkdirSync(dataRoot, { recursive: true });

  runWithDatabaseContext(
    {
      kind: "project",
      dbPath,
      dataRoot,
      projectId: "project-compact",
    },
    () => {
      runMigrations();
      const db = getDb();
      db.prepare(
        "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
      ).run("project-compact", "owner", "Compact Project", "[]");
      db.exec("CREATE TABLE compact_payload (payload BLOB NOT NULL)");
      db.prepare("INSERT INTO compact_payload (payload) VALUES (?)").run(
        Buffer.alloc(2 * 1024 * 1024, 1),
      );
      db.exec("DELETE FROM compact_payload");

      const result = compactProjectDatabase("project-compact");
      assert.ok(result.before_bytes > result.after_bytes);
      assert.equal(
        result.reclaimed_bytes,
        result.before_bytes - result.after_bytes,
      );
      assert.ok(result.free_pages_before > 0);
      assert.equal(
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?")
            .get("project-compact") as { count: number }
        ).count,
        1,
      );
    },
  );
});

test("readProjectIndexChunk returns exact neighboring chunk context", () => {
  const db = getDb();
  const projectId = "project-neighbors";
  const docId = "doc-neighbors";
  const versionId = "version-neighbors";

  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
  ).run(projectId, "owner", "Neighbor Project", "[]");
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(docId, projectId, "owner", "memo.txt", "txt", "ready", versionId);
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
  ).run(versionId, docId, "memo.txt", "upload", 1);
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("index-neighbors", docId, versionId, "ready", 3, 90);

  for (let i = 0; i < 3; i += 1) {
    db.prepare(
      "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, page_number, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      `chunk-neighbor-${i}`,
      docId,
      versionId,
      i,
      i + 1,
      `Context chunk ${i}`,
      i * 10,
      i * 10 + 9,
      3,
    );
  }

  const chunks = readProjectIndexChunk({
    projectId,
    documentId: docId,
    versionId,
    chunkIndex: 1,
    neighbors: 1,
  });
  assert.deepEqual(
    chunks.map((chunk) => chunk.chunk_index),
    [0, 1, 2],
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.page_number),
    [1, 2, 3],
  );
  assert.equal(chunks[1].quote, "Context chunk 1");
});

test("getProjectIndexCorpusStats counts ready indexed documents and total project docs", () => {
  const db = getDb();
  const projectId = "project-stats";
  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
  ).run(projectId, "owner", "Stats Project", "[]");
  for (const suffix of ["a", "b"]) {
    const docId = `doc-stats-${suffix}`;
    const versionId = `version-stats-${suffix}`;
    db.prepare(
      "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(docId, projectId, "owner", `${suffix}.txt`, "txt", "ready", versionId);
    db.prepare(
      "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
    ).run(versionId, docId, `${suffix}.txt`, "upload", 1);
  }
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("index-stats-a", "doc-stats-a", "version-stats-a", "ready", 1, 123);

  const stats = getProjectIndexCorpusStats(projectId);
  assert.equal(stats.total_documents, 2);
  assert.equal(stats.ready_documents, 1);
  assert.equal(stats.text_bytes, 123);

  const scopedStats = getProjectIndexCorpusStats(projectId, {
    documentIds: ["doc-stats-a"],
  });
  assert.deepEqual(scopedStats, {
    total_documents: 1,
    ready_documents: 1,
    text_bytes: 123,
  });
  assert.deepEqual(listProjectIndexGaps(projectId, {
    documentIds: ["doc-stats-a"],
  }), []);
  assert.deepEqual(
    listProjectIndexGaps(projectId, { documentIds: ["doc-stats-b"] }).map(
      (document) => document.document_id,
    ),
    ["doc-stats-b"],
  );
});

test("searchProjectIndex applies file type and folder filters", async () => {
  const db = getDb();
  const projectId = "project-filtered-search";
  const folderA = "folder-filter-a";
  const folderB = "folder-filter-b";

  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
  ).run(projectId, "owner", "Filtered Search Project", "[]");
  for (const folderId of [folderA, folderB]) {
    db.prepare(
      "INSERT INTO project_subfolders (id, project_id, user_id, name) VALUES (?, ?, ?, ?)",
    ).run(folderId, projectId, "owner", folderId);
  }

  const docs = [
    {
      docId: "doc-filter-pdf",
      versionId: "version-filter-pdf",
      folderId: folderA,
      fileType: "pdf",
      filename: "match.pdf",
      chunkId: "chunk-filter-pdf",
    },
    {
      docId: "doc-filter-md",
      versionId: "version-filter-md",
      folderId: folderB,
      fileType: "md",
      filename: "match.md",
      chunkId: "chunk-filter-md",
    },
  ];

  for (const doc of docs) {
    db.prepare(
      "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, folder_id, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      doc.docId,
      projectId,
      "owner",
      doc.filename,
      doc.fileType,
      "ready",
      doc.folderId,
      doc.versionId,
    );
    db.prepare(
      "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
    ).run(doc.versionId, doc.docId, doc.filename, "upload", 1);
    db.prepare(
      "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(`index-${doc.docId}`, doc.docId, doc.versionId, "ready", 1, 64);
    db.prepare(
      "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      doc.chunkId,
      doc.docId,
      doc.versionId,
      0,
      "Shared filtered search clause",
      0,
      29,
      4,
    );
    db.prepare(
      "INSERT INTO document_index_chunks_fts (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
    ).run(doc.chunkId, doc.docId, doc.versionId, "Shared filtered search clause");
    db.prepare(
      "INSERT INTO document_index_chunks_fts_trigram (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
    ).run(doc.chunkId, doc.docId, doc.versionId, "Shared filtered search clause");
  }

  const pdfOnly = await searchProjectIndex({
    projectId,
    query: "filtered clause",
    fileTypes: ["pdf"],
  });
  assert.deepEqual(
    pdfOnly.map((result) => result.filename),
    ["match.pdf"],
  );

  const folderOnly = await searchProjectIndex({
    projectId,
    query: "filtered clause",
    folderId: folderB,
  });
  assert.deepEqual(
    folderOnly.map((result) => result.filename),
    ["match.md"],
  );

  const documentOnly = await searchProjectIndex({
    projectId,
    query: "filtered clause",
    documentIds: ["doc-filter-pdf"],
  });
  assert.deepEqual(
    documentOnly.map((result) => result.filename),
    ["match.pdf"],
  );

  const emptyDocumentFilter = await searchProjectIndex({
    projectId,
    query: "filtered clause",
    documentIds: [],
  });
  assert.deepEqual(
    new Set(emptyDocumentFilter.map((result) => result.filename)),
    new Set(["match.pdf", "match.md"]),
  );
});

test("searchProjectIndex does not broaden multi-term FTS queries when strict matching is empty", async () => {
  const db = getDb();
  const projectId = "project-broadened-search";
  const docId = "doc-broadened";
  const versionId = "version-broadened";
  const chunkId = "chunk-broadened";

  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
  ).run(projectId, "owner", "Broadened Search Project", "[]");
  db.prepare(
    "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(docId, projectId, "owner", "partial.txt", "txt", "ready", versionId);
  db.prepare(
    "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
  ).run(versionId, docId, "partial.txt", "upload", 1);
  db.prepare(
    "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("index-broadened", docId, versionId, "ready", 1, 64);
  db.prepare(
    "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    chunkId,
    docId,
    versionId,
    0,
    "The indemnity clause survives closing.",
    0,
    38,
    5,
  );
  db.prepare(
    "INSERT INTO document_index_chunks_fts (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
  ).run(chunkId, docId, versionId, "The indemnity clause survives closing.");

  const results = await searchProjectIndex({
    projectId,
    query: "indemnity termination",
  });
  assert.equal(results.length, 0);
});

test("searchProjectIndex normalizes English possessives without matching the stray s token", async () => {
  const db = getDb();
  const projectId = "project-possessive-search";
  const docs = [
    {
      docId: "doc-possessive-match",
      versionId: "version-possessive-match",
      chunkId: "chunk-possessive-match",
      filename: "judge.pdf",
      content: "The judge's discretion remains broad in procedural rulings.",
    },
    {
      docId: "doc-possessive-noise",
      versionId: "version-possessive-noise",
      chunkId: "chunk-possessive-noise",
      filename: "discretion.pdf",
      content: "The court's discretion appears here without the judicial noun.",
    },
  ];

  db.prepare(
    "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
  ).run(projectId, "owner", "Possessive Search Project", "[]");

  for (const doc of docs) {
    db.prepare(
      "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      doc.docId,
      projectId,
      "owner",
      doc.filename,
      "pdf",
      "ready",
      doc.versionId,
    );
    db.prepare(
      "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
    ).run(doc.versionId, doc.docId, doc.filename, "upload", 1);
    db.prepare(
      "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      `index-${doc.docId}`,
      doc.docId,
      doc.versionId,
      "ready",
      1,
      doc.content.length,
    );
    db.prepare(
      "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, page_number, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      doc.chunkId,
      doc.docId,
      doc.versionId,
      0,
      1,
      doc.content,
      0,
      doc.content.length,
      8,
    );
    db.prepare(
      "INSERT INTO document_index_chunks_fts (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
    ).run(doc.chunkId, doc.docId, doc.versionId, doc.content);
    db.prepare(
      "INSERT INTO document_index_chunks_fts_trigram (chunk_id, document_id, version_id, content) VALUES (?, ?, ?, ?)",
    ).run(doc.chunkId, doc.docId, doc.versionId, doc.content);
  }

  const results = await searchProjectIndex({
    projectId,
    query: "judge's discretion",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].chunk_id, "chunk-possessive-match");
  assert.equal(results[0].basic_match, false);
  assert.match(results[0].snippet, /\[\[HL\]\]judge\[\[\/HL\]\]'s/i);
  assert.match(results[0].snippet, /\[\[HL\]\]discretion\[\[\/HL\]\]/i);
});
