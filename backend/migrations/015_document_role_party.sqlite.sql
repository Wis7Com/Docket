-- Additive document classification used to distinguish substantive briefs from exhibits.
ALTER TABLE documents ADD COLUMN doc_role TEXT NOT NULL DEFAULT 'other'
  CHECK (doc_role IN ('brief','evidence','other'));

ALTER TABLE documents ADD COLUMN party_role TEXT;
ALTER TABLE documents ADD COLUMN party_side TEXT CHECK (party_side IN ('A','B'));
ALTER TABLE documents ADD COLUMN instance TEXT;
ALTER TABLE documents ADD COLUMN doc_role_confidence TEXT NOT NULL DEFAULT 'low'
  CHECK (doc_role_confidence IN ('high','low','manual'));

CREATE INDEX IF NOT EXISTS idx_documents_project_role
  ON documents(project_id, doc_role);
CREATE INDEX IF NOT EXISTS idx_documents_project_party_role
  ON documents(project_id, party_role);
CREATE INDEX IF NOT EXISTS idx_documents_project_party_side
  ON documents(project_id, party_side);
