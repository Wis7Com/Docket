-- Persisted issue-by-issue comparison matrices.
-- Rows are issues and columns are judge-defined sides; unlike tabular reviews,
-- neither axis is tied to a single document.
CREATE TABLE IF NOT EXISTS issue_matrices (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  title TEXT,
  scope TEXT NOT NULL DEFAULT '{"sides":[],"excluded_doc_ids":[]}',
  issues TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  shared_with TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_issue_matrices_project
  ON issue_matrices(project_id);
CREATE INDEX IF NOT EXISTS idx_issue_matrices_user
  ON issue_matrices(user_id);

CREATE TABLE IF NOT EXISTS issue_matrix_cells (
  id TEXT PRIMARY KEY,
  matrix_id TEXT NOT NULL REFERENCES issue_matrices(id) ON DELETE CASCADE,
  issue_index INTEGER NOT NULL,
  side_label TEXT NOT NULL,
  content TEXT,
  citations TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (matrix_id, issue_index, side_label)
);

CREATE INDEX IF NOT EXISTS idx_issue_matrix_cells_matrix
  ON issue_matrix_cells(matrix_id, issue_index, side_label);
