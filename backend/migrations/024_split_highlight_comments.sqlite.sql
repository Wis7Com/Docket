INSERT INTO pdf_annotations (
  id,
  document_id,
  version_id,
  user_id,
  page_number,
  annotation_type,
  color,
  quote,
  comment,
  rects_json,
  source,
  source_citation_json,
  created_at,
  updated_at
)
SELECT
  'split-comment-' || id,
  document_id,
  version_id,
  user_id,
  page_number,
  'comment',
  color,
  quote,
  comment,
  rects_json,
  'user',
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM pdf_annotations
WHERE annotation_type = 'highlight'
  AND comment IS NOT NULL
  AND trim(comment) != ''
  AND deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM pdf_annotations AS existing
    WHERE existing.id = 'split-comment-' || pdf_annotations.id
  );

UPDATE pdf_annotations
SET comment = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE annotation_type = 'highlight'
  AND comment IS NOT NULL
  AND trim(comment) != ''
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM pdf_annotations AS split
    WHERE split.id = 'split-comment-' || pdf_annotations.id
      AND split.annotation_type = 'comment'
      AND split.document_id = pdf_annotations.document_id
      AND split.version_id IS pdf_annotations.version_id
      AND split.user_id = pdf_annotations.user_id
      AND split.page_number = pdf_annotations.page_number
      AND split.color = pdf_annotations.color
      AND split.quote IS pdf_annotations.quote
      AND split.comment = pdf_annotations.comment
      AND split.rects_json = pdf_annotations.rects_json
      AND split.source = 'user'
      AND split.source_citation_json IS NULL
  );
