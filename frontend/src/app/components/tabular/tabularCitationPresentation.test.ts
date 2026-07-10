import test from "node:test";
import assert from "node:assert/strict";
import type { TRCitationAnnotation } from "../../lib/docketApi";
import {
    preprocessCellMarkdown,
    preprocessTRCitations,
} from "./tabularCitationPresentation";

test("tabular cell preprocessing preserves citation buttons and value pills", () => {
    const result = preprocessCellMarkdown(
        "[[Yes]] because the covenant applies [[page:12||quote:Borrower [must] deliver accounts]] and [[Green]].",
    );

    assert.equal(
        result.processed,
        "`§p0§`\u200B because the covenant applies `§c0§`\u200B and `§p1§`\u200B.",
    );
    assert.deepEqual(result.pills, ["Yes", "Green"]);
    assert.deepEqual(result.citations, [
        {
            page: 12,
            quote: "Borrower [must] deliver accounts",
        },
    ]);
});

test("tabular chat preprocessing maps inline markers to table coordinates", () => {
    const annotations: TRCitationAnnotation[] = [
        {
            type: "tabular_citation",
            ref: 1,
            col_index: 2,
            row_index: 0,
            col_name: "Change of control",
            doc_name: "credit-agreement.pdf",
            quote: "Consent is required before control changes.",
        },
        {
            type: "tabular_citation",
            ref: 2,
            col_index: 4,
            row_index: 3,
            col_name: "Termination",
            doc_name: "services-agreement.pdf",
            quote: "Either party may terminate on notice.",
        },
    ];
    const citationsList: TRCitationAnnotation[] = [];

    const processed = preprocessTRCitations(
        "The key restrictions are linked to both documents [1, 2]. Missing refs stay visible [9].",
        annotations,
        citationsList,
    );

    assert.equal(
        processed,
        "The key restrictions are linked to both documents `§0§`\u200B`§1§`\u200B. Missing refs stay visible [9].",
    );
    assert.deepEqual(
        citationsList.map((citation) => ({
            ref: citation.ref,
            col_index: citation.col_index,
            row_index: citation.row_index,
            quote: citation.quote,
        })),
        [
            {
                ref: 1,
                col_index: 2,
                row_index: 0,
                quote: "Consent is required before control changes.",
            },
            {
                ref: 2,
                col_index: 4,
                row_index: 3,
                quote: "Either party may terminate on notice.",
            },
        ],
    );
});
