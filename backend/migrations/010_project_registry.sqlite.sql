-- Local-first app/project split support.
--
-- App DB uses projects as a lightweight registry. Project DBs use the same
-- projects table for the single project row, while project data lives beside it.

ALTER TABLE projects ADD COLUMN path TEXT;
ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'available';
ALTER TABLE projects ADD COLUMN last_opened_at TEXT;
ALTER TABLE projects ADD COLUMN document_count_cache INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN chat_count_cache INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN review_count_cache INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_path ON projects(path);

ALTER TABLE document_versions ADD COLUMN original_path TEXT;
ALTER TABLE document_versions ADD COLUMN imported_at TEXT;
ALTER TABLE document_versions ADD COLUMN content_hash TEXT;
