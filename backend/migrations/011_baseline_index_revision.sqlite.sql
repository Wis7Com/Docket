-- Deterministic baseline index identity.
--
-- document_versions are normally immutable, but tracked-change resolution and
-- same-turn assistant edits can overwrite the active storage object in place.
-- A monotonic content revision makes those changes visible to DB-only index
-- reconciliation. The index schema version invalidates derived chunk metadata
-- when deterministic extraction rules change.

ALTER TABLE document_versions
  ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE document_index_files
  ADD COLUMN indexed_content_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE document_index_files
  ADD COLUMN index_schema_version INTEGER NOT NULL DEFAULT 0;
