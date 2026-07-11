ALTER TABLE user_profiles ADD COLUMN ocr_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_profiles ADD COLUMN ocr_mode TEXT NOT NULL DEFAULT 'local_cpu'
  CHECK (ocr_mode IN ('local_cpu','local_gpu','external_api'));
ALTER TABLE user_profiles ADD COLUMN ocr_engine TEXT NOT NULL DEFAULT 'auto'
  CHECK (ocr_engine IN ('auto','vision','paddle'));
ALTER TABLE user_profiles ADD COLUMN ocr_languages TEXT NOT NULL DEFAULT 'auto'
  CHECK (ocr_languages IN ('auto','korean+english','english'));
ALTER TABLE user_profiles ADD COLUMN ocr_max_pages_per_doc INTEGER NOT NULL DEFAULT 50
  CHECK (ocr_max_pages_per_doc > 0);
ALTER TABLE user_profiles ADD COLUMN ocr_gpu_endpoint TEXT;
ALTER TABLE user_profiles ADD COLUMN ocr_external_provider TEXT;

ALTER TABLE document_index_files ADD COLUMN ocr_pages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_index_files ADD COLUMN ocr_engine TEXT;
