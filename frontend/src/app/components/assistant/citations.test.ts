import test from "node:test";
import assert from "node:assert/strict";
import { citationSummaryChip, preprocessCitations } from "./citations";
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

test("preprocessCitations keeps other refs resolvable when one citation is missing", () => {
    const thirdCitation = { ...citation, ref: 3, quote: "Third source." };
    const citations = [] as DocketCitationAnnotation[];
    const result = preprocessCitations(
        "A [1]. B [2]. C [3].",
        [citation, thirdCitation],
        citations,
    );

    assert.match(result, /§0§/);
    assert.match(result, /§unresolved:2§/);
    assert.match(result, /§1§/);
    assert.deepEqual(citations, [citation, thirdCitation]);
});

test("citationSummaryChip shows the verified citation count", () => {
    assert.deepEqual(
        citationSummaryChip(
            { verified_count: 3, used_document_tools: true },
            "ko-KR",
        ),
        {
            kind: "verified",
            text: "원문 대조 인용 3개 ✓",
        },
    );
});

test("citationSummaryChip warns when document tools produced no verified citations", () => {
    assert.deepEqual(
        citationSummaryChip(
            { verified_count: 0, used_document_tools: true },
            "ko",
        ),
        {
            kind: "warning",
            text: "⚠︎ 이 답변의 참조는 원문과 대조되지 않았습니다",
        },
    );
});

test("citationSummaryChip stays hidden when no document tools were used", () => {
    assert.equal(
        citationSummaryChip({
            verified_count: 0,
            used_document_tools: false,
        }),
        null,
    );
});
