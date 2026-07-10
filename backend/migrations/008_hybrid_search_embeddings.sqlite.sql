-- Docufinder-style hybrid search additions.
--
-- Keep lexical search independent from semantic indexing: the trigram table is
-- populated with chunks immediately, while vector rows can remain pending or
-- error without blocking document search.

ALTER TABLE user_profiles ADD COLUMN embedding_provider TEXT NOT NULL DEFAULT 'ollama';
ALTER TABLE user_profiles ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'batiai/qwen3-embedding:0.6b';
ALTER TABLE user_profiles ADD COLUMN embedding_base_url TEXT;
ALTER TABLE user_profiles ADD COLUMN embedding_api_key TEXT;
ALTER TABLE user_profiles ADD COLUMN embedding_dimensions_policy TEXT NOT NULL DEFAULT 'truncate-to-256'
  CHECK (embedding_dimensions_policy IN ('native','truncate-to-256','truncate-to-512','provider'));
ALTER TABLE user_profiles ADD COLUMN embedding_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_profiles ADD COLUMN embedding_memory_profile TEXT NOT NULL DEFAULT 'lightweight'
  CHECK (embedding_memory_profile IN ('lightweight','balanced','performance'));
ALTER TABLE user_profiles ADD COLUMN chat_full_read_max_docs INTEGER NOT NULL DEFAULT 20;
ALTER TABLE user_profiles ADD COLUMN chat_full_read_max_text_bytes INTEGER NOT NULL DEFAULT 300000;
ALTER TABLE user_profiles ADD COLUMN chat_fetch_max_docs INTEGER NOT NULL DEFAULT 3;
ALTER TABLE user_profiles ADD COLUMN chat_fetch_max_text_bytes INTEGER NOT NULL DEFAULT 300000;

CREATE VIRTUAL TABLE IF NOT EXISTS document_index_chunks_fts_trigram USING fts5(
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  version_id UNINDEXED,
  content,
  tokenize='trigram case_sensitive 0'
);

INSERT INTO document_index_chunks_fts_trigram (
  chunk_id, document_id, version_id, content
)
SELECT id, document_id, version_id, content
FROM document_index_chunks
WHERE id NOT IN (
  SELECT chunk_id FROM document_index_chunks_fts_trigram
);

ALTER TABLE document_index_vectors RENAME TO document_index_vectors_legacy;

CREATE TABLE document_index_vectors (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES document_index_chunks(id) ON DELETE CASCADE,
  chunk_content_hash TEXT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL DEFAULT 0,
  normalized INTEGER NOT NULL DEFAULT 0,
  embedding_blob BLOB,
  embedding_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','embedding','ready','error')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chunk_id, provider, model_id, dimensions)
);

INSERT OR IGNORE INTO document_index_vectors (
  id, chunk_id, chunk_content_hash, provider, model_id, model, dimensions,
  normalized, embedding_json, status, created_at, updated_at
)
SELECT
  id, chunk_id, NULL, provider, model, model, dimensions,
  0, embedding_json, 'ready', created_at, created_at
FROM document_index_vectors_legacy;

DROP TABLE document_index_vectors_legacy;

CREATE INDEX IF NOT EXISTS idx_document_index_vectors_chunk
  ON document_index_vectors(chunk_id);

CREATE INDEX IF NOT EXISTS idx_document_index_vectors_lookup
  ON document_index_vectors(provider, model_id, dimensions, status);

CREATE INDEX IF NOT EXISTS idx_document_index_vectors_status
  ON document_index_vectors(status, updated_at);
