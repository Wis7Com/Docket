-- Project document retrieval index.
--
-- document_index_files tracks indexing state per concrete document version.
-- document_index_chunks stores normalized chunk text and metadata. The FTS
-- table mirrors chunk rows for fast lexical search.

CREATE TABLE IF NOT EXISTS document_index_files (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','indexing','ready','error','cancelled')),
  error_message TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  text_bytes INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, version_id)
);

CREATE INDEX IF NOT EXISTS idx_document_index_files_document_version
  ON document_index_files(document_id, version_id);

CREATE INDEX IF NOT EXISTS idx_document_index_files_status
  ON document_index_files(status, updated_at);

CREATE TABLE IF NOT EXISTS document_index_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  page_number INTEGER,
  section_path TEXT,
  content TEXT NOT NULL,
  start_char INTEGER NOT NULL DEFAULT 0,
  end_char INTEGER NOT NULL DEFAULT 0,
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, version_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_document_index_chunks_document_version
  ON document_index_chunks(document_id, version_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_document_index_chunks_page
  ON document_index_chunks(document_id, version_id, page_number);

CREATE VIRTUAL TABLE IF NOT EXISTS document_index_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  version_id UNINDEXED,
  content,
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS document_index_vectors (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES document_index_chunks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chunk_id, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_document_index_vectors_chunk
  ON document_index_vectors(chunk_id);
