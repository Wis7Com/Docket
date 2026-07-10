export type NormalizedText = {
    text: string;
    originalStarts: number[];
    originalEnds: number[];
};

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Produces a comparison key for citation text while keeping the source offsets
 * for every retained character. PDF.js frequently separates words across text
 * spans, and legal documents may contain Korean, accented names, or full-width
 * compatibility characters; ASCII-only matching makes those citations fail.
 */
export function normalizeQuoteText(value: string): NormalizedText {
    const retained: string[] = [];
    const originalStarts: number[] = [];
    const originalEnds: number[] = [];
    let offset = 0;

    for (const sourceChar of value) {
        const end = offset + sourceChar.length;
        for (const normalizedChar of sourceChar
            .normalize("NFKC")
            .toLocaleLowerCase()) {
            if (!ALPHANUMERIC.test(normalizedChar)) continue;
            retained.push(normalizedChar);
            originalStarts.push(offset);
            originalEnds.push(end);
        }
        offset = end;
    }

    return {
        text: retained.join(""),
        originalStarts,
        originalEnds,
    };
}

export function quoteMatchSegments(quote: string): string[] {
    return quote
        .split(/\.{3}|…/)
        .map((segment) => normalizeQuoteText(segment).text)
        .filter((segment) => segment.length > 0);
}
