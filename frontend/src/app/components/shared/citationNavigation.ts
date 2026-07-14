import type { CitationQuote, DocketCitationAnnotation } from "./types";

function citationIdentityParts(citation: DocketCitationAnnotation) {
    return [
        citation.document_id,
        citation.version_id ?? null,
        citation.ref,
        citation.chunk_id ?? null,
        citation.quote_start ?? null,
        citation.quote_end ?? null,
        citation.page,
        citation.quote,
    ];
}

/** Stable identity for a citation's source passage. */
export function buildCitationIdentityKey(
    citation: DocketCitationAnnotation,
): string {
    return JSON.stringify(citationIdentityParts(citation));
}

/**
 * Stable identity for the passages currently highlighted by the document
 * viewer. Provenance keeps distinct indexed passages from collapsing when
 * their displayed page and quote happen to match.
 */
export function buildCitationQuoteListKey(
    quotes: readonly CitationQuote[],
): string {
    return JSON.stringify(
        quotes.map((entry) => [
            entry.page ?? null,
            entry.quote,
            ...(entry.citation
                ? citationIdentityParts(entry.citation)
                : [null, null, null, null, null, null, null, null]),
        ]),
    );
}

/** A unique navigation request for one click on a citation. */
export function buildCitationNavigationKey(
    citation: DocketCitationAnnotation,
    clickNonce: number,
): string {
    return JSON.stringify([citationIdentityParts(citation), clickNonce]);
}

/** Dependency key used by the viewer's highlight-and-scroll effect. */
export function buildCitationNavigationEffectKey(
    quotes: readonly CitationQuote[],
    navigationKey?: string | null,
): string {
    return JSON.stringify([
        buildCitationQuoteListKey(quotes),
        navigationKey ?? null,
    ]);
}

/** Only the primary pointer should navigate before the subsequent click event. */
export function shouldActivateCitationOnPointerDown(args: {
    button: number;
    isPrimary: boolean;
}): boolean {
    return args.isPrimary && args.button === 0;
}

/**
 * Suppress the click synthesized after a handled pointer-down. Keyboard and
 * programmatic clicks have no preceding handled pointer-down and remain valid.
 */
export function shouldActivateCitationOnClick(args: {
    pointerActivated: boolean;
}): boolean {
    return !args.pointerActivated;
}
