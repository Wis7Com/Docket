-- Optional ordering hint for successive briefs from the same party side.
ALTER TABLE documents ADD COLUMN brief_sequence INTEGER
  CHECK (
    brief_sequence IS NULL OR
    (typeof(brief_sequence) = 'integer' AND brief_sequence > 0)
  );

CREATE INDEX IF NOT EXISTS idx_documents_project_party_side_brief_sequence
  ON documents(project_id, party_side, brief_sequence);
