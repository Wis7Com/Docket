CREATE TABLE IF NOT EXISTS project_color_legend (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  color_family TEXT NOT NULL
    CHECK (color_family IN ('red','orange','yellow','green','blue','purple','pink','gray')),
  label TEXT NOT NULL,
  party_role TEXT,
  party_side TEXT CHECK (party_side IN ('A','B')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, color_family)
);

CREATE INDEX IF NOT EXISTS idx_project_color_legend_project
  ON project_color_legend(project_id);
