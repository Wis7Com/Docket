CREATE TABLE IF NOT EXISTS pdf_annotation_export_state (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 1,
  last_exported_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (document_id, version_id, user_id)
);

CREATE INDEX IF NOT EXISTS pdf_annotation_export_state_user_dirty_idx
  ON pdf_annotation_export_state(user_id, dirty, updated_at);
