CREATE TABLE IF NOT EXISTS tabular_review_documents (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL REFERENCES tabular_reviews(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (review_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_tabular_review_documents_document
    ON tabular_review_documents(document_id);

INSERT OR IGNORE INTO tabular_review_documents (id, review_id, document_id)
SELECT lower(hex(randomblob(16))), cells.review_id, cells.document_id
FROM tabular_cells AS cells
JOIN tabular_reviews AS reviews ON reviews.id = cells.review_id
WHERE reviews.project_id IS NOT NULL;
