import test from "node:test";
import assert from "node:assert/strict";
import {
    buildCitationIdentityKey,
    buildCitationNavigationEffectKey,
    buildCitationNavigationKey,
    buildCitationQuoteListKey,
    shouldActivateCitationOnClick,
    shouldActivateCitationOnPointerDown,
} from "./citationNavigation";
import type { DocketCitationAnnotation } from "./types";

const citation: DocketCitationAnnotation = {
    type: "citation_data",
    ref: 1,
    doc_id: "doc-0",
    document_id: "document-a",
    version_id: "version-a",
    filename: "source.pdf",
    page: 7,
    quote: "The same displayed source text.",
    chunk_id: "chunk-a",
    quote_start: 10,
    quote_end: 41,
};

test("citation identity distinguishes provenance behind the same page and quote", () => {
    const differentRef = { ...citation, ref: 2 };
    const differentChunk = { ...citation, chunk_id: "chunk-b" };
    const differentSpan = { ...citation, quote_start: 50, quote_end: 81 };

    assert.notEqual(
        buildCitationIdentityKey(citation),
        buildCitationIdentityKey(differentRef),
    );
    assert.notEqual(
        buildCitationQuoteListKey([
            { page: 7, quote: citation.quote, citation },
        ]),
        buildCitationQuoteListKey([
            { page: 7, quote: citation.quote, citation: differentChunk },
        ]),
    );
    assert.notEqual(
        buildCitationQuoteListKey([
            { page: 7, quote: citation.quote, citation },
        ]),
        buildCitationQuoteListKey([
            { page: 7, quote: citation.quote, citation: differentSpan },
        ]),
    );
});

test("each click creates a new navigation request for the same citation", () => {
    const firstClick = buildCitationNavigationKey(citation, 1);
    const secondClick = buildCitationNavigationKey(citation, 2);
    const quotes = [{ page: 7, quote: citation.quote, citation }];

    assert.notEqual(firstClick, secondClick);
    assert.equal(firstClick, buildCitationNavigationKey(citation, 1));
    assert.notEqual(
        buildCitationNavigationEffectKey(quotes, firstClick),
        buildCitationNavigationEffectKey(quotes, secondClick),
    );
});

test("pointer activation navigates exactly once while keyboard activation still works", () => {
    assert.equal(
        shouldActivateCitationOnPointerDown({ button: 0, isPrimary: true }),
        true,
    );
    assert.equal(
        shouldActivateCitationOnClick({ pointerActivated: true }),
        false,
    );
    assert.equal(
        shouldActivateCitationOnClick({ pointerActivated: false }),
        true,
    );
    assert.equal(
        shouldActivateCitationOnPointerDown({ button: 1, isPrimary: true }),
        false,
    );
});
