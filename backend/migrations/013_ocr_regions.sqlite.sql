CREATE TABLE document_ocr_regions (
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  region_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NOT NULL,
  bbox_x REAL NOT NULL,
  bbox_y REAL NOT NULL,
  bbox_width REAL NOT NULL,
  bbox_height REAL NOT NULL,
  PRIMARY KEY (document_id, version_id, page_number, region_index),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES document_versions(id) ON DELETE CASCADE
);

CREATE INDEX idx_document_ocr_regions_lookup
  ON document_ocr_regions(document_id, version_id, page_number);
