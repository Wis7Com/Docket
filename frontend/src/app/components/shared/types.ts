// Shared TypeScript types for Docket AI legal assistant

export interface DocketFolder {
    id: string;
    project_id: string;
    user_id: string;
    name: string;
    parent_folder_id: string | null;
    created_at: string;
    updated_at: string;
}

export interface DocketProject {
    id: string;
    user_id: string;
    is_owner?: boolean;
    name: string;
    cm_number: string | null;
    shared_with: string[];
    path?: string;
    created_at: string;
    updated_at: string;
    documents?: DocketDocument[];
    folders?: DocketFolder[];
    document_count?: number;
    chat_count?: number;
    review_count?: number;
}

export interface DocketDocument {
    id: string;
    user_id?: string;
    project_id: string | null;
    folder_id?: string | null;
    filename: string;
    file_type: string | null; // pdf | docx | doc | txt | md | image formats
    storage_path: string | null;
    pdf_storage_path: string | null;
    size_bytes: number | null;
    page_count: number | null;
    structure_tree: StructureNode[] | null;
    status: "pending" | "processing" | "ready" | "error";
    created_at: string | null;
    updated_at?: string | null;
    current_version_id?: string | null;
    /** Max version_number across assistant_edit rows, null if doc is unedited. */
    latest_version_number?: number | null;
    doc_role?: "brief" | "evidence" | "other";
    doc_role_confidence?: "high" | "low" | "manual";
    party_role?: string | null;
    party_side?: "A" | "B" | null;
    instance?: string | null;
}

export interface StructureNode {
    id: string;
    title: string;
    level: number;
    page_number: number | null;
    children: StructureNode[];
}

export interface DocketChat {
    id: string;
    project_id: string | null;
    user_id: string;
    title: string | null;
    created_at: string;
}

export interface DocketEditAnnotation {
    type?: "edit_data";
    kind?: "edit";
    edit_id: string;
    document_id: string;
    version_id: string;
    /** Per-document monotonic Vn for the edit's target version. */
    version_number?: number | null;
    change_id: string;
    del_w_id?: string;
    ins_w_id?: string;
    deleted_text: string;
    inserted_text: string;
    context_before?: string;
    context_after?: string;
    reason?: string;
    status: "pending" | "accepted" | "rejected";
}

export type AssistantEvent =
    | { type: "reasoning"; text: string; isStreaming?: boolean }
    | {
          type: "tool_call_start";
          name: string;
          isStreaming?: boolean;
      }
    | { type: "thinking"; isStreaming?: boolean }
    | {
          type: "doc_read";
          filename: string;
          document_id?: string;
          isStreaming?: boolean;
      }
    | {
          type: "doc_summary";
          filename: string;
          document_id?: string;
          completed_batches: number;
          total_batches: number;
          coverage?: {
              pageCount: number;
              indexedPageRanges: { start: number; end: number }[];
              indexedChunkCount: number;
              processedChunkCount: number;
              batchCount: number;
              complete: boolean;
              warnings: { code: string; message: string }[];
          };
          isStreaming?: boolean;
      }
    | {
          type: "doc_find";
          filename: string;
          query: string;
          total_matches: number;
          isStreaming?: boolean;
      }
    | {
          type: "doc_created";
          filename: string;
          download_url: string;
          /** Set when the generated doc is persisted as a first-class document. */
          document_id?: string;
          version_id?: string;
          version_number?: number | null;
          isStreaming?: boolean;
      }
    | { type: "doc_download"; filename: string; download_url: string }
    | {
          type: "doc_replicated";
          /** Source document filename. */
          filename: string;
          /** How many copies were produced in this single tool call. */
          count: number;
          /** One entry per new copy. Empty while streaming. */
          copies?: {
              new_filename: string;
              document_id: string;
              version_id: string;
          }[];
          error?: string;
          isStreaming?: boolean;
      }
    | { type: "workflow_applied"; workflow_id: string; title: string }
    | {
          type: "doc_edited";
          filename: string;
          document_id: string;
          version_id: string;
          /** Per-document monotonic Vn written at emit time. */
          version_number?: number | null;
          download_url: string;
          annotations: DocketEditAnnotation[];
          error?: string;
          isStreaming?: boolean;
      }
    | { type: "content"; text: string; isStreaming?: boolean };

export interface DocketMessage {
    role: "user" | "assistant";
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
    /** Function tools disabled for this chat session's submitted turn. */
    disabled_tools?: string[];
    model?: string;
    annotations?: DocketCitationAnnotation[];
    events?: AssistantEvent[];
    /** Set when streaming failed; rendered as a red error block. */
    error?: string;
}

export interface CitationQuote {
    /**
     * 1-based PDF page hint. Optional: DOCX/DOC/TXT have no `[Page N]`
     * markers, so citations from those formats arrive without a usable page.
     * Text-based viewers (DocxView) ignore it and the PDF viewer falls back
     * to scanning all pages when it is absent.
     */
    page?: number;
    quote: string;
    citation?: DocketCitationAnnotation;
}

export interface PdfAnnotationRect {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PdfAnnotationNotePosition {
    page: number;
    x: number;
    y: number;
}

export interface PdfAnnotation {
    id: string;
    document_id: string;
    version_id: string | null;
    user_id: string;
    page_number: number;
    annotation_type: "highlight" | "comment";
    color: string;
    quote: string | null;
    comment: string | null;
    rects: PdfAnnotationRect[];
    source: "user" | "citation_promotion";
    source_citation: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
}

export type AnnotationColorFamily =
    "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "gray";

export interface ProjectAnnotation {
    id: string;
    document_id: string;
    version_id: string | null;
    filename: string;
    folder_path: string | null;
    page_number: number;
    annotation_type: "highlight" | "comment";
    color: string | null;
    color_family: AnnotationColorFamily | null;
    quote: string | null;
    comment: string | null;
    source: string | null;
    created_at: string;
}

export interface ProjectAnnotationsResponse {
    annotations: ProjectAnnotation[];
    total: number;
    returned: number;
    next_offset: number | null;
    project_total: number;
    group_counts: {
        by_color_family: Array<{
            color_family: AnnotationColorFamily | null;
            count: number;
        }>;
        by_document: Array<{
            document_id: string;
            filename: string;
            count: number;
        }>;
    };
    applied_filters: Record<string, unknown>;
    warnings: string[];
}

/**
 * A citation emitted by the assistant. Single-page citations have a numeric
 * `page` and a plain `quote`. A citation that spans a page break (one
 * continuous sentence cut by a page boundary) has `page` as a range string
 * like "41-42" and a `quote` containing the `[[PAGE_BREAK]]` sentinel at the
 * break point (text before is on page 41, text after is on page 42).
 */
export interface DocketCitationAnnotation {
    type: "citation_data";
    ref: number;
    doc_id: string;
    document_id: string;
    version_id?: string | null;
    version_number?: number | null;
    filename: string;
    page: number | string;
    quote: string;
    /** Verified indexed source provenance, when this citation came from search. */
    chunk_id?: string;
    quote_start?: number;
    quote_end?: number;
}

const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";

/**
 * Expand a citation into one or more (page, quote) entries suitable for
 * highlighting in the PDF viewer. A single-page citation yields one entry; a
 * cross-page citation with page "N-M" and a `[[PAGE_BREAK]]` split yields two.
 */
export function expandCitationToEntries(
    a: DocketCitationAnnotation,
): CitationQuote[] {
    const rangeMatch =
        typeof a.page === "string" ? a.page.match(/^(\d+)\s*-\s*(\d+)$/) : null;
    if (rangeMatch && a.quote.includes(PAGE_BREAK_SENTINEL)) {
        const startPage = parseInt(rangeMatch[1], 10);
        const endPage = parseInt(rangeMatch[2], 10);
        const [before, after] = a.quote.split(PAGE_BREAK_SENTINEL);
        return [
            { page: startPage, quote: before.trim(), citation: a },
            { page: endPage, quote: after.trim(), citation: a },
        ].filter((e) => e.quote.length > 0);
    }
    const pageNum =
        typeof a.page === "number" ? a.page : parseInt(String(a.page), 10);
    if (!Number.isFinite(pageNum)) {
        // No usable page hint — common for DOCX/DOC/TXT, which have no
        // `[Page N]` markers for the model to anchor against. Still return
        // the quote (without a page) so text-based viewers can highlight it
        // and the PDF viewer can scan all pages, rather than dropping the
        // highlight entirely.
        const quote = a.quote?.trim();
        return quote ? [{ quote: a.quote, citation: a }] : [];
    }
    return [{ page: pageNum, quote: a.quote, citation: a }];
}

/** Format the page(s) of a citation for display, e.g. "Page 3" or "Page 41-42". */
export function formatCitationPage(a: DocketCitationAnnotation): string {
    if (typeof a.page === "string") return `Page ${a.page}`;
    return `Page ${a.page}`;
}

/** Produce a reader-friendly version of the quote (replaces [[PAGE_BREAK]] with "..."). */
export function displayCitationQuote(a: DocketCitationAnnotation): string {
    return a.quote.replaceAll(PAGE_BREAK_SENTINEL, "...");
}

// Tabular Review

export type ColumnFormat =
    | "text"
    | "bulleted_list"
    | "number"
    | "currency"
    | "yes_no"
    | "date"
    | "tag"
    | "percentage"
    | "monetary_amount";

export interface ColumnConfig {
    index: number;
    name: string;
    prompt: string;
    format?: ColumnFormat;
    tags?: string[];
}

export interface TabularReview {
    id: string;
    project_id: string | null;
    user_id: string;
    title: string | null;
    columns_config: ColumnConfig[] | null;
    workflow_id: string | null;
    practice?: string | null;
    /** Per-review email list. Used so standalone (project_id null) reviews can be shared directly. */
    shared_with?: string[];
    /** Server-set: true when the requesting user is the review's creator. */
    is_owner?: boolean;
    created_at: string;
    updated_at: string;
    document_count?: number;
}

export interface TabularCell {
    id: string;
    review_id: string;
    document_id: string;
    column_index: number;
    content: {
        summary: string;
        flag?: "green" | "grey" | "yellow" | "red";
        reasoning?: string;
    } | null;
    status: "pending" | "generating" | "done" | "error";
    created_at: string;
}

// Workflows

export interface DocketWorkflow {
    id: string;
    user_id: string | null;
    title: string;
    type: "assistant" | "tabular";
    prompt_md: string | null;
    columns_config: ColumnConfig[] | null;
    is_system: boolean;
    created_at: string;
    practice?: string | null;
    shared_by_name?: string | null;
    allow_edit?: boolean;
    is_owner?: boolean;
}

// API helpers

export interface DocketChatDetailOut {
    chat: DocketChat;
    messages: DocketMessage[];
}

export interface TabularReviewDetailOut {
    review: TabularReview;
    cells: TabularCell[];
    documents: DocketDocument[];
}
