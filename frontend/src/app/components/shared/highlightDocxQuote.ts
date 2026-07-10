import { normalizeQuoteText, quoteMatchSegments } from "./quoteTextMatch";

const HIGHLIGHT_CLASS = "docx-text-highlight";

function collectTextNodes(root: HTMLElement): Text[] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node: Node) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            const tag = p.tagName;
            if (tag === "STYLE" || tag === "SCRIPT")
                return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const out: Text[] = [];
    let cur = walker.nextNode() as Text | null;
    while (cur) {
        out.push(cur);
        cur = walker.nextNode() as Text | null;
    }
    return out;
}

export function clearDocxQuoteHighlights(root: HTMLElement): void {
    root.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((span) => {
        const parent = span.parentNode;
        if (!parent) return;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
    });
    root.normalize();
}

/**
 * Highlight the given quote text inside `root` (a docx-preview output).
 * Quote is split on ellipsis variants; each segment is located via
 * letters-only substring matching, so whitespace/punctuation differences
 * between the LLM's quote and the rendered text don't break matching.
 *
 * Returns the first highlight span if any match was found, for
 * scroll-into-view by the caller.
 */
export function highlightDocxQuote(
    root: HTMLElement,
    quote: string,
): HTMLElement | null {
    clearDocxQuoteHighlights(root);
    if (!quote) return null;
    const segments = quoteMatchSegments(quote);
    if (segments.length === 0) return null;

    const textNodes = collectTextNodes(root);
    const nodeStartInFull: number[] = [];
    const nodeStrippedLen: number[] = [];
    const nodeOffsets: ReturnType<typeof normalizeQuoteText>[] = [];
    let fullStripped = "";
    for (const node of textNodes) {
        const normalized = normalizeQuoteText(node.data);
        nodeOffsets.push(normalized);
        const stripped = normalized.text;
        nodeStartInFull.push(fullStripped.length);
        nodeStrippedLen.push(stripped.length);
        fullStripped += stripped;
    }

    type Range = { nodeIdx: number; origStart: number; origEnd: number };
    const ranges: Range[] = [];

    for (const segment of segments) {
        const searchKey = segment.slice(0, 30);
        const matchPos = fullStripped.indexOf(searchKey);
        if (matchPos < 0) continue;
        const matchEnd = matchPos + segment.length;

        for (let i = 0; i < textNodes.length; i++) {
            const start = nodeStartInFull[i];
            const end = start + nodeStrippedLen[i];
            if (matchPos >= end || matchEnd <= start) continue;

            const localStart = Math.max(0, matchPos - start);
            const localEnd = Math.min(nodeStrippedLen[i], matchEnd - start);
            const offsets = nodeOffsets[i];
            const origStart =
                offsets.originalStarts[localStart] ?? textNodes[i].data.length;
            const origEnd = offsets.originalEnds[localEnd - 1] ?? origStart;
            if (origStart >= origEnd) continue;
            ranges.push({ nodeIdx: i, origStart, origEnd });
        }
    }

    if (ranges.length === 0) return null;

    // Apply in reverse document order so splits don't shift earlier ranges.
    ranges.sort((a, b) => {
        if (a.nodeIdx !== b.nodeIdx) return b.nodeIdx - a.nodeIdx;
        return b.origStart - a.origStart;
    });

    const spans: HTMLElement[] = [];
    for (const r of ranges) {
        const node = textNodes[r.nodeIdx];
        const mid = node.splitText(r.origStart);
        mid.splitText(r.origEnd - r.origStart);
        const span = document.createElement("span");
        span.className = HIGHLIGHT_CLASS;
        mid.parentNode?.insertBefore(span, mid);
        span.appendChild(mid);
        spans.push(span);
    }

    // Because we processed ranges in reverse order, the earliest-in-document
    // highlight is the last one we pushed.
    return spans[spans.length - 1] ?? null;
}
