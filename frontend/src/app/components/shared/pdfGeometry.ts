import type { PdfAnnotationRect } from "./types";

export type ClientRectLike = {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
};

export type PdfGeometryPage = {
    pageNumber: number;
    wrapperRect: ClientRectLike;
    viewport: {
        convertToPdfPoint(x: number, y: number): number[];
    };
};

function isUsablePage(page: PdfGeometryPage | null | undefined): page is PdfGeometryPage {
    return !!page?.wrapperRect && !!page.viewport;
}

// Browsers report a client rect for every text node AND every fully-selected
// element in a Range. The pdf.js text layer is a span per text run, so a
// single drag yields stacks of duplicated/overlapping rects; painted with
// mix-blend-mode they look like several overlapping highlights. Merge rects
// that sit on the same text line into one rect per contiguous run, and return
// them in reading order (page, top line first, left to right).
export function mergePdfAnnotationRects(
    rects: PdfAnnotationRect[],
): PdfAnnotationRect[] {
    const byPage = new Map<number, PdfAnnotationRect[]>();
    for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        byPage.set(rect.page, [...(byPage.get(rect.page) ?? []), rect]);
    }

    const sameLine = (a: PdfAnnotationRect, b: PdfAnnotationRect) => {
        const overlap =
            Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        return overlap > 0.5 * Math.min(a.height, b.height);
    };

    const out: PdfAnnotationRect[] = [];
    for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
        const lines: PdfAnnotationRect[][] = [];
        for (const rect of byPage.get(page) ?? []) {
            const line = lines.find((entries) =>
                entries.some((other) => sameLine(rect, other)),
            );
            if (line) line.push(rect);
            else lines.push([rect]);
        }
        const lineTop = (line: PdfAnnotationRect[]) =>
            Math.max(...line.map((rect) => rect.y + rect.height));
        // PDF y grows upward, so the top line has the largest y extent.
        lines.sort((a, b) => lineTop(b) - lineTop(a));
        for (const line of lines) {
            line.sort((a, b) => a.x - b.x);
            let current = { ...line[0] };
            for (const rect of line.slice(1)) {
                const gapTolerance =
                    0.5 * Math.min(current.height, rect.height);
                if (rect.x <= current.x + current.width + gapTolerance) {
                    const right = Math.max(
                        current.x + current.width,
                        rect.x + rect.width,
                    );
                    const top = Math.max(
                        current.y + current.height,
                        rect.y + rect.height,
                    );
                    const y = Math.min(current.y, rect.y);
                    current = {
                        page,
                        x: current.x,
                        y,
                        width: right - current.x,
                        height: top - y,
                    };
                } else {
                    out.push(current);
                    current = { ...rect };
                }
            }
            out.push(current);
        }
    }
    return out;
}

export function clientRectsToPdfAnnotationRects(
    clientRects: ClientRectLike[],
    pages: (PdfGeometryPage | null | undefined)[],
): PdfAnnotationRect[] {
    const out: PdfAnnotationRect[] = [];
    for (const clientRect of clientRects) {
        if (clientRect.width <= 0 || clientRect.height <= 0) continue;
        for (const pageEntry of pages) {
            if (!isUsablePage(pageEntry)) continue;
            const wrapperRect = pageEntry.wrapperRect;
            const intersects =
                clientRect.right > wrapperRect.left &&
                clientRect.left < wrapperRect.right &&
                clientRect.bottom > wrapperRect.top &&
                clientRect.top < wrapperRect.bottom;
            if (!intersects) continue;
            const left = Math.max(clientRect.left, wrapperRect.left);
            const right = Math.min(clientRect.right, wrapperRect.right);
            const top = Math.max(clientRect.top, wrapperRect.top);
            const bottom = Math.min(clientRect.bottom, wrapperRect.bottom);
            const relLeft = left - wrapperRect.left;
            const relTop = top - wrapperRect.top;
            const relRight = right - wrapperRect.left;
            const relBottom = bottom - wrapperRect.top;
            const [x1 = 0, y1 = 0] = pageEntry.viewport.convertToPdfPoint(
                relLeft,
                relTop,
            );
            const [x2 = 0, y2 = 0] = pageEntry.viewport.convertToPdfPoint(
                relRight,
                relBottom,
            );
            out.push({
                page: pageEntry.pageNumber,
                x: Math.min(x1, x2),
                y: Math.min(y1, y2),
                width: Math.abs(x2 - x1),
                height: Math.abs(y2 - y1),
            });
            break;
        }
    }
    return out.filter((r) => r.width > 0 && r.height > 0);
}
