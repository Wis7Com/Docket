import test from "node:test";
import assert from "node:assert/strict";
import {
    PROJECT_SYSTEM_PROMPT_EXTRA,
    PROJECT_ANNOTATION_TOOL_PROMPT,
    buildSourceScopePrompt,
    buildRequestedAnnotationContext,
    describeAnnotationColor,
    requestedAnnotationColorFamilies,
    resolveSelectedDocumentScope,
    requestsAnnotationContext,
} from "./projectChat";

test("project prompt includes the issue-by-issue comparison workflow", () => {
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /DOCUMENT COMPARISON REQUESTS/);
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /doc_ids scoping/);
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /one row per issue/);
});

test("annotation prompt requires the dedicated tool instead of document search", () => {
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /MUST call get_user_pdf_annotations/);
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /hilighted/);
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /하이라이트/);
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /Never substitute search_project_documents/);
});

test("selected document scope ignores injected ids and fails open only for empty intersections", () => {
    const index = {
        "doc-0": { document_id: "doc-a", filename: "a.pdf" },
        "doc-2": { document_id: "doc-c", filename: "c.pdf" },
    };
    assert.deepEqual(
        resolveSelectedDocumentScope(["doc-c", "outside-project"], index),
        { documentIds: ["doc-c"] },
    );
    assert.equal(
        resolveSelectedDocumentScope(["outside-project"], index).documentIds,
        undefined,
    );
    assert.match(
        resolveSelectedDocumentScope([], index).warning ?? "",
        /empty/,
    );
    assert.deepEqual(resolveSelectedDocumentScope(undefined, index), {});
    assert.match(buildSourceScopePrompt(2), /2 selected documents/);
    assert.match(buildSourceScopePrompt(2), /displayed_doc/);
});

test("requestsAnnotationContext recognizes user-defined color emphasis prompts", () => {
    assert.equal(
        requestsAnnotationContext(
            "이 문서에서 빨간색으로 하이라이트한 부분은 caveat이니까, 이 부분을 강조점으로 해서 31페이지부터 42페이지까지 요약해",
        ),
        true,
    );
    assert.equal(
        requestsAnnotationContext("31페이지부터 42페이지까지 이 문서를 요약해"),
        false,
    );
    assert.equal(
        requestsAnnotationContext(
            "Fetch the important annotation that I made in the Smith 2024 Report and summarise it",
        ),
        true,
    );
    assert.equal(requestsAnnotationContext("Find the red flags in this agreement"), false);
});

test("describeAnnotationColor adds readable labels for filterable colors", () => {
    assert.equal(describeAnnotationColor("#f783ac"), "pink/red");
    assert.equal(describeAnnotationColor("#74c0fc"), "blue");
    assert.equal(describeAnnotationColor("not-a-color"), null);
    assert.deepEqual([...requestedAnnotationColorFamilies("빨간색은 caveat")], [
        "red",
    ]);
});

test("buildRequestedAnnotationContext includes and filters annotation color metadata", async () => {
    const selectedFields: string[] = [];
    const rows = [
        {
            id: "ann-blue",
            document_id: "doc-a",
            version_id: "version-a",
            page_number: 32,
            annotation_type: "highlight" as const,
            color: "#74c0fc",
            quote: "This blue note should not be included.",
            comment: null,
            source: "user" as const,
            created_at: "2026-01-02T00:00:00.000Z",
            deleted_at: null,
        },
        {
            id: "ann-red",
            document_id: "doc-a",
            version_id: "version-a",
            page_number: 31,
            annotation_type: "highlight" as const,
            color: "#f783ac",
            quote: "This obligation is subject to caveats.",
            comment: null,
            source: "user" as const,
            created_at: "2026-01-01T00:00:00.000Z",
            deleted_at: null,
        },
        {
            id: "ann-outside-scope",
            document_id: "doc-outside",
            version_id: "version-outside",
            page_number: 99,
            annotation_type: "highlight" as const,
            color: "#f783ac",
            quote: "This outside-scope annotation must never be included.",
            comment: null,
            source: "user" as const,
            created_at: "2026-01-03T00:00:00.000Z",
            deleted_at: null,
        },
    ];
    const db = {
        from(table: string) {
            assert.equal(table, "pdf_annotations");
            return {
                select(fields: string) {
                    selectedFields.push(fields);
                    return this;
                },
                eq() {
                    return this;
                },
                in() {
                    return this;
                },
                order() {
                    return this;
                },
                async limit() {
                    return { data: rows };
                },
            };
        },
    };

    const context = await buildRequestedAnnotationContext({
        userId: "user-a",
        db: db as never,
        docIndex: {
            "doc-0": {
                document_id: "doc-a",
                filename: "agreement.pdf",
                version_id: "version-a",
            },
        },
        latestUserText: "빨간색으로 하이라이트한 부분은 caveat이니까 강조점으로 요약해",
        displayedDoc: {
            document_id: "doc-outside",
            filename: "outside.pdf",
        },
    });

    assert.match(selectedFields[0], /\bcolor\b/);
    assert.match(context ?? "", /color=#f783ac \(pink\/red\)/);
    assert.match(
        context ?? "",
        /quote="This obligation is subject to caveats\."/,
    );
    assert.doesNotMatch(context ?? "", /This blue note should not be included/);
    assert.doesNotMatch(context ?? "", /outside-scope annotation/);
});
