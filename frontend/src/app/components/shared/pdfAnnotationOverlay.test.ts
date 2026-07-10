import test from "node:test";
import assert from "node:assert/strict";
import { buildPdfAnnotationOverlayItems } from "./pdfAnnotationOverlay";
import type { PdfAnnotation } from "./types";

const annotations: PdfAnnotation[] = [
    {
        id: "highlight-a",
        document_id: "doc-a",
        version_id: "version-a",
        user_id: "user-a",
        page_number: 1,
        annotation_type: "highlight",
        color: "#ffe066",
        quote: "Highlighted text",
        comment: null,
        rects: [{ page: 1, x: 10, y: 20, width: 30, height: 12 }],
        source: "citation_promotion",
        source_citation: { ref: 1 },
        created_at: "",
        updated_at: "",
    },
    {
        id: "comment-a",
        document_id: "doc-a",
        version_id: "version-a",
        user_id: "user-a",
        page_number: 2,
        annotation_type: "comment",
        color: "#74c0fc",
        quote: "Commented text",
        comment: "Review this point",
        rects: [{ page: 2, x: 5, y: 96, width: 20, height: 10 }],
        source: "user",
        source_citation: null,
        created_at: "",
        updated_at: "",
    },
];

test("buildPdfAnnotationOverlayItems maps saved highlights into viewport markers", () => {
    const items = buildPdfAnnotationOverlayItems(annotations, 1, {
        convertToViewportRectangle: ([x1, y1, x2, y2]) => [
            x1 * 2,
            200 - y1 * 2,
            x2 * 2,
            200 - y2 * 2,
        ],
    });

    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
        annotationId: "highlight-a",
        annotationType: "highlight",
        pageNumber: 1,
        rectIndex: 0,
        isFirstRect: true,
        isLastRect: true,
        title: "Highlighted text",
        marker: {
            left: 20,
            top: 136,
            width: 60,
            height: 24,
            border: "0",
            background: "#ffe066",
            opacity: "0.42",
        },
        note: null,
    });
});

test("buildPdfAnnotationOverlayItems maps saved comments into markers and notes", () => {
    const items = buildPdfAnnotationOverlayItems(annotations, 2, {
        convertToViewportRectangle: ([x1, y1, x2, y2]) => [
            x2,
            100 - y2,
            x1,
            100 - y1,
        ],
    });

    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
        annotationId: "comment-a",
        annotationType: "comment",
        pageNumber: 2,
        rectIndex: 0,
        isFirstRect: true,
        isLastRect: true,
        title: "Review this point",
        marker: {
            left: 5,
            top: -6,
            width: 20,
            height: 10,
            border: "1px solid #74c0fc",
            background: "#74c0fc",
            opacity: "0.24",
        },
        note: {
            text: "Review this point",
            left: 5,
            top: 0,
            anchorLeft: 17,
            anchorTop: -1,
            border: "1px solid #74c0fc",
        },
    });
});

test("multi-line saved comments render one note for one annotation", () => {
    const items = buildPdfAnnotationOverlayItems(
        [
            {
                ...annotations[1],
                rects: [
                    { page: 2, x: 5, y: 96, width: 60, height: 10 },
                    { page: 2, x: 5, y: 80, width: 44, height: 10 },
                ],
            },
        ],
        2,
        {
            convertToViewportRectangle: ([x1, y1, x2, y2]) => [
                x2,
                100 - y2,
                x1,
                100 - y1,
            ],
        },
    );

    assert.equal(items.length, 2);
    assert.deepEqual(
        items.map((item) => ({
            rectIndex: item.rectIndex,
            isFirstRect: item.isFirstRect,
            isLastRect: item.isLastRect,
            hasNote: item.note !== null,
            noteHasAnchor:
                item.note == null
                    ? false
                    : typeof item.note.anchorLeft === "number" &&
                      typeof item.note.anchorTop === "number",
        })),
        [
            {
                rectIndex: 0,
                isFirstRect: true,
                isLastRect: false,
                hasNote: true,
                noteHasAnchor: true,
            },
            {
                rectIndex: 1,
                isFirstRect: false,
                isLastRect: true,
                hasNote: false,
                noteHasAnchor: false,
            },
        ],
    );
});

test("saved comment notes can use persisted PDF note positions", () => {
    const items = buildPdfAnnotationOverlayItems(
        [
            {
                ...annotations[1],
                source_citation: {
                    note_position: { page: 2, x: 30, y: 70 },
                },
            },
        ],
        2,
        {
            convertToViewportRectangle: ([x1, y1, x2, y2]) => [
                x2,
                100 - y2,
                x1,
                100 - y1,
            ],
        },
    );

    assert.equal(items[0]?.note?.left, 30);
    assert.equal(items[0]?.note?.top, 30);
});
