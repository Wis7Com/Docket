import type { PdfAnnotation } from "./types";

type ViewportLike = {
    convertToViewportRectangle(rect: number[]): number[];
};

export type PdfAnnotationOverlayItem = {
    annotationId: string;
    annotationType: PdfAnnotation["annotation_type"];
    pageNumber: number;
    rectIndex: number;
    isFirstRect: boolean;
    isLastRect: boolean;
    title: string;
    marker: {
        left: number;
        top: number;
        width: number;
        height: number;
        border: string;
        background: string;
        opacity: string;
        mixBlendMode: string;
    };
    note: null | {
        text: string;
        left: number;
        top: number;
        anchorLeft: number;
        anchorTop: number;
        border: string;
        connectorColor: string;
    };
};

function readNotePosition(
    annotation: PdfAnnotation,
): { page: number; x: number; y: number } | null {
    const value = annotation.source_citation?.note_position;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const raw = value as Record<string, unknown>;
    if (
        typeof raw.page !== "number" ||
        typeof raw.x !== "number" ||
        typeof raw.y !== "number"
    ) {
        return null;
    }
    return { page: raw.page, x: raw.x, y: raw.y };
}

function annotationPaintOrder(annotationType: PdfAnnotation["annotation_type"]) {
    return annotationType === "comment" ? 0 : 1;
}

export function buildPdfAnnotationOverlayItems(
    annotations: PdfAnnotation[],
    pageNumber: number,
    viewport: ViewportLike,
): PdfAnnotationOverlayItem[] {
    const items: PdfAnnotationOverlayItem[] = [];
    const orderedAnnotations = [...annotations].sort(
        (a, b) =>
            annotationPaintOrder(a.annotation_type) -
            annotationPaintOrder(b.annotation_type),
    );
    for (const ann of orderedAnnotations) {
        const pageRects = ann.rects
            .map((rect, rectIndex) => ({ rect, rectIndex }))
            .filter(({ rect }) => rect.page === pageNumber);

        for (
            let pageRectIndex = 0;
            pageRectIndex < pageRects.length;
            pageRectIndex++
        ) {
            const { rect, rectIndex } = pageRects[pageRectIndex];
            const [left, top, right, bottom] =
                viewport.convertToViewportRectangle([
                    rect.x,
                    rect.y,
                    rect.x + rect.width,
                    rect.y + rect.height,
                ]);
            const x = Math.min(left ?? 0, right ?? 0);
            const y = Math.min(top ?? 0, bottom ?? 0);
            const width = Math.max(2, Math.abs((right ?? 0) - (left ?? 0)));
            const height = Math.max(2, Math.abs((bottom ?? 0) - (top ?? 0)));
            const isComment = ann.annotation_type === "comment";
            const notePosition = readNotePosition(ann);
            const noteViewport =
                notePosition?.page === pageNumber
                    ? viewport.convertToViewportRectangle([
                          notePosition.x,
                          notePosition.y,
                          notePosition.x,
                          notePosition.y,
                      ])
                    : null;
            const noteLeft = noteViewport
                ? Math.min(noteViewport[0] ?? 0, noteViewport[2] ?? 0)
                : x;
            const noteTop = noteViewport
                ? Math.min(noteViewport[1] ?? 0, noteViewport[3] ?? 0)
                : Math.max(0, y - 28);
            items.push({
                annotationId: ann.id,
                annotationType: ann.annotation_type,
                pageNumber,
                rectIndex,
                isFirstRect: rectIndex === 0,
                isLastRect: rectIndex === ann.rects.length - 1,
                title: ann.comment || ann.quote || "Saved annotation",
                marker: {
                    left: x,
                    top: y,
                    width,
                    height,
                    border: isComment
                        ? `1.5px dashed ${ann.color}`
                        : "0",
                    background: isComment ? "transparent" : ann.color,
                    opacity: isComment ? "1" : "0.42",
                    mixBlendMode: isComment ? "normal" : "multiply",
                },
                note:
                    isComment && ann.comment && pageRectIndex === 0
                        ? {
                              text: ann.comment,
                              left: noteLeft,
                              top: noteTop,
                              anchorLeft: x + Math.min(width, 12),
                              anchorTop: y + height / 2,
                              border: `1px solid ${ann.color}`,
                              connectorColor: ann.color,
                          }
                        : null,
            });
        }
    }
    return items;
}
