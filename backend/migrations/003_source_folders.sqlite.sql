CREATE TABLE IF NOT EXISTS source_folders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  root_path TEXT NOT NULL,
  display_name TEXT,
  last_scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS source_folders_project_idx ON source_folders(project_id);

CREATE TABLE IF NOT EXISTS linked_source_files (
  id TEXT PRIMARY KEY,
  source_folder_id TEXT NOT NULL REFERENCES source_folders(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_folder_id, relative_path)
);

CREATE INDEX IF NOT EXISTS linked_source_files_folder_idx ON linked_source_files(source_folder_id);
CREATE INDEX IF NOT EXISTS linked_source_files_document_idx ON linked_source_files(document_id);
