export const SMALL_CORPUS_MAX_TEXT_BYTES = 300_000;
export const SMALL_CORPUS_MAX_DOCS = 20;
export const FULL_READ_MAX_DOCS = 3;
export const FULL_READ_MAX_TEXT_BYTES = 300_000;
export const RETRIEVAL_TOP_K = 8;
export const SNIPPET_TOKEN_WINDOW = 64;
export const NEIGHBOR_CHUNK_RADIUS = 1;
export const INDEX_CHUNK_SIZE = 600;
export const INDEX_CHUNK_OVERLAP = 150;

export const INDEX_STATUSES = [
  "pending",
  "indexing",
  "ready",
  "error",
  "cancelled",
] as const;

export type IndexStatus = (typeof INDEX_STATUSES)[number];

export type ExtractedChunk = {
  chunk_index: number;
  page_number: number | null;
  section_path: string | null;
  /**
   * Derived lexical text for FTS/trigram indexing. `content` remains the
   * unadorned evidence text used for quotes and citations.
   */
  search_text: string;
  content: string;
  start_char: number;
  end_char: number;
  token_count: number;
};

export type StructuredTextLine = {
  page_number: number | null;
  line_index: number;
  text: string;
  start_char: number;
  end_char: number;
  font_size: number | null;
  bold: boolean;
};

export type DocumentSectionAnchor = {
  page_number: number | null;
  start_char: number;
  end_char: number;
  level: number;
  title: string;
  path: string;
};

export type StructuredIndexText = {
  text: string;
  lines: StructuredTextLine[];
  sections: DocumentSectionAnchor[];
  ocr_pages?: number;
  ocr_engine?: string | null;
  ocr_regions?: IndexedOcrRegion[];
};

export type IndexedOcrRegion = {
  page_number: number;
  text: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
};

export type ExtractedDocument = {
  document_id: string;
  version_id: string;
  filename: string;
  file_type: string;
  text: string;
  chunks: ExtractedChunk[];
  ocr_pages: number;
  ocr_engine: string | null;
  ocr_regions: IndexedOcrRegion[];
};

export type SearchResult = {
  document_id: string;
  version_id: string;
  chunk_id: string;
  filename: string;
  file_type: string | null;
  chunk_index: number;
  page_number: number | null;
  page_end: number | null;
  location_hint: string | null;
  quote: string;
  snippet: string;
  content: string;
  score: number;
  rank_score?: number;
  lexical_score?: number | null;
  semantic_score?: number | null;
  match_reasons?: (
    | "exact"
    | "keyword"
    | "substring"
    | "semantic"
    | "filename"
    | "basic"
  )[];
  grouped_chunk_count?: number;
  basic_match: boolean;
};
