import test from "node:test";
import assert from "node:assert/strict";
import {
    clientRectsToPdfAnnotationRects,
    mergePdfAnnotationRects,
    type ClientRectLike,
    type PdfGeometryPage,
} from "./pdfGeometry";

test("clientRectsToPdfAnnotationRects clips selections to the intersected PDF page", () => {
    const pages = [
        makePage(1, { left: 100, top: 50, right: 700, bottom: 850 }),
        makePage(2, { left: 100, top: 900, right: 700, bottom: 1700 }),
    ];

    const rects = clientRectsToPdfAnnotationRects(
        [
            makeRect({ left: 90, top: 70, right: 180, bottom: 110 }),
            makeRect({ left: 140, top: 920, right: 260, bottom: 960 }),
            makeRect({ left: 10, top: 10, right: 10, bottom: 20 }),
            makeRect({ left: 10, top: 10, right: 20, bottom: 20 }),
        ],
        pages,
    );

    assert.deepEqual(rects, [
        { page: 1, x: 0, y: 740, width: 80, height: 40 },
        { page: 2, x: 40, y: 740, width: 120, height: 40 },
    ]);
});

test("clientRectsToPdfAnnotationRects skips pages that have not rendered yet", () => {
    const rects = clientRectsToPdfAnnotationRects(
        [makeRect({ left: 140, top: 920, right: 260, bottom: 960 })],
        [
            undefined,
            makePage(2, { left: 100, top: 900, right: 700, bottom: 1700 }),
        ],
    );

    assert.deepEqual(rects, [
        { page: 2, x: 40, y: 740, width: 120, height: 40 },
    ]);
});

test("mergePdfAnnotationRects collapses duplicated and contained selection rects", () => {
    // A browser Range reports both the span element rect and its text node
    // rect — one drag yields overlapping duplicates.
    const merged = mergePdfAnnotationRects([
        { page: 1, x: 10, y: 700, width: 200, height: 12 },
        { page: 1, x: 10, y: 700, width: 200, height: 12 },
        { page: 1, x: 40, y: 701, width: 80, height: 10 },
    ]);

    assert.deepEqual(merged, [
        { page: 1, x: 10, y: 700, width: 200, height: 12 },
    ]);
});

test("mergePdfAnnotationRects joins touching same-line runs but keeps lines apart", () => {
    const merged = mergePdfAnnotationRects([
        // Second (lower) line, listed first to prove reading-order sorting.
        { page: 1, x: 10, y: 684, width: 90, height: 12 },
        // Top line: two adjacent text runs.
        { page: 1, x: 10, y: 700, width: 100, height: 12 },
        { page: 1, x: 111, y: 700, width: 60, height: 12 },
    ]);

    assert.deepEqual(merged, [
        { page: 1, x: 10, y: 700, width: 161, height: 12 },
        { page: 1, x: 10, y: 684, width: 90, height: 12 },
    ]);
});

test("mergePdfAnnotationRects keeps distant same-line rects and pages separate", () => {
    const merged = mergePdfAnnotationRects([
        { page: 1, x: 10, y: 700, width: 40, height: 12 },
        // Same line but far away (e.g. another column) — must not bridge.
        { page: 1, x: 300, y: 700, width: 40, height: 12 },
        { page: 2, x: 10, y: 700, width: 40, height: 12 },
    ]);

    assert.deepEqual(merged, [
        { page: 1, x: 10, y: 700, width: 40, height: 12 },
        { page: 1, x: 300, y: 700, width: 40, height: 12 },
        { page: 2, x: 10, y: 700, width: 40, height: 12 },
    ]);
});

function makePage(
    pageNumber: number,
    wrapperRect: { left: number; top: number; right: number; bottom: number },
): PdfGeometryPage {
    return {
        pageNumber,
        wrapperRect: makeRect(wrapperRect),
        viewport: {
            convertToPdfPoint: (x, y) => [x, 800 - y],
        },
    };
}

function makeRect(input: {
    left: number;
    top: number;
    right: number;
    bottom: number;
}): ClientRectLike {
    return {
        ...input,
        width: input.right - input.left,
        height: input.bottom - input.top,
    };
}
