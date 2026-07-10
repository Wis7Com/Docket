import type { DocumentNavigationItem } from "./DocumentNavigationPane";

/**
 * Heuristic outline generation for documents that ship without built-in
 * bookmarks. PDF analysis looks at the text layer (font size, boldness,
 * numbering patterns); DOCX analysis walks the rendered docx-preview DOM.
 * Both are best-effort: they return an empty list when the document has no
 * detectable heading structure.
 */

// Numbered-heading openers: western ("1.", "2.3", "IV.", "Article 5",
// "Section 2") and Korean legal ("제1장", "제3조").
const NUMBERING_PATTERN = new RegExp(
    "^(?:" +
        "\\d+(?:\\.\\d+)*[.)]?\\s+\\S" +
        "|[IVXLCM]+[.)]\\s+\\S" +
        "|제\\s*\\d+\\s*(?:편|장|절|관|조|항)" +
        "|(?:article|section|chapter|part|appendix|annex|schedule|exhibit|clause)\\s+[\\dIVXLC]" +
        ")",
    "i",
);

const MAX_ANALYZED_PAGES = 500;
const MAX_ITEMS = 240;
const MAX_TITLE_LENGTH = 160;

function numberingDepth(text: string): number | null {
    const match = /^(\d+(?:\.\d+)*)[.)]?\s/.exec(text);
    return match ? match[1].split(".").length : null;
}

function roundSize(size: number): number {
    return Math.round(size * 2) / 2;
}

function normalizeTitle(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function parseTocEntry(
    text: string,
    allowPlainTrailingPage = false,
): { title: string; page: number; level: number | null } | null {
    const normalized = normalizeTitle(text);
    const match = allowPlainTrailingPage
        ? /^(.{3,}?)\s+(\d{1,4})$/.exec(normalized)
        : /^(.{3,}?)\s*(?:\.{3,}|…{2,}|·{3,})\s*(\d{1,4})$/.exec(normalized);
    if (!match) return null;
    const title = normalizeTitle(match[1]);
    const page = Number(match[2]);
    if (!title || page < 1) return null;
    return { title, page, level: numberingDepth(title) };
}

function headingMatchKey(value: string): string {
    return normalizeTitle(value)
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/&/g, " and ")
        .replace(
            /^(?:(?:part|chapter|article|section|title|clause)\s+[\divxlcm]+|제\s*\d+\s*(?:편|장|절|관|조|항)|\d+(?:\.\d+)*[.)]?)\s*[:.\-–—]?\s*/iu,
            "",
        )
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

function headingsMatch(left: string, right: string): boolean {
    const a = headingMatchKey(left);
    const b = headingMatchKey(right);
    if (!a || !b) return false;
    if (a === b) return true;
    if (
        Math.min(a.length, b.length) >= 12 &&
        (a.includes(b) || b.includes(a))
    ) {
        return true;
    }
    const aTokens = new Set(a.split(" ").filter((token) => token.length > 1));
    const bTokens = new Set(b.split(" ").filter((token) => token.length > 1));
    if (!aTokens.size || !bTokens.size) return false;
    let overlap = 0;
    for (const token of aTokens) if (bTokens.has(token)) overlap += 1;
    return overlap / Math.max(aTokens.size, bTokens.size) >= 0.75;
}

type HeadingLine = {
    text: string;
    size: number;
    bold: boolean;
    page?: number;
};

/**
 * Shared candidate selection + level assignment. `lines` must be in
 * document order.
 */
function selectHeadings(
    lines: HeadingLine[],
    pageCount: number,
): (HeadingLine & { level: number })[] {
    if (lines.length === 0) return [];

    // Dominant body font size, weighted by text length.
    const sizeWeights = new Map<number, number>();
    for (const line of lines) {
        const key = roundSize(line.size);
        if (!key) continue;
        sizeWeights.set(key, (sizeWeights.get(key) ?? 0) + line.text.length);
    }
    let bodySize = 0;
    let bestWeight = -1;
    for (const [size, weight] of sizeWeights) {
        if (weight > bestWeight) {
            bestWeight = weight;
            bodySize = size;
        }
    }
    if (!bodySize) return [];

    // Texts repeating across many pages are headers/footers, not headings.
    const pagesByText = new Map<string, Set<number>>();
    for (const line of lines) {
        if (typeof line.page !== "number") continue;
        const key = line.text.toLowerCase();
        const pages = pagesByText.get(key) ?? new Set<number>();
        pages.add(line.page);
        pagesByText.set(key, pages);
    }
    const repeatedThreshold = Math.max(3, Math.ceil(pageCount * 0.3));

    const candidates = lines.filter((line) => {
        const text = line.text;
        if (text.length < 3 || text.length > MAX_TITLE_LENGTH) return false;
        // Bare numbers / "3 / 12" page markers.
        if (/^\d+(\s*[/-]\s*\d+)?$/.test(text)) return false;
        const repeats = pagesByText.get(text.toLowerCase());
        if (repeats && repeats.size >= repeatedThreshold) return false;
        const ratio = line.size / bodySize;
        const numbered = NUMBERING_PATTERN.test(text);
        return (
            ratio >= 1.2 ||
            (line.bold && ratio >= 1.08) ||
            (numbered && (line.bold || ratio >= 1.08))
        );
    });
    if (candidates.length === 0) return [];

    // Levels: explicit numbering depth wins; otherwise rank by font size.
    const sizeRanks = [
        ...new Set(candidates.map((c) => roundSize(c.size))),
    ].sort((a, b) => b - a);
    const levelOf = (line: HeadingLine): number => {
        const depth = numberingDepth(line.text);
        if (depth) return Math.min(depth, 4);
        return Math.min(sizeRanks.indexOf(roundSize(line.size)) + 1, 3);
    };

    let leveled = candidates.map((line) => ({ ...line, level: levelOf(line) }));
    // A wall of hits means the heuristic latched onto body text — keep only
    // the strongest levels rather than emitting noise.
    if (leveled.length > MAX_ITEMS) {
        leveled = leveled.filter((line) => line.level <= 2);
    }
    if (leveled.length > MAX_ITEMS) {
        leveled = leveled.slice(0, MAX_ITEMS);
    }
    // Drop immediate duplicates (e.g. a heading re-emitted by a text runover).
    return leveled.filter(
        (line, i) =>
            i === 0 ||
            line.text !== leveled[i - 1].text ||
            line.level !== leveled[i - 1].level,
    );
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

type PdfTextItemLike = {
    str?: string;
    transform?: number[];
    height?: number;
    fontName?: string;
};

type PdfTextContentLike = {
    items: unknown[];
    styles?: Record<string, { fontFamily?: string } | undefined>;
};

export type PdfDocumentLike = {
    numPages: number;
    getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<PdfTextContentLike>;
    }>;
};

export async function buildHeuristicPdfOutline(
    pdfDoc: PdfDocumentLike,
): Promise<DocumentNavigationItem[]> {
    const pageCount = Math.min(pdfDoc.numPages, MAX_ANALYZED_PAGES);
    const lines: HeadingLine[] = [];
    const tocEntries: Array<{
        title: string;
        page: number;
        level: number | null;
        x: number;
        tocPage: number;
    }> = [];
    let tocHeadingPage: number | null = null;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        const page = await pdfDoc.getPage(pageNumber);
        const content = await page.getTextContent();
        const styles = content.styles ?? {};

        type LinePart = { x: number; str: string; size: number; bold: boolean };
        const buckets = new Map<number, { y: number; parts: LinePart[] }>();
        for (const raw of content.items) {
            const item = raw as PdfTextItemLike;
            const str = item.str;
            if (!str || !str.trim()) continue;
            const t = item.transform;
            const size = t
                ? Math.hypot(t[2] ?? 0, t[3] ?? 0)
                : (item.height ?? 0);
            if (!size) continue;
            const y = t?.[5] ?? 0;
            const x = t?.[4] ?? 0;
            const family =
                (item.fontName && styles[item.fontName]?.fontFamily) ||
                item.fontName ||
                "";
            const bold = /bold|black|heavy|semibold|extrabold/i.test(family);
            const key = Math.round(y / 4);
            const bucket = buckets.get(key) ?? { y, parts: [] };
            bucket.parts.push({ x, str, size, bold });
            buckets.set(key, bucket);
        }

        // PDF y grows upward: higher y first = reading order.
        const orderedBuckets = [...buckets.values()].sort((a, b) => b.y - a.y);
        for (const bucket of orderedBuckets) {
            const parts = [...bucket.parts].sort((a, b) => a.x - b.x);
            const text = normalizeTitle(parts.map((p) => p.str).join(" "));
            if (!text) continue;
            if (/^(?:table\s+of\s+)?contents$|^목\s*차$/iu.test(text)) {
                tocHeadingPage = pageNumber;
            }
            const lastPart = parts[parts.length - 1];
            const previousPart = parts[parts.length - 2];
            const estimatedPreviousEnd = previousPart
                ? previousPart.x +
                  previousPart.str.length * previousPart.size * 0.45
                : 0;
            const separatedTrailingPage =
                !!previousPart &&
                /^\d{1,4}$/.test(lastPart?.str.trim() ?? "") &&
                lastPart.x - estimatedPreviousEnd >= 24;
            const insidePlainToc =
                tocHeadingPage !== null &&
                pageNumber >= tocHeadingPage &&
                pageNumber <= tocHeadingPage + 3;
            const tocEntry =
                parseTocEntry(text) ??
                (insidePlainToc && separatedTrailingPage
                    ? parseTocEntry(text, true)
                    : null);
            if (tocEntry) {
                tocEntries.push({
                    ...tocEntry,
                    x: parts[0]?.x ?? 0,
                    tocPage: pageNumber,
                });
            }
            const meaningful = parts.filter((p) => p.str.trim().length > 1);
            lines.push({
                text,
                size: Math.max(...parts.map((p) => p.size)),
                bold: meaningful.length > 0 && meaningful.every((p) => p.bold),
                page: pageNumber,
            });
        }
    }

    // A printed table of contents is often the best structure available in a
    // flat PDF: its rows can use the same font as body copy, so the visual
    // heading heuristic below cannot see them. Require multiple dot-leader
    // rows to avoid treating an isolated reference line as a document TOC.
    if (tocEntries.length >= 2) {
        const indentRanks = [
            ...new Set(tocEntries.map((entry) => Math.round(entry.x / 8) * 8)),
        ].sort((a, b) => a - b);
        const lastTocPage = Math.max(
            ...tocEntries.map((entry) => entry.tocPage),
        );
        const matchedEntries = tocEntries.map((entry) => ({
            entry,
            bodyMatch: lines.find(
                (line) =>
                    (line.page ?? 0) > lastTocPage &&
                    headingsMatch(line.text, entry.title),
            ),
        }));
        const offsets = matchedEntries
            .map(({ entry, bodyMatch }) =>
                bodyMatch?.page == null ? null : bodyMatch.page - entry.page,
            )
            .filter((offset): offset is number => offset !== null)
            .sort((left, right) => left - right);
        if (offsets.length < 2) {
            return selectHeadings(lines, pageCount).map((line, index) => ({
                id: `pdf-heuristic-${index}`,
                title: line.text,
                level: line.level,
                page: line.page,
            }));
        }
        const inferredOffset = offsets[Math.floor(offsets.length / 2)];
        if (
            offsets.filter(
                (offset) => Math.abs(offset - inferredOffset) <= 2,
            ).length < 2
        ) {
            return selectHeadings(lines, pageCount).map((line, index) => ({
                id: `pdf-heuristic-${index}`,
                title: line.text,
                level: line.level,
                page: line.page,
            }));
        }
        return matchedEntries.slice(0, MAX_ITEMS).map((match, index) => {
            const { entry, bodyMatch } = match;
            const inferredLevel = indentRanks.indexOf(
                Math.round(entry.x / 8) * 8,
            );
            return {
                id: `pdf-toc-${index}`,
                title: entry.title,
                level: Math.min(entry.level ?? inferredLevel + 1, 4),
                page:
                    bodyMatch?.page ??
                    Math.min(
                        pdfDoc.numPages,
                        Math.max(1, entry.page + inferredOffset),
                    ),
            };
        });
    }

    return selectHeadings(lines, pageCount).map((line, index) => ({
        id: `pdf-heuristic-${index}`,
        title: line.text,
        level: line.level,
        page: line.page,
    }));
}

// ---------------------------------------------------------------------------
// DOCX (rendered docx-preview DOM)
// ---------------------------------------------------------------------------

const MAX_ANALYZED_PARAGRAPHS = 8000;

export function buildHeuristicDocxOutline(
    root: HTMLElement,
    navAttr: string,
): DocumentNavigationItem[] {
    const win = root.ownerDocument.defaultView;
    if (!win) return [];

    const paragraphs = Array.from(
        root.querySelectorAll<HTMLElement>("p"),
    ).slice(0, MAX_ANALYZED_PARAGRAPHS);
    const entries: { el: HTMLElement; line: HeadingLine }[] = [];
    for (const el of paragraphs) {
        const text = normalizeTitle(el.textContent ?? "");
        if (!text) continue;
        // docx-preview puts run formatting on inner spans; the paragraph
        // itself usually carries body styles only.
        const probe = el.querySelector<HTMLElement>("span") ?? el;
        const style = win.getComputedStyle(probe);
        const size = Number.parseFloat(style.fontSize) || 0;
        const weight = Number.parseInt(style.fontWeight, 10) || 400;
        const bold = weight >= 600 || !!el.querySelector("b, strong");
        entries.push({ el, line: { text, size, bold } });
    }

    const headings = selectHeadings(
        entries.map((entry) => entry.line),
        1,
    );

    const tocEntries: Array<{
        entry: (typeof entries)[number];
        index: number;
        toc: NonNullable<ReturnType<typeof parseTocEntry>>;
    }> = [];
    let insidePlainToc = false;
    let plainTocMisses = 0;
    entries.forEach((entry, index) => {
        if (/^(?:table\s+of\s+)?contents$|^목\s*차$/iu.test(entry.line.text)) {
            insidePlainToc = true;
            plainTocMisses = 0;
            return;
        }
        const explicitToc = parseTocEntry(entry.line.text);
        const toc =
            explicitToc ??
            (insidePlainToc ? parseTocEntry(entry.line.text, true) : null);
        if (toc) {
            tocEntries.push({ entry, index, toc });
            if (insidePlainToc) plainTocMisses = 0;
        } else if (insidePlainToc && tocEntries.length) {
            plainTocMisses += 1;
            if (plainTocMisses >= 3) insidePlainToc = false;
        }
    });
    if (tocEntries.length >= 2) {
        const bodyStart = Math.max(
            ...tocEntries.map((candidate) => candidate.index),
        );
        const matchedEntries = tocEntries
            .map((candidate) => ({
                candidate,
                target: entries
                    .slice(bodyStart + 1)
                    .find((entry) =>
                        headingsMatch(entry.line.text, candidate.toc.title),
                    )?.el,
            }))
            .filter(
                (
                    match,
                ): match is typeof match & { target: HTMLElement } =>
                    !!match.target,
            );
        if (matchedEntries.length >= 2) {
            return matchedEntries.slice(0, MAX_ITEMS).map((match, index) => {
                const { candidate, target } = match;
                const id = `docx-toc-${index}`;
                target.setAttribute(navAttr, id);
                return {
                    id,
                    title: candidate.toc.title,
                    level: Math.min(candidate.toc.level ?? 1, 4),
                };
            });
        }
    }

    // Map selected headings back to their elements in order.
    const items: DocumentNavigationItem[] = [];
    let cursor = 0;
    for (let index = 0; index < headings.length; index++) {
        const heading = headings[index];
        while (
            cursor < entries.length &&
            entries[cursor].line.text !== heading.text
        ) {
            cursor++;
        }
        if (cursor >= entries.length) break;
        const id = `docx-heuristic-${index}`;
        entries[cursor].el.setAttribute(navAttr, id);
        items.push({ id, title: heading.text, level: heading.level });
        cursor++;
    }
    return items;
}

export function restoreDocxOutline(
    root: HTMLElement,
    navAttr: string,
    storedItems: DocumentNavigationItem[],
): DocumentNavigationItem[] {
    const paragraphs = Array.from(
        root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, p"),
    );
    let cursor = 0;
    const restored: DocumentNavigationItem[] = [];
    for (const item of storedItems) {
        const title = normalizeTitle(item.title).toLocaleLowerCase();
        let match: HTMLElement | undefined;
        while (cursor < paragraphs.length) {
            const candidate = paragraphs[cursor++];
            if (
                normalizeTitle(
                    candidate.textContent ?? "",
                ).toLocaleLowerCase() === title
            ) {
                match = candidate;
                break;
            }
        }
        if (!match) continue;
        match.setAttribute(navAttr, item.id);
        restored.push(item);
    }
    return restored;
}
