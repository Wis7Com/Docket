import test from "node:test";
import assert from "node:assert/strict";
import {
    PROJECT_SYSTEM_PROMPT_EXTRA,
    PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT,
    PROJECT_ANNOTATION_TOOL_PROMPT,
    buildProjectColorLegendPrompt,
    buildSourceScopePrompt,
    buildRequestedAnnotationContext,
    describeAnnotationColor,
    requestedAnnotationColorFamilies,
    resolveSelectedDocumentScope,
    requestsAnnotationContext,
    requestsBriefSequenceDiff,
    buildProjectSystemPromptExtra,
} from "./projectChat";

test("project prompt includes the issue-by-issue comparison workflow", () => {
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /DOCUMENT COMPARISON REQUESTS/);
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /doc_ids scoping/);
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /one row per issue/);
    assert.match(
        PROJECT_SYSTEM_PROMPT_EXTRA,
        /\[N\] marker to every supported claim in each table cell/,
    );
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /final <CITATIONS> block/);
    assert.match(
        PROJECT_SYSTEM_PROMPT_EXTRA,
        /Plain-text document names or page references are not verified and do not count as citations/,
    );
});

test("project prompt routes Korean and English brief sequence diff requests", () => {
    assert.doesNotMatch(
        PROJECT_SYSTEM_PROMPT_EXTRA,
        /BRIEF SEQUENCE DIFF REQUESTS/,
    );
    assert.match(
        PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT,
        /BRIEF SEQUENCE DIFF REQUESTS/,
    );
    assert.match(PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT, /what's new in the reply/);
    assert.match(PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT, /준비서면/);
    assert.match(PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT, /N차 서면/);
    assert.match(PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT, /새로 주장/);
    assert.match(PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT, /이전 서면과 비교/);
    assert.match(
        PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT,
        /same party_side, and a lower brief_sequence/,
    );
    assert.match(
        PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT,
        /NEW only if substantively absent, ELABORATED.*REPEATED/s,
    );
    assert.match(
        PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT,
        /wording changes alone are never NEW/,
    );
    assert.match(
        PROJECT_BRIEF_SEQUENCE_DIFF_PROMPT,
        /Every supported statement in every cell must carry a \[N\] marker/,
    );
});

test("brief sequence diff recipe is injected only for matching turns or workflow", () => {
    const yes = [
        "ECF 245 재반박서가 ECF 213과 비교해 새로 제시한 주장을 정리해 줘",
        "What's new in the reply compared with the earlier brief?",
        "N차 서면에서 구체화한 주장과 이전 서면의 차이를 보여줘",
    ];
    for (const content of yes) {
        assert.equal(requestsBriefSequenceDiff({ content }), true);
        assert.match(
            buildProjectSystemPromptExtra([{ role: "user", content }]),
            /BRIEF SEQUENCE DIFF REQUESTS/,
        );
    }

    const no = [
        '답변서에서 "Project 1599"를 인정한 사실을 찾아줘',
        "우편투표 대신 직접 투표하도록 속이는 것이 권리 박탈이 아니라는 피고 논리를 찾아줘",
        "준비서면을 요약해줘",
        "두 계약서를 비교해줘",
    ];
    for (const content of no) {
        assert.equal(requestsBriefSequenceDiff({ content }), false);
        assert.doesNotMatch(
            buildProjectSystemPromptExtra([{ role: "user", content }]),
            /BRIEF SEQUENCE DIFF REQUESTS/,
        );
    }

    assert.equal(
        requestsBriefSequenceDiff({
            content: "이 요청을 실행해줘",
            workflow: {
                id: "builtin-brief-sequence-diff",
                title: "New Arguments Across Brief Sequence",
            },
        }),
        true,
    );
});

test("project prompt requires exhaustive summarization instead of one generic search", () => {
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /WHOLE-DOCUMENT SUMMARY RULE/);
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /call summarize_document/);
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /every indexed chunk/);
    assert.match(
        PROJECT_SYSTEM_PROMPT_EXTRA,
        /Never treat a single generic search_project_documents or find_in_document result as a whole-document summary/,
    );
    assert.match(PROJECT_SYSTEM_PROMPT_EXTRA, /never claim complete coverage/);
});

test("annotation prompt requires the dedicated tool instead of document search", () => {
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /MUST call get_user_pdf_annotations/,
    );
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /hilighted/);
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /하이라이트/);
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /Never substitute search_project_documents/,
    );
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /first call.*without color or document filters/s,
    );
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /next_offset/);
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /summary is computed over the complete filtered result set/,
    );
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /do not accumulate every raw annotation/,
    );
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /read_annotation_context/);
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /indexed_quote/);
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /chunk_id/);
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /user's current message/);
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /PROJECT COLOR LEGEND/);
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /colors exact-hex filter/);
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /user notes.*not document facts/,
    );
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /every opponent-response item must include a \[N\] marker/,
    );
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /final <CITATIONS> block/);
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /EXHAUSTIVE COLOR REVIEW CONTRACT/,
    );
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /get_annotation_digest summary\.total and the number of numbered answer sections must match/,
    );
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /N개 중 N개를 다룬다/);
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /exactly one numbered section for each annotation/,
    );
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /highlight's original text followed by the opposing party's response/,
    );
    assert.match(PROJECT_ANNOTATION_TOOL_PROMPT, /반박 미발견/);
    assert.match(
        PROJECT_ANNOTATION_TOOL_PROMPT,
        /하이라이트는 사용자의 읽기 우선순위이고, 사실 판단은 원문 검증 인용에 근거한다/,
    );
});

test("buildProjectColorLegendPrompt formats persisted entries", async () => {
    const db = {
        from(table: string) {
            assert.equal(table, "project_color_legend");
            return {
                select(fields: string) {
                    assert.match(fields, /party_role/);
                    return this;
                },
                eq(field: string, value: string) {
                    assert.equal(field, "project_id");
                    assert.equal(value, "project-a");
                    return this;
                },
                async order() {
                    return {
                        data: [
                            {
                                color_family: "green",
                                label: "다툼 없는 사실",
                                party_role: "피고",
                                party_side: null,
                            },
                        ],
                    };
                },
            };
        },
    };

    const prompt = await buildProjectColorLegendPrompt({
        db: db as never,
        projectId: "project-a",
    });
    assert.match(prompt ?? "", /- green \(피고\): 다툼 없는 사실/);
});

test("buildProjectColorLegendPrompt omits empty query results", async () => {
    const chain = {
        select() {
            return this;
        },
        eq() {
            return this;
        },
        async order() {
            return { data: [] };
        },
    };
    const prompt = await buildProjectColorLegendPrompt({
        db: { from: () => chain } as never,
        projectId: "project-a",
    });
    assert.equal(prompt, null);
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
    assert.equal(
        requestsAnnotationContext("Find the red flags in this agreement"),
        false,
    );
    assert.equal(
        requestsAnnotationContext(
            "빨간 색은 원고 주장, 파란 색은 피고 주장이니까 annotation을 대비한 표를 만들어",
        ),
        true,
    );
    assert.equal(
        requestsAnnotationContext("내가 comment 남긴 항목들을 정리해"),
        true,
    );
    assert.equal(
        requestsAnnotationContext("회색은 다툼 없는 사실이니 표로 만들어"),
        true,
    );
});

test("describeAnnotationColor adds readable labels for filterable colors", () => {
    assert.equal(describeAnnotationColor("#f783ac"), "pink");
    assert.equal(describeAnnotationColor("#74c0fc"), "blue");
    assert.equal(describeAnnotationColor("#feffa0"), "yellow");
    assert.equal(describeAnnotationColor("#ceffff"), "blue");
    assert.equal(describeAnnotationColor("#fed4ff"), "pink");
    assert.equal(describeAnnotationColor("#d1ffc3"), "green");
    assert.equal(describeAnnotationColor("not-a-color"), null);
    assert.deepEqual(
        [...requestedAnnotationColorFamilies("빨간 색, 회색, 보라색, grey")],
        ["red", "purple", "gray"],
    );
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
            color: "#ff8787",
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
            color: "#ff8787",
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
        latestUserText:
            "빨간색으로 하이라이트한 부분은 caveat이니까 강조점으로 요약해",
        displayedDoc: {
            document_id: "doc-outside",
            filename: "outside.pdf",
        },
    });

    assert.match(selectedFields[0], /\bcolor\b/);
    assert.match(context ?? "", /color=#ff8787 \(red\)/);
    assert.match(
        context ?? "",
        /quote="This obligation is subject to caveats\."/,
    );
    assert.doesNotMatch(context ?? "", /This blue note should not be included/);
    assert.doesNotMatch(context ?? "", /outside-scope annotation/);
});
