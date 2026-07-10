// Find-in-document core for the PDF viewer: pure text matching over the
// page's text items, plus an overlay painter that draws match rectangles
// without mutating the text layer DOM (so it composes with quote highlights
// and annotation overlays).

export type PdfFindSegment = {
    divIndex: number;
    /** Character offsets into the div's original textContent. */
    start: number;
    end: number;
};

export type PdfFindMatch = { segments: PdfFindSegment[] };

const KEEP_CHAR_RE = /[\p{L}\p{N}]/u;

/** Lowercased letters/numbers only — matching ignores case, spacing, and punctuation. */
export function normalizeFindText(value: string): string {
    let out = "";
    for (const ch of value) {
        if (!KEEP_CHAR_RE.test(ch)) continue;
        const lower = ch.toLowerCase();
        out += lower.length === 1 ? lower : ch;
    }
    return out;
}

// Stripped text plus a map from each stripped index back to the original
// character index, so match offsets survive the normalization.
function stripForFind(original: string): { stripped: string; map: number[] } {
    let stripped = "";
    const map: number[] = [];
    for (let i = 0; i < original.length; i++) {
        const ch = original[i];
        if (!KEEP_CHAR_RE.test(ch)) continue;
        const lower = ch.toLowerCase();
        stripped += lower.length === 1 ? lower : ch;
        map.push(i);
    }
    return { stripped, map };
}

/**
 * Find every occurrence of `query` across the concatenated `texts` (one entry
 * per text-layer div / text item). Matches may span div boundaries; each match
 * carries per-div segments with original-character offsets.
 */
export function findMatchesInTexts(
    texts: string[],
    query: string,
): PdfFindMatch[] {
    const strippedQuery = normalizeFindText(query);
    if (!strippedQuery) return [];

    const divs = texts.map(stripForFind);
    const divStart: number[] = [];
    let full = "";
    for (const div of divs) {
        divStart.push(full.length);
        full += div.stripped;
    }

    const matches: PdfFindMatch[] = [];
    let from = 0;
    for (;;) {
        const pos = full.indexOf(strippedQuery, from);
        if (pos === -1) break;
        const end = pos + strippedQuery.length;
        from = end;

        const segments: PdfFindSegment[] = [];
        for (let i = 0; i < divs.length; i++) {
            const ds = divStart[i];
            const de = ds + divs[i].stripped.length;
            if (pos >= de || end <= ds) continue;
            const localStart = Math.max(0, pos - ds);
            const localEnd = Math.min(divs[i].stripped.length, end - ds);
            if (localEnd <= localStart) continue;
            segments.push({
                divIndex: i,
                start: divs[i].map[localStart],
                end: divs[i].map[localEnd - 1] + 1,
            });
        }
        if (segments.length > 0) matches.push({ segments });
    }
    return matches;
}

const FIND_LAYER_CLASS = "pdf-find-layer";

export function clearFindHighlightLayer(wrapper: HTMLElement) {
    wrapper
        .querySelectorAll(`.${FIND_LAYER_CLASS}`)
        .forEach((el) => el.remove());
}

// Resolve the text node + local offset for a character offset within the
// div's textContent; quote highlights split divs into multiple text nodes.
function caretAtTextOffset(
    root: HTMLElement,
    offset: number,
): { node: Node; offset: number } | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) return { node, offset: remaining };
        remaining -= length;
    }
    return null;
}

/**
 * Repaint the find overlay on one rendered page. Returns the client rect of
 * the active match (when it lives on this page) so the caller can scroll it
 * into view.
 */
export function paintFindHighlights(
    target: { wrapper: HTMLElement; textDivs: HTMLElement[] },
    matches: PdfFindMatch[],
    activeMatchIndex: number,
): DOMRect | null {
    clearFindHighlightLayer(target.wrapper);
    if (matches.length === 0) return null;

    const layer = document.createElement("div");
    layer.className = FIND_LAYER_CLASS;
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.pointerEvents = "none";
    layer.style.mixBlendMode = "multiply";

    const wrapperRect = target.wrapper.getBoundingClientRect();
    let activeRect: DOMRect | null = null;

    matches.forEach((match, matchIndex) => {
        const isActive = matchIndex === activeMatchIndex;
        for (const segment of match.segments) {
            const div = target.textDivs[segment.divIndex];
            if (!div) continue;
            const startCaret = caretAtTextOffset(div, segment.start);
            const endCaret = caretAtTextOffset(div, segment.end);
            if (!startCaret || !endCaret) continue;
            const range = document.createRange();
            range.setStart(startCaret.node, startCaret.offset);
            range.setEnd(endCaret.node, endCaret.offset);
            for (const rect of Array.from(range.getClientRects())) {
                if (rect.width <= 0 || rect.height <= 0) continue;
                if (isActive && !activeRect) activeRect = rect;
                const mark = document.createElement("div");
                mark.style.position = "absolute";
                mark.style.left = `${rect.left - wrapperRect.left}px`;
                mark.style.top = `${rect.top - wrapperRect.top}px`;
                mark.style.width = `${rect.width}px`;
                mark.style.height = `${rect.height}px`;
                mark.style.borderRadius = "2px";
                mark.style.background = isActive
                    ? "rgba(255,146,43,0.6)"
                    : "rgba(255,213,64,0.45)";
                layer.appendChild(mark);
            }
        }
    });

    target.wrapper.appendChild(layer);
    return activeRect;
}
