import test from "node:test";
import assert from "node:assert/strict";
import {
    buildHeuristicPdfOutline,
    type PdfDocumentLike,
} from "./documentOutlineHeuristics";

type FakeItem = {
    str: string;
    transform: number[];
    fontName: string;
};

function item(
    str: string,
    opts: { size: number; x?: number; y: number; bold?: boolean },
): FakeItem {
    return {
        str,
        transform: [opts.size, 0, 0, opts.size, opts.x ?? 50, opts.y],
        fontName: opts.bold ? "F-Bold" : "F-Regular",
    };
}

const STYLES = {
    "F-Bold": { fontFamily: "Helvetica-Bold" },
    "F-Regular": { fontFamily: "Helvetica" },
};

function fakePdf(pages: FakeItem[][]): PdfDocumentLike {
    return {
        numPages: pages.length,
        getPage: (pageNumber: number) =>
            Promise.resolve({
                getTextContent: () =>
                    Promise.resolve({
                        items: pages[pageNumber - 1],
                        styles: STYLES,
                    }),
            }),
    };
}

function bodyLines(y: number): FakeItem[] {
    // Enough body text that size 10 dominates the length-weighted histogram.
    return [
        item("This agreement is entered into by the parties hereto and", {
            size: 10,
            y,
        }),
        item("sets forth the entire understanding between the parties.", {
            size: 10,
            y: y - 14,
        }),
    ];
}

test("buildHeuristicPdfOutline finds sized, bold-numbered, and Korean headings", async () => {
    const pdf = fakePdf([
        [
            item("Master Service Agreement", { size: 18, y: 760, bold: true }),
            ...bodyLines(700),
        ],
        [
            item("2.1 Payment Terms", { size: 11, y: 760, bold: true }),
            ...bodyLines(700),
        ],
        [item("제3조 (계약의 목적)", { size: 13, y: 760 }), ...bodyLines(700)],
    ]);

    const items = await buildHeuristicPdfOutline(pdf);
    assert.deepEqual(
        items.map((i) => ({ title: i.title, level: i.level, page: i.page })),
        [
            { title: "Master Service Agreement", level: 1, page: 1 },
            { title: "2.1 Payment Terms", level: 2, page: 2 },
            { title: "제3조 (계약의 목적)", level: 2, page: 3 },
        ],
    );
});

test("buildHeuristicPdfOutline drops repeated headers and page numbers", async () => {
    const pages = [1, 2, 3, 4].map((n) => [
        item("ACME Corp — Confidential", { size: 14, y: 800, bold: true }),
        ...(n === 2
            ? [item("Chapter 2 Indemnity", { size: 15, y: 760, bold: true })]
            : []),
        ...bodyLines(700),
        item(String(n), { size: 12, y: 20 }),
    ]);

    const items = await buildHeuristicPdfOutline(fakePdf(pages));
    assert.deepEqual(
        items.map((i) => ({ title: i.title, page: i.page })),
        [{ title: "Chapter 2 Indemnity", page: 2 }],
    );
});

test("buildHeuristicPdfOutline returns nothing for uniformly-styled text", async () => {
    const pdf = fakePdf([
        [...bodyLines(760), ...bodyLines(700)],
        [...bodyLines(760), ...bodyLines(700)],
    ]);
    assert.deepEqual(await buildHeuristicPdfOutline(pdf), []);
});

test("buildHeuristicPdfOutline joins split text runs into one line", async () => {
    const pdf = fakePdf([
        [
            item("1.", { size: 12, x: 40, y: 760, bold: true }),
            item("Definitions", { size: 12, x: 60, y: 761, bold: true }),
            ...bodyLines(700),
        ],
    ]);
    const items = await buildHeuristicPdfOutline(pdf);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "1. Definitions");
    assert.equal(items[0].level, 1);
});

test("buildHeuristicPdfOutline falls back to table-of-contents entries", async () => {
    const pdf = fakePdf([
        [
            item("Table of Contents", { size: 10, y: 780 }),
            item("1. Introduction ........", { size: 10, x: 50, y: 740 }),
            item("2", { size: 10, x: 460, y: 740 }),
            item("1.1 Scope ........", { size: 10, x: 50, y: 720 }),
            item("3", { size: 10, x: 460, y: 720 }),
            ...bodyLines(660),
        ],
        [item("1. Introduction", { size: 10, y: 760 }), ...bodyLines(720)],
        [item("1.1 Scope", { size: 10, y: 760 }), ...bodyLines(720)],
    ]);

    const items = await buildHeuristicPdfOutline(pdf);
    assert.deepEqual(
        items.map((i) => ({ title: i.title, level: i.level, page: i.page })),
        [
            { title: "1. Introduction", level: 1, page: 2 },
            { title: "1.1 Scope", level: 2, page: 3 },
        ],
    );
});

test("buildHeuristicPdfOutline matches plain TOC rows to normalized body headings", async () => {
    const pdf = fakePdf([
        [
            item("CONTENTS", { size: 10, y: 780, bold: true }),
            item("1. Overview", { size: 10, x: 50, y: 740 }),
            item("1", { size: 10, x: 460, y: 740 }),
            item("2. Scope & Purpose", { size: 10, x: 50, y: 720 }),
            item("2", { size: 10, x: 460, y: 720 }),
            ...bodyLines(660),
        ],
        [item("CHAPTER 1 — OVERVIEW", { size: 10, y: 760 }), ...bodyLines(720)],
        [item("2 Scope and Purpose", { size: 10, y: 760 }), ...bodyLines(720)],
    ]);

    const items = await buildHeuristicPdfOutline(pdf);
    assert.deepEqual(
        items.map((i) => ({ title: i.title, page: i.page })),
        [
            { title: "1. Overview", page: 2 },
            { title: "2. Scope & Purpose", page: 3 },
        ],
    );
});

test("buildHeuristicPdfOutline rejects TOC page labels with no body matches", async () => {
    const pdf = fakePdf([
        [
            item("Contents", { size: 10, y: 780 }),
            item("Background ........", { size: 10, x: 50, y: 740 }),
            item("1", { size: 10, x: 460, y: 740 }),
            item("Scope ........", { size: 10, x: 50, y: 720 }),
            item("2", { size: 10, x: 460, y: 720 }),
            ...bodyLines(660),
        ],
        [...bodyLines(760), ...bodyLines(700)],
        [...bodyLines(760), ...bodyLines(700)],
    ]);

    assert.deepEqual(await buildHeuristicPdfOutline(pdf), []);
});

test("buildHeuristicPdfOutline ignores an isolated dot-leader line", async () => {
    const pdf = fakePdf([
        [
            item("Appendix reference ........", { size: 10, y: 760 }),
            item("4", { size: 10, x: 460, y: 760 }),
            ...bodyLines(700),
        ],
    ]);

    assert.deepEqual(await buildHeuristicPdfOutline(pdf), []);
});
