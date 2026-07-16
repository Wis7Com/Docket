import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import {
  closeDb,
  getAppDb,
  getDb,
  runWithDatabaseContext,
} from "../../db/sqlite";
import { runMigrations } from "../../db/migrate";
import {
  readProjectEmbeddingModelOverride,
  resolveProjectEmbeddingSettings,
  setEmbeddingAdapterOverrideForTests,
  setProjectEmbeddingModelOverride,
  vectorToBlob,
} from "./embeddings";
import { getProjectSemanticIndexStatus } from "./indexer";
import { searchProjectIndex } from "./search";

let root = "";

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "docket-project-embedding-"));
  process.env.APP_DATA_PATH = path.join(root, "app-data");
  delete process.env.WORKSPACE_PATH;
  runMigrations();
});

after(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("project embedding override takes precedence over profile and selects matching semantic vectors", async () => {
  const projectId = "project-embedding-override";
  const userId = "project-embedding-user";
  const projectRoot = path.join(root, "project");
  const dbPath = path.join(projectRoot, "project.db");
  fs.mkdirSync(projectRoot, { recursive: true });
  getAppDb()
    .prepare(
      "INSERT INTO user_profiles (id, user_id, embedding_provider, embedding_model, embedding_dimensions_policy) VALUES (?, ?, ?, ?, ?)",
    )
    .run("profile-project-embedding", userId, "ollama", "profile-embed", "native");

  await runWithDatabaseContext(
    { kind: "project", projectId, dataRoot: projectRoot, dbPath },
    async () => {
      runMigrations();
      const db = getDb();
      db.prepare(
        "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
      ).run(projectId, userId, "Embedding override", "[]");
      db.prepare(
        "INSERT INTO documents (id, project_id, user_id, filename, file_type, status, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("doc-embedding-override", projectId, userId, "notes.txt", "txt", "ready", "version-embedding-override");
      db.prepare(
        "INSERT INTO document_versions (id, document_id, storage_path, source, version_number) VALUES (?, ?, ?, ?, ?)",
      ).run("version-embedding-override", "doc-embedding-override", "notes.txt", "upload", 1);
      db.prepare(
        "INSERT INTO document_index_files (id, document_id, version_id, status, chunk_count, text_bytes) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("index-embedding-override", "doc-embedding-override", "version-embedding-override", "ready", 2, 80);

      const chunks = [
        ["chunk-project-embed", "Project override semantic passage"],
        ["chunk-profile-embed", "Profile semantic passage"],
      ] as const;
      for (const [id, content] of chunks) {
        db.prepare(
          "INSERT INTO document_index_chunks (id, document_id, version_id, chunk_index, content, start_char, end_char, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id, "doc-embedding-override", "version-embedding-override", id === "chunk-project-embed" ? 0 : 1, content, 0, content.length, 4);
      }
      const insertVector = db.prepare(
        `
          INSERT INTO document_index_vectors (
            id, chunk_id, chunk_content_hash, provider, model_id, model,
            dimensions, normalized, embedding_blob, status
          ) VALUES (?, ?, ?, 'ollama', ?, ?, 2, 1, ?, 'ready')
        `,
      );
      insertVector.run(
        "vector-project-embed",
        "chunk-project-embed",
        crypto.createHash("sha256").update(chunks[0][1]).digest("hex"),
        "project-embed",
        "project-embed",
        vectorToBlob([1, 0]),
      );
      insertVector.run(
        "vector-profile-embed",
        "chunk-profile-embed",
        crypto.createHash("sha256").update(chunks[1][1]).digest("hex"),
        "profile-embed",
        "profile-embed",
        vectorToBlob([0, 1]),
      );

      setProjectEmbeddingModelOverride(projectId, "project-embed");
      assert.equal(readProjectEmbeddingModelOverride(projectId), "project-embed");
      assert.equal(
        resolveProjectEmbeddingSettings(userId, projectId).model,
        "project-embed",
      );

      const previousEnvironmentModel = process.env.DOCKET_EMBEDDING_MODEL;
      process.env.DOCKET_EMBEDDING_MODEL = "environment-embed";
      assert.equal(
        resolveProjectEmbeddingSettings(userId, projectId).model,
        "environment-embed",
      );
      if (previousEnvironmentModel === undefined) {
        delete process.env.DOCKET_EMBEDDING_MODEL;
      } else {
        process.env.DOCKET_EMBEDDING_MODEL = previousEnvironmentModel;
      }

      const semantic = getProjectSemanticIndexStatus(projectId, userId);
      assert.equal(semantic.active_model, "project-embed");
      assert.equal(semantic.override, "project-embed");
      assert.deepEqual(semantic.models, [
        { model: "profile-embed", dimensions: 2, ready: 1, total: 2 },
        { model: "project-embed", dimensions: 2, ready: 1, total: 2 },
      ]);

      setEmbeddingAdapterOverrideForTests({
        embedDocument: async () => [1, 0],
        embedQuery: async () => [1, 0],
      });
      try {
        const results = await searchProjectIndex({
          projectId,
          userId,
          query: "unrelated query",
        });
        assert.equal(results[0]?.chunk_id, "chunk-project-embed");
        assert.ok(results[0]?.match_reasons?.includes("semantic"));
      } finally {
        setEmbeddingAdapterOverrideForTests(null);
      }

      setProjectEmbeddingModelOverride(projectId, null);
      assert.equal(readProjectEmbeddingModelOverride(projectId), null);
      assert.equal(
        resolveProjectEmbeddingSettings(userId, projectId).model,
        "profile-embed",
      );
      assert.equal(
        resolveProjectEmbeddingSettings("no-profile", projectId).model,
        "batiai/qwen3-embedding:0.6b",
      );
    },
  );
});
