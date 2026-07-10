import test from "node:test";
import assert from "node:assert/strict";
import { preprocessCitations } from "./citations";
import type { DocketCitationAnnotation } from "../shared/types";

const citation: DocketCitationAnnotation = {
    type: "citation_data",
    ref: 1,
    doc_id: "doc-0",
    document_id: "document-0",
    filename: "source.pdf",
    page: 2,
    quote: "Exact supporting language.",
};

test("preprocessCitations binds a uniquely resolved ref", () => {
    const citations = [] as DocketCitationAnnotation[];
    const result = preprocessCitations("Claim [1].", [citation], citations);

    assert.match(result, /§0§/);
    assert.deepEqual(citations, [citation]);
});

test("preprocessCitations fails closed for duplicate refs", () => {
    const citations = [] as DocketCitationAnnotation[];
    const result = preprocessCitations(
        "Claim [1].",
        [citation, { ...citation, quote: "A different source." }],
        citations,
    );

    assert.match(result, /§unresolved:1§/);
    assert.deepEqual(citations, []);
});
