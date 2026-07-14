-- Validated map-stage summaries are reusable across process restarts.
CREATE TABLE IF NOT EXISTS document_summary_batches (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  batch_key TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  model TEXT NOT NULL,
  content_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (document_id, version_id, batch_key)
);

CREATE INDEX IF NOT EXISTS idx_document_summary_batches_version
  ON document_summary_batches(document_id, version_id);
