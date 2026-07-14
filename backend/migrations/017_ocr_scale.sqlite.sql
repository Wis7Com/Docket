-- Project-specific OCR cap. NULL inherits, 0 means unlimited, positive values cap pages.
ALTER TABLE projects ADD COLUMN ocr_max_pages_override INTEGER;

-- Preserve scan coverage so partial OCR is visible instead of silently omitted.
ALTER TABLE document_index_files ADD COLUMN ocr_scanned_pages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_index_files ADD COLUMN ocr_truncated INTEGER NOT NULL DEFAULT 0;
