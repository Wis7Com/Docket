import type {
    DocketCitationAnnotation,
    PdfAnnotationRect,
} from "./types";

export type PdfAnnotationCreatePayload = {
    version_id?: string | null;
    page_number: number;
    annotation_type: "highlight" | "comment";
    color: string;
    quote?: string | null;
    comment?: string | null;
    rects: PdfAnnotationRect[];
    source?: "user" | "citation_promotion";
    source_citation?: Record<string, unknown> | null;
};

export type TemporaryCitationHighlight = {
    quote: string;
    citation?: DocketCitationAnnotation;
};

export function buildPdfAnnotationCreatePayload(args: {
    rects: PdfAnnotationRect[];
    annotationType: "highlight" | "comment";
    color: string;
    displayVersionId?: string | null;
    documentVersionId?: string | null;
    quote?: string | null;
    comment?: string | null;
    source?: "user" | "citation_promotion";
    sourceCitation?: Record<string, unknown> | null;
}): PdfAnnotationCreatePayload | null {
    if (args.rects.length === 0) return null;

    return {
        version_id: args.displayVersionId ?? args.documentVersionId ?? null,
        page_number: args.rects[0].page,
        annotation_type: args.annotationType,
        color: args.color,
        quote: args.quote ?? null,
        comment: args.comment ?? null,
        rects: args.rects,
        source: args.source ?? "user",
        source_citation: args.sourceCitation ?? null,
    };
}

export function buildCitationPromotionCreatePayload(args: {
    rects: PdfAnnotationRect[];
    quoteList: TemporaryCitationHighlight[];
    color: string;
    displayVersionId?: string | null;
    documentVersionId?: string | null;
}): PdfAnnotationCreatePayload | null {
    const firstCitation = args.quoteList.find((q) => q.citation)?.citation;
    return buildPdfAnnotationCreatePayload({
        rects: args.rects,
        annotationType: "highlight",
        color: args.color,
        displayVersionId: args.displayVersionId,
        documentVersionId: args.documentVersionId,
        quote: args.quoteList.map((q) => q.quote).join("\n\n"),
        source: "citation_promotion",
        sourceCitation: firstCitation
            ? (firstCitation as unknown as Record<string, unknown>)
            : null,
    });
}
