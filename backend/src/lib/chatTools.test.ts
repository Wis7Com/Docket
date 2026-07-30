import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_WORKFLOWS } from "./builtinWorkflows";
import {
    PROJECT_EXTRA_TOOLS,
    SYSTEM_PROMPT,
    automaticWholeDocumentSummaryTarget,
    boundDocumentToolResult,
    documentToolResultMaxCharsForModel,
    buildWorkflowStore,
    citationSystemPrompt,
    citationMarkerRefs,
    convertLeakedPassageHandleTokens,
    countDistinctCitationSources,
    countOrphanCitationMarkers,
    dedupeCitationEvidence,
    assignCitationSupportByOccurrence,
    annotatePdfAnnotationPayload,
    extractAnnotations,
    filterDocContext,
    filterToolsByDisabled,
    identicalToolCallKey,
    extractAnnotationContext,
    fetchUserPdfAnnotations,
    readAnnotationContexts,
    parseCitations,
    recoverLeakedPassageHandleCitations,
    recoverNamedQuotedCitation,
    renumberCitations,
    resolveSearchDocumentIds,
    sanitizeAssistantVisibleText,
    systemPromptForModel,
    validateCitationContract,
    type DocIndex,
    type DocStore,
} from "./chatTools";
import { PassageRegistry } from "./citationHandles";

test("whole-document summary routing selects the displayed indexed document", () => {
    const target = automaticWholeDocumentSummaryTarget(
        [
            {
                role: "user",
                content:
                    "이 문서 요약해 줘\n\ndisplayed_doc: FRAND.pdf\ndisplayed_doc_id: 11111111-1111-4111-8111-111111111111",
            },
        ],
        {
            "doc-0": {
                document_id: "11111111-1111-4111-8111-111111111111",
                version_id: "version-a",
                filename: "FRAND.pdf",
            },
            "doc-1": {
                document_id: "22222222-2222-4222-8222-222222222222",
                version_id: "version-b",
                filename: "other.pdf",
            },
        },
    );

    assert.deepEqual(target, {
        docId: "doc-0",
        focus: "이 문서 요약해 줘",
        language: "Korean",
    });
});

test("whole-document summary routing leaves targeted and ambiguous requests on RAG", () => {
    const index: DocIndex = {
        "doc-0": {
            document_id: "11111111-1111-4111-8111-111111111111",
            version_id: "version-a",
            filename: "a.pdf",
        },
        "doc-1": {
            document_id: "22222222-2222-4222-8222-222222222222",
            version_id: "version-b",
            filename: "b.pdf",
        },
    };

    assert.equal(
        automaticWholeDocumentSummaryTarget(
            [{ role: "user", content: "10-20페이지를 요약해 줘" }],
            index,
        ),
        null,
    );
    assert.equal(
        automaticWholeDocumentSummaryTarget(
            [{ role: "user", content: "문서를 요약해 줘" }],
            index,
        ),
        null,
    );
    assert.equal(
        automaticWholeDocumentSummaryTarget(
            [{ role: "user", content: "FRAND의 royalty 계산법을 찾아줘" }],
            index,
        ),
        null,
    );
});

test("local Ollama models receive a final citation-format reminder", () => {
    const base = "Base legal assistant instructions.";
    const reinforced = systemPromptForModel(base, "ollama:gemma4:12b-mlx");

    assert.match(reinforced, /^Base legal assistant instructions\./);
    assert.match(reinforced, /FINAL RESPONSE CITATION CHECK/);
    assert.match(reinforced, /<CITATIONS> JSON block/);
    assert.match(
        systemPromptForModel(base, "ollama/gemma4:12b-mlx"),
        /FINAL RESPONSE CITATION CHECK/,
    );
    assert.match(
        systemPromptForModel(base, "free-router:free-router/best"),
        /FINAL RESPONSE CITATION CHECK/,
    );
    assert.equal(systemPromptForModel(base, "gemini-3-flash-preview"), base);
});

test("document citation instructions require markers inside Markdown tables", () => {
    assert.match(SYSTEM_PROMPT, /\{"ref": 1, "passage": "p12"\}/);
    assert.doesNotMatch(SYSTEM_PROMPT, /copy only the exact chunk_id/);
    assert.match(
        SYSTEM_PROMPT,
        /In Markdown tables, place each \[N\] marker at the end of the supported claim inside the relevant cell/,
    );
    assert.match(SYSTEM_PROMPT, /A table does not waive or replace/);
    assert.match(
        SYSTEM_PROMPT,
        /Never cite as \[filename\] or \[filename, p\. N\] in prose/,
    );
    assert.match(SYSTEM_PROMPT, /Those are dead text, not citation links/);
    assert.match(
        SYSTEM_PROMPT,
        /Passage ids never appear in the answer text; prose carries only numeric \[N\] markers/,
    );
});

test("citation handle kill switch restores the pure legacy prompt", () => {
    const legacy = citationSystemPrompt("0");
    assert.match(legacy, /"doc_id": "doc-0"/);
    assert.match(legacy, /exact verbatim text/);
    assert.doesNotMatch(legacy, /"passage": "p12"/);
});

test("annotation prompt requires explicit per-highlight coverage", () => {
    assert.match(SYSTEM_PROMPT, /account for every retrieved highlight/);
    assert.match(SYSTEM_PROMPT, /explicitly grouped with named siblings/);
    assert.match(SYSTEM_PROMPT, /explicitly excluded with a short reason/);
    assert.match(
        SYSTEM_PROMPT,
        /all highlights are accounted for or explicitly grouped/,
    );
});

test("local citation recovery requires an exact quote in the named document", () => {
    const rows = new Map([
        [
            "document-a",
            [
                {
                    chunk_id: "chunk-a",
                    chunk_index: 0,
                    page_number: 1,
                    content:
                        "Interactive smoke clause: the indemnity survives termination.",
                    start_char: 0,
                    end_char: 65,
                },
            ],
        ],
        [
            "document-b",
            [
                {
                    chunk_id: "chunk-b",
                    chunk_index: 0,
                    page_number: 1,
                    content:
                        "Interactive smoke clause: the indemnity survives termination.",
                    start_char: 0,
                    end_char: 65,
                },
            ],
        ],
    ]);
    const loadRows = (doc: { document_id: string }) =>
        rows.get(doc.document_id) ?? [];
    const uniqueRows = (doc: { document_id: string }) =>
        doc.document_id === "document-a" ? (rows.get("document-a") ?? []) : [];

    const recovered = recoverNamedQuotedCitation(
        'The credit-agreement.pdf states that "the indemnity survives termination".',
        docIndex,
        loadRows,
    );
    assert.equal(
        recovered.text,
        'The credit-agreement.pdf states that "the indemnity survives termination" [1].',
    );
    assert.deepEqual(recovered.citations, [
        {
            ref: 1,
            doc_id: "doc-0",
            page: 1,
            quote: "the indemnity survives termination",
        },
    ]);
    assert.deepEqual(
        recoverNamedQuotedCitation(
            'The clause says "a phrase absent from every source document".',
            docIndex,
            loadRows,
        ).citations,
        [],
    );
    assert.deepEqual(
        recoverNamedQuotedCitation(
            'nonexistent.pdf states that "the indemnity survives termination".',
            docIndex,
            uniqueRows,
        ).citations,
        [],
    );
    const largeIndex = Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [
            `doc-${index}`,
            {
                document_id: `document-${index}`,
                filename: `document-${index}.pdf`,
                version_id: `version-${index}`,
            },
        ]),
    ) as DocIndex;
    let largeLoads = 0;
    assert.deepEqual(
        recoverNamedQuotedCitation(
            'The clause says "the indemnity survives termination".',
            largeIndex,
            () => {
                largeLoads += 1;
                return [];
            },
        ).citations,
        [],
    );
    assert.equal(largeLoads, 0);
    assert.deepEqual(
        recoverNamedQuotedCitation(
            'The clause says "the indemnity survives termination".',
            docIndex,
            uniqueRows,
        ).citations.map((citation) => citation.doc_id),
        ["doc-0"],
    );
    assert.deepEqual(
        recoverNamedQuotedCitation(
            'The clause says "the indemnity survives termination".',
            docIndex,
            loadRows,
        ).citations,
        [],
    );

    const suffixIndex: DocIndex = {
        ...docIndex,
        "doc-2": {
            document_id: "document-c",
            filename: "agreement.pdf",
            version_id: "version-c",
        },
    };
    const suffixRows = (doc: { document_id: string }) =>
        doc.document_id === "document-c"
            ? [
                  {
                      chunk_id: "chunk-c",
                      chunk_index: 0,
                      page_number: 2,
                      content: "The indemnity survives termination.",
                      start_char: 0,
                      end_char: 35,
                  },
              ]
            : [];
    assert.deepEqual(
        recoverNamedQuotedCitation(
            'The credit-agreement.pdf states that "the indemnity survives termination".',
            suffixIndex,
            suffixRows,
        ).citations,
        [],
    );
});

const EXPECTED_BACKEND_BUILTIN_WORKFLOW_IDS = [
    "builtin-cp-checklist",
    "builtin-issue-comparison",
    "builtin-brief-sequence-diff",
    "builtin-credit-summary",
    "builtin-sha-summary",
];

const docIndex: DocIndex = {
    "doc-0": {
        document_id: "document-a",
        filename: "credit-agreement.pdf",
        version_id: "version-a",
        version_number: 3,
    },
    "doc-1": {
        document_id: "document-b",
        filename: "shareholders-agreement.pdf",
        version_id: null,
        version_number: null,
    },
};

test("boundDocumentToolResult redirects oversized full-document reads", () => {
    const oversized = "x".repeat(101);
    const result = boundDocumentToolResult(oversized, 100);
    const payload = JSON.parse(result) as Record<string, unknown>;

    assert.equal(payload.ok, false);
    assert.equal(payload.code, "DOCUMENT_RESULT_TOO_LARGE");
    assert.equal(payload.original_characters, 101);
    assert.equal(payload.max_characters, 100);
    assert.equal(result.includes(oversized), false);
    assert.match(result, /search_project_documents/);
    assert.equal(boundDocumentToolResult("short", 100), "short");
});

test("local document tool budgets are stricter without changing remote budgets", () => {
    assert.equal(
        documentToolResultMaxCharsForModel("ollama:gemma4:12b-mlx", 300_000),
        96_000,
    );
    assert.equal(
        documentToolResultMaxCharsForModel(
            "mlx:mlx-community/gemma-4-26b-a4b-it-4bit",
            80_000,
        ),
        80_000,
    );
    assert.equal(
        documentToolResultMaxCharsForModel("claude-sonnet-4-6", 300_000),
        300_000,
    );
});

test("project search tool exposes opt-in document discovery grouping", () => {
    const searchTool = PROJECT_EXTRA_TOOLS.find(
        (tool) => tool.function.name === "search_project_documents",
    );
    assert.ok(searchTool);
    const grouping =
        searchTool.function.parameters.properties.group_by_document;
    assert.ok(grouping);
    assert.equal(grouping.type, "boolean");
    assert.deepEqual(searchTool.function.parameters.required, ["query"]);
});

test("project chat exposes a dedicated annotation retrieval tool", () => {
    const annotationTool = PROJECT_EXTRA_TOOLS.find(
        (tool) => tool.function.name === "get_user_pdf_annotations",
    );
    assert.ok(annotationTool);
    assert.match(annotationTool.function.description, /hilighted/i);
    assert.match(annotationTool.function.description, /하이라이트/);
    assert.match(
        annotationTool.function.description,
        /independent annotations/i,
    );
    assert.match(
        annotationTool.function.description,
        /annotation_type='comment'/,
    );
    assert.match(annotationTool.function.description, /Do not substitute/i);
    const properties = annotationTool.function.parameters.properties;
    assert.ok(properties.annotation_type);
    assert.ok(properties.has_comment);
    assert.match(
        properties.annotation_type.description,
        /all independent comment annotations/i,
    );
    assert.match(
        properties.has_comment.description,
        /Backward-compatible filter/i,
    );
});

test("project chat exposes the server-side annotation digest schema", () => {
    const digestTool = PROJECT_EXTRA_TOOLS.find(
        (tool) => tool.function.name === "get_annotation_digest",
    );
    assert.ok(digestTool);
    const properties = digestTool.function.parameters.properties;
    for (const name of [
        "color_family",
        "annotation_type",
        "has_comment",
        "doc_ids",
        "party_roles",
        "party_sides",
        "grounded",
        "cursor",
    ]) {
        assert.ok(properties[name as keyof typeof properties]);
    }
    assert.match(digestTool.function.description, /independent annotations/i);
    assert.ok(properties.annotation_type);
    assert.ok(properties.has_comment);
    assert.match(
        properties.annotation_type.description,
        /all independent comment annotations/i,
    );
    assert.match(
        properties.has_comment.description,
        /Backward-compatible filter/i,
    );
});

test("filterToolsByDisabled is deny-only and ignores unknown tool names", () => {
    const tools = PROJECT_EXTRA_TOOLS.slice(0, 4);
    const filtered = filterToolsByDisabled(tools, [
        "get_user_pdf_annotations",
        "not_a_server_tool",
    ]);
    const names = filtered.map(
        (tool) => (tool as { function: { name: string } }).function.name,
    );
    assert.equal(names.includes("get_user_pdf_annotations"), false);
    assert.equal(
        names.length,
        tools.filter(
            (tool) =>
                (tool as { function: { name: string } }).function.name !==
                "get_user_pdf_annotations",
        ).length,
    );
});

type AnnotationTestRow = Record<string, unknown>;

class AnnotationQuery {
    private filters: Array<(row: AnnotationTestRow) => boolean> = [];
    constructor(private readonly rows: AnnotationTestRow[]) {}
    select() {
        return this;
    }
    eq(column: string, value: unknown) {
        this.filters.push((row) => row[column] === value);
        return this;
    }
    neq(column: string, value: unknown) {
        this.filters.push((row) => row[column] !== value);
        return this;
    }
    in(column: string, values: unknown[]) {
        this.filters.push((row) => values.includes(row[column]));
        return this;
    }
    is(column: string, value: unknown) {
        this.filters.push((row) => row[column] === value);
        return this;
    }
    not(column: string, op: string, value: unknown) {
        assert.equal(op, "is");
        this.filters.push((row) => row[column] !== value);
        return this;
    }
    then<
        TResult1 = { data: AnnotationTestRow[]; error: null },
        TResult2 = never,
    >(
        onfulfilled?:
            | ((value: {
                  data: AnnotationTestRow[];
                  error: null;
              }) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null,
    ) {
        return Promise.resolve({
            data: this.rows.filter((row) =>
                this.filters.every((filter) => filter(row)),
            ),
            error: null,
        }).then(onfulfilled, onrejected);
    }
}

function annotationDb(rows: AnnotationTestRow[]) {
    return { from: () => new AnnotationQuery(rows) } as never;
}

test("fetchUserPdfAnnotations scopes rows to matched docs, user query, and current version", async () => {
    const rows = [
        {
            id: "keep",
            document_id: "document-a",
            version_id: "version-a",
            page_number: 12,
            annotation_type: "highlight",
            color: "#ffff00",
            quote: "The DAO may appoint a manager.",
            comment: null,
            source: "user",
            created_at: "2026-07-10T12:00:00Z",
            deleted_at: null,
        },
        {
            id: "old-version",
            document_id: "document-a",
            version_id: "version-old",
            page_number: 3,
            annotation_type: "highlight",
            color: "#ffff00",
            quote: "Stale text",
            comment: null,
            source: "user",
            created_at: "2026-07-09T12:00:00Z",
            deleted_at: null,
        },
        {
            id: "other-doc",
            document_id: "document-b",
            version_id: null,
            page_number: 1,
            annotation_type: "comment",
            color: "#ff0000",
            quote: null,
            comment: "Not part of the requested filename",
            source: "user",
            created_at: "2026-07-08T12:00:00Z",
            deleted_at: null,
        },
    ];
    const result = await fetchUserPdfAnnotations({
        userId: "user-a",
        db: annotationDb(rows.map((row) => ({ ...row, user_id: "user-a" }))),
        docIndex,
        documentQuery: "credit agreement",
    });

    assert.equal(result.total, 1);
    assert.equal(result.returned, 1);
    assert.deepEqual(result.annotations, [
        {
            id: "keep",
            doc_id: "doc-0",
            document_id: "document-a",
            filename: "credit-agreement.pdf",
            version_id: "version-a",
            page: 12,
            type: "highlight",
            color: "#ffff00",
            color_family: "yellow",
            quote: "The DAO may appoint a manager.",
            comment: null,
            source: "user",
            created_at: "2026-07-10T12:00:00Z",
        },
    ]);
    assert.equal(
        (result.summary as { project_total: number }).project_total,
        2,
    );
});

test("fetchUserPdfAnnotations applies filters and filtered summaries", async () => {
    const rows = [
        {
            id: "red",
            user_id: "user-a",
            document_id: "document-a",
            version_id: "version-a",
            page_number: 3,
            annotation_type: "highlight",
            color: "#ff8787",
            quote: "red",
            comment: "note",
            source: "user",
            created_at: "2026-01-01T00:00:00Z",
            deleted_at: null,
        },
        {
            id: "blue",
            user_id: "user-a",
            document_id: "document-a",
            version_id: "version-a",
            page_number: 4,
            annotation_type: "highlight",
            color: "#74c0fc",
            quote: "blue",
            comment: null,
            source: "citation_promotion",
            created_at: "2026-01-02T00:00:00Z",
            deleted_at: null,
        },
        {
            id: "gray",
            user_id: "user-a",
            document_id: "document-b",
            version_id: null,
            page_number: 1,
            annotation_type: "comment",
            color: "#dfdfdf",
            quote: null,
            comment: "",
            source: "user",
            created_at: "2026-01-03T00:00:00Z",
            deleted_at: null,
        },
    ];
    const red = await fetchUserPdfAnnotations({
        userId: "user-a",
        db: annotationDb(rows),
        docIndex,
        colorFamily: ["red"],
        source: "user",
        hasComment: true,
    });
    assert.deepEqual(
        (red.annotations as Array<{ id: string }>).map((row) => row.id),
        ["red"],
    );
    assert.deepEqual(red.summary, {
        total: 1,
        project_total: 3,
        by_color: [{ color: "#ff8787", color_family: "red", count: 1 }],
        by_document: [
            {
                doc_id: "document-a",
                filename: "credit-agreement.pdf",
                count: 1,
            },
        ],
        by_type: { highlight: 1 },
        by_source: { user: 1 },
        with_comment: 1,
    });
    const exact = await fetchUserPdfAnnotations({
        userId: "user-a",
        db: annotationDb(rows),
        docIndex,
        colors: ["#74C0FC"],
        source: "citation_promotion",
        hasComment: false,
    });
    assert.deepEqual(
        (exact.annotations as Array<{ id: string }>).map((row) => row.id),
        ["blue"],
    );
    const recent = await fetchUserPdfAnnotations({
        userId: "user-a",
        db: annotationDb(rows),
        docIndex,
        hasComment: false,
        order: "recent",
    });
    assert.deepEqual(
        (recent.annotations as Array<{ id: string }>).map((row) => row.id),
        ["gray", "blue"],
    );
});

test("fetchUserPdfAnnotations dedupes identical saved highlights before counts and pagination", async () => {
    const base = {
        user_id: "user-a",
        document_id: "document-a",
        version_id: "version-a",
        page_number: 13,
        annotation_type: "highlight" as const,
        color: "#feffa0",
        quote: "The same selected passage.",
        comment: null,
        source: "user",
        deleted_at: null,
    };
    const result = await fetchUserPdfAnnotations({
        userId: "user-a",
        db: annotationDb([
            {
                ...base,
                id: "first-save",
                created_at: "2026-07-29T10:00:00Z",
            },
            {
                ...base,
                id: "duplicate-save",
                created_at: "2026-07-29T10:00:01Z",
            },
        ]),
        docIndex,
    });

    assert.equal(result.total, 1);
    assert.equal(result.returned, 1);
    assert.equal(
        (result.summary as { total: number; project_total: number }).total,
        1,
    );
    assert.equal(
        (result.summary as { total: number; project_total: number })
            .project_total,
        1,
    );
    assert.deepEqual(
        (result.annotations as Array<{ id: string }>).map((row) => row.id),
        ["first-save"],
    );
});

test("fetchUserPdfAnnotations paginates 900 rows without duplicates or the old cap", async () => {
    const rows = Array.from({ length: 900 }, (_, index) => ({
        id: `annotation-${index.toString().padStart(4, "0")}`,
        user_id: "user-a",
        document_id: index % 2 ? "document-b" : "document-a",
        version_id: index % 2 ? null : "version-a",
        page_number: Math.floor(index / 2) + 1,
        annotation_type: "highlight",
        color: index % 2 ? "#74c0fc" : "#feffa0",
        quote: `quote ${index}`,
        comment: null,
        source: "user",
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        deleted_at: null,
    }));
    const first = await fetchUserPdfAnnotations({
        userId: "user-a",
        db: annotationDb(rows),
        docIndex,
        limit: 100,
    });
    const second = await fetchUserPdfAnnotations({
        userId: "user-a",
        db: annotationDb(rows),
        docIndex,
        limit: 100,
        offset: 100,
    });
    const firstIds = (first.annotations as Array<{ id: string }>).map(
        (row) => row.id,
    );
    const secondIds = (second.annotations as Array<{ id: string }>).map(
        (row) => row.id,
    );
    assert.equal(first.total, 900);
    assert.equal(first.next_offset, 100);
    assert.equal(new Set([...firstIds, ...secondIds]).size, 200);
    assert.equal(
        (first.summary as { project_total: number }).project_total,
        900,
    );
});

test("annotation context locates same-page and cross-chunk quotes", () => {
    assert.deepEqual(
        extractAnnotationContext({
            quote: "target phrase",
            page: 1,
            radius: 7,
            chunks: [
                {
                    chunk_id: "chunk-single",
                    chunk_index: 0,
                    page_number: 1,
                    content: "prefix target phrase suffix",
                    start_char: 0,
                    end_char: 27,
                },
            ],
        }),
        {
            before: "prefix ",
            after: " suffix",
            located: true,
            chunk_id: "chunk-single",
            indexed_quote: "target phrase",
        },
    );
    const spanning = extractAnnotationContext({
        quote: "boundary overlap phrase",
        page: 2,
        radius: 20,
        chunks: [
            {
                chunk_id: "chunk-start",
                chunk_index: 0,
                page_number: 2,
                content: "before boundary overlap",
                start_char: 0,
                end_char: 23,
            },
            {
                chunk_id: "chunk-end",
                chunk_index: 1,
                page_number: 2,
                content: "overlap phrase after",
                start_char: 16,
                end_char: 36,
            },
        ],
    });
    assert.equal(spanning.located, true);
    assert.match(spanning.before, /before/);
    assert.match(spanning.after, /after/);
    assert.equal(spanning.chunk_id, "chunk-start");
    assert.equal(spanning.indexed_quote, "boundary overlap");
    assert.equal(
        "before boundary overlap".includes(spanning.indexed_quote ?? ""),
        true,
    );
});

test("annotation context returns bounded page text when a quote is absent", () => {
    const context = extractAnnotationContext({
        quote: "missing",
        page: 5,
        radius: 5,
        chunks: [
            {
                chunk_id: "chunk-fallback",
                chunk_index: 2,
                page_number: 5,
                content: "abcdefghijklmno",
                start_char: 0,
                end_char: 15,
            },
        ],
    });
    assert.deepEqual(context, {
        before: "",
        after: "",
        located: false,
        page_text: "abcdefghij",
    });
    assert.equal("chunk_id" in context, false);
    assert.equal("indexed_quote" in context, false);
});

test("basic annotation payloads expose registered handles for indexed quotes", () => {
    const registry = new PassageRegistry();
    const documentId = "11111111-1111-4111-8111-111111111111";
    const versionId = "version-a";
    const content =
        "Background text provides context for this synthetic legal record. The challenged statement allegedly targeted voters in several neighborhoods.";
    const payload = annotatePdfAnnotationPayload(
        {
            annotations: [
                {
                    id: "annotation-1",
                    doc_id: "doc-0",
                    document_id: documentId,
                    version_id: versionId,
                    page: 9,
                    quote: "The challenged statement allegedly targeted voters in several neighborhoods.",
                },
            ],
        },
        registry,
        {
            "doc-0": {
                document_id: documentId,
                version_id: versionId,
                filename: "synthetic.pdf",
            },
        },
        () => [
            {
                chunk_id: "chunk-a",
                chunk_index: 4,
                page_number: 9,
                content,
                start_char: 800,
                end_char: 800 + content.length,
            },
        ],
    );

    const annotation = (
        payload.annotations as Array<Record<string, unknown>>
    )[0];
    assert.equal(annotation.chunk_id, "chunk-a");
    assert.match(String(annotation.indexed_quote), /^\[p2\] /);
    assert.equal(annotation.citation_passage, "p2");
    const resolved = registry.resolve("p2");
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
        assert.equal(resolved.citation.documentId, documentId);
        assert.equal(resolved.citation.page, 9);
        assert.equal(
            resolved.citation.quote,
            "The challenged statement allegedly targeted voters in several neighborhoods.",
        );
    }
});

test("readAnnotationContexts caps ids and radius and prevents cross-document access", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
        id: `id-${index}`,
        user_id: "user-a",
        document_id: "document-a",
        version_id: "version-a",
        page_number: 1,
        annotation_type: "highlight",
        color: "#feffa0",
        quote: `quote ${index}`,
        comment: null,
        source: "user",
        created_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
    }));
    rows.push({
        ...rows[0],
        id: "outside",
        document_id: "outside-document",
        version_id: "outside-version",
    });
    const result = await readAnnotationContexts({
        userId: "user-a",
        db: annotationDb(rows),
        docIndex,
        annotationIds: [...rows.map((row) => row.id), "outside"],
        radius: 9999,
        loadChunks: () => [
            {
                chunk_id: "annotations-chunk",
                chunk_index: 0,
                page_number: 1,
                content: rows.map((row) => row.quote).join(" -- "),
                start_char: 0,
                end_char: 500,
            },
        ],
    });
    assert.equal(result.requested, 20);
    assert.equal(result.returned, 20);
    assert.equal(result.radius, 2000);
    assert.equal(
        (result.contexts as Array<{ annotation_id: string }>).some(
            (row) => row.annotation_id === "outside",
        ),
        false,
    );
    const firstContext = (
        result.contexts as Array<{ chunk_id?: string; indexed_quote?: string }>
    )[0];
    assert.equal(firstContext.chunk_id, "annotations-chunk");
    assert.equal(firstContext.indexed_quote, "quote 0");
});

test("filterDocContext preserves original slugs while filtering every context map", () => {
    const store: DocStore = new Map([
        [
            "doc-0",
            {
                storage_path: "a.pdf",
                file_type: "pdf",
                filename: "credit-agreement.pdf",
            },
        ],
        [
            "doc-1",
            {
                storage_path: "b.pdf",
                file_type: "pdf",
                filename: "shareholders-agreement.pdf",
            },
        ],
    ]);
    const paths = new Map([
        ["doc-0", "Pleadings / Claimant"],
        ["doc-1", "Pleadings / Respondent"],
    ]);

    const filtered = filterDocContext(docIndex, store, paths, ["document-b"]);

    assert.deepEqual(Object.keys(filtered.docIndex), ["doc-1"]);
    assert.deepEqual([...filtered.docStore.keys()], ["doc-1"]);
    assert.deepEqual(
        [...filtered.folderPaths.entries()],
        [["doc-1", "Pleadings / Respondent"]],
    );
});

test("resolveSearchDocumentIds maps slugs and intersects the enforced source scope", () => {
    assert.deepEqual(resolveSearchDocumentIds(["doc-0"], docIndex), {
        documentIds: ["document-a"],
    });
    assert.deepEqual(
        resolveSearchDocumentIds(["doc-0", "doc-1", "unknown"], docIndex, [
            "document-b",
        ]),
        { documentIds: ["document-b"] },
    );
    assert.match(
        resolveSearchDocumentIds(["unknown"], docIndex).error ?? "",
        /None of the requested doc_ids/,
    );
    assert.deepEqual(
        resolveSearchDocumentIds(undefined, docIndex, ["document-b"]),
        {
            documentIds: ["document-b"],
        },
    );
});

test("extractAnnotations preserves citation metadata for inline markers", () => {
    const text = `The borrower must deliver CPs [1].

<CITATIONS>
[
  {"ref":1,"doc_id":"doc-0","page":7,"quote":"deliver each Condition Precedent"}
]
</CITATIONS>`;

    assert.deepEqual(extractAnnotations(text, docIndex), [
        {
            type: "citation_data",
            ref: 1,
            doc_id: "doc-0",
            document_id: "document-a",
            version_id: "version-a",
            version_number: 3,
            filename: "credit-agreement.pdf",
            page: 7,
            quote: "deliver each Condition Precedent",
        },
    ]);
});

test("extractAnnotations supports multiple refs and page ranges", () => {
    const text = `The agreement covers CPs [1] and transfer rights [2].

<CITATIONS>
[
  {"ref":1,"doc_id":"doc-0","page":"41-42","quote":"conditions precedent are listed"},
  {"ref":2,"doc_id":"doc-1","page":12,"quote":"shares may not be transferred"}
]
</CITATIONS>`;

    const annotations = extractAnnotations(text, docIndex) as Record<
        string,
        unknown
    >[];

    assert.equal(annotations.length, 2);
    assert.equal(annotations[0].page, "41-42");
    assert.equal(annotations[0].quote, "conditions precedent are listed");
    assert.equal(annotations[1].document_id, "document-b");
    assert.equal(annotations[1].filename, "shareholders-agreement.pdf");
});

test("citation contract drops only offending citations and keeps valid ones", () => {
    const text = `Alpha [1]. Unknown [2]. Duplicate [3]. Omega [4].

<CITATIONS>
[
  {"ref":1,"doc_id":"doc-0","page":1,"quote":"alpha"},
  {"ref":2,"doc_id":"doc-unknown","page":2,"quote":"unknown"},
  {"ref":3,"doc_id":"doc-0","page":3,"quote":"duplicate one"},
  {"ref":3,"doc_id":"doc-1","page":3,"quote":"duplicate two"},
  {"ref":4,"doc_id":"doc-1","page":4,"quote":"omega"}
]
</CITATIONS>`;
    const citations = [
        { ref: 1, doc_id: "doc-0", page: 1, quote: "alpha" },
        { ref: 2, doc_id: "doc-unknown", page: 2, quote: "unknown" },
        { ref: 3, doc_id: "doc-0", page: 3, quote: "duplicate one" },
        { ref: 3, doc_id: "doc-1", page: 3, quote: "duplicate two" },
        { ref: 4, doc_id: "doc-1", page: 4, quote: "omega" },
    ];

    const result = validateCitationContract(text, citations, docIndex);

    assert.deepEqual(
        result.citations.map((citation) => citation.ref),
        [1, 4],
    );
    assert.deepEqual(result.errors, [
        { code: "unknown_document", ref: 2 },
        { code: "duplicate_ref", ref: 3 },
    ]);
});

test("citation contract accepts exactly one sequential marker per source", () => {
    const text = `Waterfall [1]. Control [2].

<CITATIONS>
[
  {"ref":1,"doc_id":"doc-0","page":2,"quote":"waterfall"},
  {"ref":2,"doc_id":"doc-0","page":3,"quote":"control"}
]
</CITATIONS>`;
    const citations = [
        { ref: 1, doc_id: "doc-0", page: 2, quote: "waterfall" },
        { ref: 2, doc_id: "doc-0", page: 3, quote: "control" },
    ];

    const result = validateCitationContract(text, citations, docIndex);

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.citations, citations);
});

test("citation contract drops only an orphan citation", () => {
    const citations = [
        { ref: 1, doc_id: "doc-0", page: 1, quote: "alpha" },
        { ref: 2, doc_id: "doc-1", page: 2, quote: "orphan" },
    ];

    const result = validateCitationContract("Alpha [1].", citations, docIndex);

    assert.deepEqual(result.citations, [citations[0]]);
    assert.deepEqual(result.errors, [{ code: "orphan_citation", ref: 2 }]);
});

test("handle citations resolve to the unchanged persisted annotation shape", () => {
    const registry = new PassageRegistry();
    registry.registerChunk({
        docId: "doc-0",
        documentId: "document-a",
        versionId: "version-a",
        chunkId: "chunk-handle",
        page: 9,
        content:
            "The borrower must deliver every synthetic condition precedent before the first utilization date.",
    });
    const text = `The conditions must be delivered before utilization [1].

<CITATIONS>
[{"ref":1,"passage":"p1"}]
</CITATIONS>`;
    const contract = validateCitationContract(
        text,
        parseCitations(text),
        docIndex,
        registry,
    );

    assert.deepEqual(contract.errors, []);
    assert.deepEqual(
        extractAnnotations(text, docIndex, [], contract.citations),
        [
            {
                type: "citation_data",
                ref: 1,
                doc_id: "doc-0",
                document_id: "document-a",
                version_id: "version-a",
                version_number: 3,
                filename: "credit-agreement.pdf",
                page: 9,
                quote: "The borrower must deliver every synthetic condition precedent before the first utilization date.",
                chunk_id: "chunk-handle",
                quote_start: 0,
                quote_end: 96,
            },
        ],
    );
});

test("extractAnnotations persists an unconfirmed support tier", () => {
    assert.deepEqual(
        extractAnnotations(
            "",
            docIndex,
            [],
            [
                {
                    ref: 1,
                    doc_id: "doc-0",
                    page: 9,
                    quote: "Named source passage.",
                    support: "unconfirmed",
                },
            ],
        ),
        [
            {
                type: "citation_data",
                ref: 1,
                doc_id: "doc-0",
                document_id: "document-a",
                version_id: "version-a",
                version_number: 3,
                filename: "credit-agreement.pdf",
                page: 9,
                quote: "Named source passage.",
                support: "unconfirmed",
            },
        ],
    );
});

test("citation contract dual-accepts handles and legacy quote entries", () => {
    const registry = new PassageRegistry();
    registry.registerChunk({
        docId: "doc-0",
        documentId: "document-a",
        versionId: "version-a",
        chunkId: "chunk-handle",
        page: 4,
        content:
            "The first synthetic proposition is supported by indexed source text with adequate detail.",
    });
    const text = `Indexed claim [1]. Legacy claim [2].

<CITATIONS>
[
  {"ref":1,"passage":"p1"},
  {"ref":2,"doc_id":"doc-1","page":12,"quote":"legacy source words"}
]
</CITATIONS>`;
    const result = validateCitationContract(
        text,
        parseCitations(text),
        docIndex,
        registry,
    );

    assert.deepEqual(result.errors, []);
    assert.equal(result.citations[0].protocol, "handle");
    assert.equal(result.citations[1].protocol, undefined);
    assert.equal(result.citations[1].quote, "legacy source words");
});

test("citation contract reports malformed and unknown passage handles", () => {
    const registry = new PassageRegistry();
    const text = `Malformed [1]. Unknown [2].

<CITATIONS>
[
  {"ref":1,"passage":"chunk-a"},
  {"ref":2,"passage":"p99"}
]
</CITATIONS>`;
    const result = validateCitationContract(
        text,
        parseCitations(text),
        docIndex,
        registry,
    );

    assert.deepEqual(result.citations, []);
    assert.deepEqual(result.errors, [
        { code: "invalid_passage_range", ref: 1 },
        { code: "unknown_passage", ref: 2 },
    ]);
});

test("leaked passage handles beside matching filenames become verified markers", () => {
    const registry = new PassageRegistry();
    const documentId = "11111111-1111-4111-8111-111111111111";
    const sourceText =
        "The synthetic indexed statement provides enough detail to support the asserted proposition.";
    registry.registerChunk({
        docId: "doc-0",
        documentId,
        versionId: "version-a",
        chunkId: "chunk-a",
        content: sourceText,
        page: 7,
        startChar: 200,
        endChar: 200 + sourceText.length,
    });
    const index: DocIndex = {
        "doc-0": {
            document_id: documentId,
            version_id: "version-a",
            filename: "synthetic.pdf",
        },
    };

    const recovered = recoverLeakedPassageHandleCitations(
        "Supported claim [doc-0, p1].",
        registry,
        index,
    );
    assert.equal(recovered.recovered, 1);
    assert.match(recovered.text, /Supported claim \[1\]\./);
    assert.deepEqual(parseCitations(recovered.text), [
        { ref: 1, passage: "p1" },
    ]);
    const contract = validateCitationContract(
        recovered.text,
        parseCitations(recovered.text),
        index,
        registry,
    );
    assert.equal(contract.errors.length, 0);
    assert.equal(contract.citations[0].quote, sourceText);

    assert.deepEqual(
        recoverLeakedPassageHandleCitations(
            "Wrong source [doc-1, p1].",
            registry,
            index,
        ),
        { text: "Wrong source [doc-1, p1].", recovered: 0 },
    );
});

test("bare leaked passage handle tokens become citation markers or are stripped", () => {
    const registry = new PassageRegistry();
    registry.registerChunk({
        docId: "doc-0",
        documentId: "document-a",
        versionId: "version-a",
        chunkId: "chunk-round2",
        page: 7,
        content:
            "First synthetic support sentence includes enough detail for conversion. Second synthetic support sentence independently supports a range. Third synthetic support sentence completes that range.",
    });
    const p1 = registry.resolve("p1");
    assert.equal(p1.ok, true);
    if (!p1.ok) throw new Error("expected p1 to resolve");
    const existing = {
        ref: 4,
        doc_id: p1.citation.docId,
        page: p1.citation.page,
        quote: p1.citation.quote,
        chunk_id: p1.citation.chunkId,
        quote_start: p1.citation.quoteStart,
        quote_end: p1.citation.quoteEnd,
        protocol: "handle" as const,
    };

    const result = convertLeakedPassageHandleTokens(
        [
            "Existing citation reuses the verified ref [p1].",
            "Repeated support [p2] and again [p2].",
            "Range support [p2-p3].",
            "Unknown support [p99].",
            '"Quoted support [p3]" stays outside the quote.',
            "Already marked [1] [p3].",
        ].join("\n"),
        [existing],
        registry,
    );

    assert.equal(result.converted, 6);
    assert.equal(result.dropped, 1);
    assert.doesNotMatch(result.text, /\[p\d/);
    assert.match(result.text, /verified ref\. \[4\]/);
    assert.match(result.text, /Repeated support \[5\] and again\. \[5\]/);
    assert.match(result.text, /Range support\. \[6\]/);
    assert.match(result.text, /Unknown support\./);
    assert.match(result.text, /"Quoted support" \[\d+\] stays outside/);
    assert.match(result.text, /Already marked \[1\]\. \[\d+\]/);
    assert.equal(result.citations.length, 4);
    assert.deepEqual(
        result.citations.map((citation) => citation.ref),
        [4, 5, 6, 7],
    );
    assert.equal(
        result.citations.every((citation) => citation.protocol === "handle"),
        true,
    );
});

test("converted handles feed duplicate enforcement and orphan counting", () => {
    const registry = new PassageRegistry();
    registry.registerChunk({
        docId: "doc-0",
        documentId: "document-a",
        versionId: "version-a",
        chunkId: "chunk-ordering",
        page: 2,
        content:
            "The exact supported statement appears in indexed text. Another sentence has unrelated support.",
    });

    const converted = convertLeakedPassageHandleTokens(
        [
            "The exact supported statement [p1].",
            "Registration records concern a different dispute whose unrelated procedural history, filing dates, docket management, scheduling orders, discovery deadlines, witness lists, exhibit numbering, hearing logistics, and administrative notices do not repeat the verified proposition [p1].",
            "Missing marker [9].",
        ].join("\n"),
        [],
        registry,
    );
    const singleOccurrence = assignCitationSupportByOccurrence(
        converted.text,
        converted.citations,
    );

    assert.equal(converted.converted, 2);
    assert.equal(singleOccurrence.citationsVerified, 1);
    assert.equal(singleOccurrence.citationsUnconfirmed, 1);
    assert.equal(
        countOrphanCitationMarkers(
            singleOccurrence.text,
            singleOccurrence.citations,
        ),
        1,
    );
});

test("comma-separated passage handles convert individually and malformed handles are dropped", () => {
    const registry = new PassageRegistry();
    registry.registerChunk({
        docId: "doc-0",
        documentId: "document-a",
        versionId: "version-a",
        chunkId: "chunk-list",
        page: 3,
        content:
            "First source sentence supports the combined claim. Second source sentence also supports the combined claim.",
    });

    const result = convertLeakedPassageHandleTokens(
        "Combined claim [p1, p2]. Malformed source [p51-p5ern].",
        [],
        registry,
    );

    assert.equal(result.text, "Combined claim. [1, 2] Malformed source.");
    assert.equal(result.converted, 2);
    assert.equal(result.dropped, 1);
    assert.deepEqual(
        result.citations.map((citation) => citation.ref),
        [1, 2],
    );
    assert.doesNotMatch(result.text, /\[p/i);
});

test("a passage leaked three times at supported locations becomes three linked markers", () => {
    const registry = new PassageRegistry();
    registry.registerChunk({
        docId: "doc-0",
        documentId: "document-a",
        versionId: "version-a",
        chunkId: "chunk-repeated-leak",
        page: 4,
        content:
            "The repeated source statement independently supports each comparison row.",
    });
    const statement =
        "The repeated source statement independently supports each comparison row";
    const converted = convertLeakedPassageHandleTokens(
        `${statement} [p1].\n${statement} [p1].\n${statement} [p1].`,
        [],
        registry,
    );
    const enforced = assignCitationSupportByOccurrence(
        converted.text,
        converted.citations,
    );

    assert.equal(converted.converted, 3);
    assert.deepEqual(citationMarkerRefs(enforced.text), [1, 2, 3]);
    assert.deepEqual(
        enforced.citations.map((citation) => citation.ref),
        [1, 2, 3],
    );
    assert.equal(
        countOrphanCitationMarkers(enforced.text, enforced.citations),
        0,
    );
    assert.equal(enforced.citationsVerified, 3);
    assert.equal(enforced.citationsUnconfirmed, 0);
});

test("renumberCitations compacts surviving refs and rewrites markers", () => {
    const compacted = renumberCitations("Alpha [1]. Gamma [3].", [
        { ref: 1, quote: "alpha" },
        { ref: 3, quote: "gamma" },
    ]);

    assert.equal(compacted.text, "Alpha [1]. Gamma [2].");
    assert.deepEqual(compacted.citations, [
        { ref: 1, quote: "alpha" },
        { ref: 2, quote: "gamma" },
    ]);
    assert.deepEqual(
        renumberCitations("Both [1, 2].", [{ ref: 1, quote: "alpha" }]),
        {
            text: "Both [1, 2].",
            citations: [{ ref: 1, quote: "alpha" }],
        },
    );
});

test("orphan citation marker count uses distinct visible refs", () => {
    assert.deepEqual(
        citationMarkerRefs("Alpha [1]. Both [2, 3]. Again [2]."),
        [1, 2, 3],
    );
    assert.equal(
        countOrphanCitationMarkers("Alpha [1]. Missing block [2].", []),
        2,
    );
    const elevenMarkers = Array.from(
        { length: 11 },
        (_, index) => `Claim [${index + 1}].`,
    ).join(" ");
    assert.equal(countOrphanCitationMarkers(elevenMarkers, []), 11);
    assert.equal(countOrphanCitationMarkers(elevenMarkers, [{ ref: 1 }]), 10);
    assert.equal(
        countOrphanCitationMarkers("Alpha [1]. Partial [2]. More [3].", [
            { ref: 1 },
        ]),
        2,
    );
    assert.equal(
        countOrphanCitationMarkers("Alpha [1]. Both [2, 3].", [
            { ref: 1 },
            { ref: 2 },
            { ref: 3 },
        ]),
        0,
    );
});

test("identical tool-call keys distinguish names and exact arguments", () => {
    const first = identicalToolCallKey(
        "find_in_document",
        '{"doc_id":"doc-0","query":"same"}',
    );
    assert.equal(
        first,
        identicalToolCallKey(
            "find_in_document",
            '{"doc_id":"doc-0","query":"same"}',
        ),
    );
    assert.notEqual(
        first,
        identicalToolCallKey(
            "find_in_document",
            '{"doc_id":"doc-0","query":"different"}',
        ),
    );
    assert.notEqual(
        first,
        identicalToolCallKey(
            "read_document",
            '{"doc_id":"doc-0","query":"same"}',
        ),
    );
});

test("duplicate adjacent citation evidence collapses to one marker", () => {
    assert.deepEqual(
        dedupeCitationEvidence("Same claim [1] [2].", [
            { ref: 1, doc_id: "doc-0", page: 1, quote: "same evidence" },
            { ref: 2, doc_id: "doc-0", page: 1, quote: "same evidence" },
        ]),
        {
            text: "Same claim [1].",
            citations: [
                { ref: 1, doc_id: "doc-0", page: 1, quote: "same evidence" },
            ],
        },
    );
});

test("duplicate marker occurrences keep both evidence destinations with honest tiers", () => {
    const result = assignCitationSupportByOccurrence(
        [
            "Plaintiff says the registration list was inaccurate [1].",
            "Defendant confirms no demographic tags appeared on these phone lists [1].",
        ].join("\n"),
        [
            {
                ref: 1,
                quote: "No demographic tags appeared on these phone lists.",
            },
        ],
    );

    assert.match(result.text, /inaccurate \[1\]/);
    assert.match(result.text, /phone lists \[2\]/);
    assert.deepEqual(result.citations, [
        {
            ref: 1,
            quote: "No demographic tags appeared on these phone lists.",
            support: "unconfirmed",
        },
        {
            ref: 2,
            quote: "No demographic tags appeared on these phone lists.",
            support: "verified",
        },
    ]);
    assert.equal(result.citationsVerified, 1);
    assert.equal(result.citationsUnconfirmed, 1);
});

test("supported repeat occurrences clone identical evidence under distinct refs", () => {
    const citation = {
        ref: 1,
        doc_id: "doc-0",
        document_id: "document-a",
        page: 9,
        quote: "The same source sentence supports this repeated claim.",
        chunk_id: "chunk-repeat",
        quote_start: 40,
        quote_end: 94,
        protocol: "handle" as const,
    };
    const result = assignCitationSupportByOccurrence(
        [
            "The same source sentence supports this repeated claim [1].",
            "The same source sentence supports this repeated claim [1].",
            "The same source sentence supports this repeated claim [1].",
        ].join("\n"),
        [citation],
    );

    assert.equal(
        result.text,
        [
            "The same source sentence supports this repeated claim [1].",
            "The same source sentence supports this repeated claim [2].",
            "The same source sentence supports this repeated claim [3].",
        ].join("\n"),
    );
    assert.deepEqual(
        result.citations.map(({ ref }) => ref),
        [1, 2, 3],
    );
    assert.deepEqual(
        result.citations.map(
            ({ ref: _ref, support: _support, ...evidence }) => evidence,
        ),
        [citation, citation, citation].map(({ ref: _ref, ...evidence }) => ({
            ...evidence,
        })),
    );
    assert.deepEqual(
        result.citations.map((citation) => citation.support),
        ["verified", "verified", "verified"],
    );
    assert.equal(result.citationsVerified, 3);
    assert.equal(result.citationsUnconfirmed, 0);
    assert.equal(countOrphanCitationMarkers(result.text, result.citations), 0);
});

test("mixed repeat support assigns the correct tier to every occurrence", () => {
    const result = assignCitationSupportByOccurrence(
        [
            "The verified source says randomized telephone numbers were used [1].",
            "An unrelated plaintiff claim concerns registration records, procedural history, filing dates, docket management, scheduling orders, discovery deadlines, witness lists, exhibit numbering, hearing logistics, administrative notices, and other matters that do not repeat the verified proposition [1].",
            "Again, randomized telephone numbers were used [1].",
        ].join("\n"),
        [
            {
                ref: 1,
                quote: "Randomized telephone numbers were used.",
                doc_id: "doc-6",
                chunk_id: "chunk-defense",
                quote_start: 10,
                quote_end: 49,
            },
        ],
    );

    assert.match(result.text, /were used \[1\]/);
    assert.match(result.text, /verified proposition \[2\]/);
    assert.match(
        result.text,
        /Again, randomized telephone numbers were used \[3\]/,
    );
    assert.deepEqual(
        result.citations.map(({ ref }) => ref),
        [1, 2, 3],
    );
    assert.deepEqual(
        result.citations.map((citation) => citation.support),
        ["verified", "unconfirmed", "verified"],
    );
    assert.equal(result.citationsVerified, 2);
    assert.equal(result.citationsUnconfirmed, 1);
    assert.equal(countOrphanCitationMarkers(result.text, result.citations), 0);
});

test("single supported citation marker occurrence is scored", () => {
    const citations = [{ ref: 1, quote: "The exact supported statement." }];
    assert.deepEqual(
        assignCitationSupportByOccurrence(
            "The exact supported statement [1].",
            citations,
        ),
        {
            text: "The exact supported statement [1].",
            citations: [
                {
                    ref: 1,
                    quote: "The exact supported statement.",
                    support: "verified",
                },
            ],
            citationsVerified: 1,
            citationsUnconfirmed: 0,
        },
    );
});

test("single unsupported citation stays clickable as unconfirmed", () => {
    const result = assignCitationSupportByOccurrence(
        "The filing concerned registration records [1].",
        [
            {
                ref: 1,
                quote: "Randomized telephone numbers were used.",
                doc_id: "doc-6",
        },
        ],
    );

    assert.equal(result.text, "The filing concerned registration records [1].");
    assert.deepEqual(result.citations, [
        {
            ref: 1,
            quote: "Randomized telephone numbers were used.",
            doc_id: "doc-6",
            support: "unconfirmed",
        },
    ]);
    assert.equal(result.citationsVerified, 0);
    assert.equal(result.citationsUnconfirmed, 1);
    assert.equal(countOrphanCitationMarkers(result.text, result.citations), 0);
});

test("unsupported occurrences remain linked but are never verified", () => {
    const result = assignCitationSupportByOccurrence(
        "Unrelated first claim [1]. Another unrelated claim [1].",
        [{ ref: 1, quote: "Completely different source language." }],
    );
    assert.equal(
        result.text,
        "Unrelated first claim [1]. Another unrelated claim [2].",
    );
    assert.deepEqual(result.citations, [
        {
            ref: 1,
            quote: "Completely different source language.",
            support: "unconfirmed",
        },
        {
            ref: 2,
            quote: "Completely different source language.",
            support: "unconfirmed",
        },
    ]);
    assert.equal(result.citationsVerified, 0);
    assert.equal(result.citationsUnconfirmed, 2);
});

test("distinct citation source counting ignores cloned refs and preserves incomplete entries", () => {
    const sharedSource = {
        doc_id: "doc-0",
        document_id: "document-a",
        chunk_id: "chunk-a",
        quote_start: 10,
        quote_end: 30,
    };
    assert.equal(
        countDistinctCitationSources([
            { ref: 1, ...sharedSource },
            { ref: 2, ...sharedSource },
            {
                ref: 3,
                ...sharedSource,
                quote_start: 31,
                quote_end: 50,
            },
            { ref: 4, doc_id: "doc-legacy" },
            { ref: 5, doc_id: "doc-legacy" },
            {
                ref: 6,
                document_id: "document-b",
                chunk_id: "chunk-b",
                quote_start: 0,
                quote_end: 10,
                support: "unconfirmed",
            },
        ]),
        4,
    );
});

test("one bad citation among several keeps the good ones end to end", () => {
    const text = "Alpha [1]. Unknown [2]. Gamma [3].";
    const contract = validateCitationContract(
        text,
        [
            { ref: 1, doc_id: "doc-0", page: 1, quote: "alpha" },
            { ref: 2, doc_id: "doc-unknown", page: 2, quote: "unknown" },
            { ref: 3, doc_id: "doc-1", page: 3, quote: "gamma" },
        ],
        docIndex,
    );
    const repaired = renumberCitations(text, contract.citations);

    assert.equal(repaired.text, text);
    assert.deepEqual(
        repaired.citations.map((citation) => citation.ref),
        [1, 3],
    );
    assert.deepEqual(contract.errors, [{ code: "unknown_document", ref: 2 }]);
});

test("extractAnnotations ignores malformed citation blocks without crashing", () => {
    const text = `The answer has a bad citation block [1].

<CITATIONS>
not json
</CITATIONS>`;

    assert.deepEqual(extractAnnotations(text, docIndex), []);
});

test("sanitizeAssistantVisibleText removes internal labels but keeps unresolved markers", () => {
    const text = `The credit-agreement.pdf(doc-0) point is supported [1].

The source sentence also had a page-looking marker [19], and doc-1 should not be exposed.

<CITATIONS>
[
  {"ref":1,"doc_id":"doc-0","page":7,"quote":"deliver each Condition Precedent"}
]
</CITATIONS>`;

    assert.equal(
        sanitizeAssistantVisibleText(
            text,
            [{ ref: 1, doc_id: "doc-0", filename: "credit-agreement.pdf" }],
            docIndex,
        ),
        `The credit-agreement.pdf point is supported [1].

The source sentence also had a page-looking marker [19], and shareholders-agreement.pdf should not be exposed.`,
    );
});

test("sanitizeAssistantVisibleText removes punctuation artifacts beside unresolved markers", () => {
    assert.equal(
        sanitizeAssistantVisibleText(
            "$160,, [2] Robocall,. [3] debate,— [4]",
            [],
            {},
        ),
        "$160, [2] Robocall. [3] debate— [4]",
    );
});

test("sanitizeAssistantVisibleText unwraps simple Gemma LaTeX prose", () => {
    assert.equal(
        sanitizeAssistantVisibleText(
            String.raw`The range is $\text{materially complete}$ and continues $\dots$`,
            [],
            {},
        ),
        "The range is materially complete and continues …",
    );
});

test("sanitizeAssistantVisibleText removes leaked model thinking", () => {
    assert.equal(
        sanitizeAssistantVisibleText(
            "<think>I should search again.</think>Final answer [1].",
            [{ ref: 1, doc_id: "doc-0", filename: "credit-agreement.pdf" }],
            docIndex,
        ),
        "Final answer [1].",
    );
    assert.equal(
        sanitizeAssistantVisibleText(
            "I should read one more file.</think>Grounded final answer [1].",
            [{ ref: 1, doc_id: "doc-0", filename: "credit-agreement.pdf" }],
            docIndex,
        ),
        "Grounded final answer [1].",
    );
    assert.equal(
        sanitizeAssistantVisibleText(
            "<tool_call><function=find_in_document><parameter=query>termination</parameter></function></tool_call>Final answer [1].",
            [{ ref: 1, doc_id: "doc-0", filename: "credit-agreement.pdf" }],
            docIndex,
        ),
        "Final answer [1].",
    );
    assert.equal(
        sanitizeAssistantVisibleText(
            "Final answer [1].<tool_call><function=read_index_chunk>",
            [{ ref: 1, doc_id: "doc-0", filename: "credit-agreement.pdf" }],
            docIndex,
        ),
        "Final answer [1].",
    );
});

type WorkflowRow = {
    id: string;
    user_id: string;
    title: string;
    prompt_md: string;
    type: string;
};
type ShareRow = { workflow_id: string; shared_with_email: string };

class FakeQuery<T extends Record<string, unknown>> {
    private filters: { col: string; value: unknown; op: "eq" | "in" }[] = [];

    constructor(private readonly rows: T[]) {}

    select(): this {
        return this;
    }

    eq(col: string, value: unknown): this {
        this.filters.push({ col, value, op: "eq" });
        return this;
    }

    in(col: string, value: unknown[]): this {
        this.filters.push({ col, value, op: "in" });
        return this;
    }

    then<TResult1 = { data: T[]; error: null }, TResult2 = never>(
        onfulfilled?:
            | ((value: {
                  data: T[];
                  error: null;
              }) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null,
    ): Promise<TResult1 | TResult2> {
        const filtered = this.rows.filter((row) =>
            this.filters.every((filter) => {
                if (filter.op === "eq") return row[filter.col] === filter.value;
                return (filter.value as unknown[]).includes(row[filter.col]);
            }),
        );
        return Promise.resolve({ data: filtered, error: null }).then(
            onfulfilled,
            onrejected,
        );
    }
}

function fakeDb(args: { workflows: WorkflowRow[]; shares: ShareRow[] }) {
    return {
        from(table: string) {
            if (table === "workflows") return new FakeQuery(args.workflows);
            if (table === "workflow_shares") return new FakeQuery(args.shares);
            throw new Error(`Unexpected table: ${table}`);
        },
    };
}

test("buildWorkflowStore seeds built-ins and overlays user/shared assistant workflows", async () => {
    const db = fakeDb({
        workflows: [
            {
                id: "owned-assistant",
                user_id: "local-user",
                title: "Owned Assistant",
                prompt_md: "owned prompt",
                type: "assistant",
            },
            {
                id: "owned-tabular",
                user_id: "local-user",
                title: "Owned Tabular",
                prompt_md: "tabular prompt",
                type: "tabular",
            },
            {
                id: "shared-assistant",
                user_id: "someone-else",
                title: "Shared Assistant",
                prompt_md: "shared prompt",
                type: "assistant",
            },
        ],
        shares: [
            {
                workflow_id: "shared-assistant",
                shared_with_email: "user@example.com",
            },
        ],
    });

    const store = await buildWorkflowStore(
        "local-user",
        "USER@example.com",
        db as never,
    );

    assert.equal(
        store.get(BUILTIN_WORKFLOWS[0].id)?.prompt_md,
        BUILTIN_WORKFLOWS[0].prompt_md,
    );
    assert.equal(store.get("owned-assistant")?.prompt_md, "owned prompt");
    assert.equal(store.has("owned-tabular"), false);
    assert.equal(store.get("shared-assistant")?.prompt_md, "shared prompt");
});

test("backend assistant built-in workflows keep the upstream Mike catalog", () => {
    assert.deepEqual(
        BUILTIN_WORKFLOWS.map((workflow) => workflow.id),
        EXPECTED_BACKEND_BUILTIN_WORKFLOW_IDS,
    );
    for (const workflow of BUILTIN_WORKFLOWS) {
        assert.ok(workflow.title.trim(), `${workflow.id} should have a title`);
        assert.ok(
            workflow.prompt_md.includes("## "),
            `${workflow.id} should keep a structured prompt`,
        );
    }
});

test("issue comparison workflow requires verified citations in table cells", () => {
    const workflow = BUILTIN_WORKFLOWS.find(
        (candidate) => candidate.id === "builtin-issue-comparison",
    );

    assert.ok(workflow);
    assert.match(
        workflow.prompt_md,
        /\[N\] marker to every supported claim in every table cell/,
    );
    assert.match(workflow.prompt_md, /final <CITATIONS> block/);
    assert.match(
        workflow.prompt_md,
        /plain-text document names or page references are not verified and do not count as citations/,
    );
});

test("brief sequence workflow uses the evidence-backed novelty recipe", () => {
    const workflow = BUILTIN_WORKFLOWS.find(
        (candidate) => candidate.id === "builtin-brief-sequence-diff",
    );

    assert.equal(workflow?.title, "New Arguments Across Brief Sequence");
    assert.match(workflow?.prompt_md ?? "", /Call summarize_document/);
    assert.match(
        workflow?.prompt_md ?? "",
        /same party_side, and a lower brief_sequence/,
    );
    assert.match(workflow?.prompt_md ?? "", /NEW.*ELABORATED.*REPEATED/s);
    assert.match(
        workflow?.prompt_md ?? "",
        /wording change alone is never NEW/,
    );
    assert.match(
        workflow?.prompt_md ?? "",
        /Never assert novelty without evidence/,
    );
    assert.match(workflow?.prompt_md ?? "", /opposing party_side/);
    assert.match(
        workflow?.prompt_md ?? "",
        /Latest brief \+ citation \| Earlier brief status \+ citation \| Classification/,
    );
    assert.match(
        workflow?.prompt_md ?? "",
        /Every supported statement in every cell must carry a \[N\] marker/,
    );
    assert.match(workflow?.prompt_md ?? "", /final <CITATIONS> block/);
});
