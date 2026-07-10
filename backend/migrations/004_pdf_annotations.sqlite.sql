CREATE TABLE IF NOT EXISTS pdf_annotations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  annotation_type TEXT NOT NULL CHECK (annotation_type IN ('highlight','comment')),
  color TEXT NOT NULL DEFAULT '#ffe066',
  quote TEXT,
  comment TEXT,
  rects_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','citation_promotion')),
  source_citation_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS pdf_annotations_doc_version_user_idx
  ON pdf_annotations(document_id, version_id, user_id, created_at);

CREATE INDEX IF NOT EXISTS pdf_annotations_document_idx
  ON pdf_annotations(document_id, created_at);
