import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_CITATION_REPAIR_MODEL,
    FINAL_ANSWER_CONTINUATION_PROMPT,
    isCitationRepairMapperUnavailable,
    resolveCitationRepairModel,
    runLLMStream,
    shouldContinueShortToolAnswer,
} from "./chatTools";

test("citation repair defaults to Qwen and accepts an explicit mapper model", () => {
    assert.equal(resolveCitationRepairModel(), DEFAULT_CITATION_REPAIR_MODEL);
    assert.equal(
        resolveCitationRepairModel("ollama:custom-mapper"),
        "ollama:custom-mapper",
    );
    assert.equal(
        resolveCitationRepairModel("not-a-provider:model"),
        DEFAULT_CITATION_REPAIR_MODEL,
    );
});

test("citation repair distinguishes an unavailable Ollama mapper", () => {
    assert.equal(
        isCitationRepairMapperUnavailable(
            new Error("Ollama chat failed (404): model qwen not found"),
        ),
        true,
    );
    assert.equal(
        isCitationRepairMapperUnavailable(new Error("fetch failed")),
        true,
    );
    assert.equal(
        isCitationRepairMapperUnavailable(
            new Error("fetch failed"),
            "openai:gpt-5.1",
        ),
        false,
    );
    assert.equal(
        isCitationRepairMapperUnavailable(
            new Error("outer", { cause: new Error("ECONNREFUSED") }),
        ),
        true,
    );
    assert.equal(
        isCitationRepairMapperUnavailable(new Error("response timed out")),
        false,
    );
});

test("short tool-answer continuation uses the trimmed 50-character boundary", () => {
    assert.equal(
        shouldContinueShortToolAnswer({
            answerText: `  ${"x".repeat(49)}  `,
            usedDocumentTools: true,
            continuationAttempted: false,
        }),
        true,
    );
    assert.equal(
        shouldContinueShortToolAnswer({
            answerText: "x".repeat(50),
            usedDocumentTools: true,
            continuationAttempted: false,
        }),
        false,
    );
    assert.equal(
        shouldContinueShortToolAnswer({
            answerText: "",
            usedDocumentTools: false,
            continuationAttempted: false,
        }),
        false,
    );
    assert.equal(
        shouldContinueShortToolAnswer({
            answerText: "",
            usedDocumentTools: true,
            continuationAttempted: true,
        }),
        false,
    );
    assert.equal(
        shouldContinueShortToolAnswer({
            answerText:
                '<CITATIONS>[{"ref":1,"doc_id":"doc-0","page":1,"quote":"source"}]</CITATIONS>',
            usedDocumentTools: true,
            continuationAttempted: false,
        }),
        true,
    );
});

test("runLLMStream continues a short document-tool answer exactly once", async () => {
    const oldFetch = globalThis.fetch;
    const oldRepair = process.env.DOCKET_CITATION_REPAIR;
    const oldConsoleLog = console.log;
    const requests: Record<string, unknown>[] = [];
    const writes: string[] = [];

    try {
        process.env.DOCKET_CITATION_REPAIR = "0";
        console.log = () => undefined;
        globalThis.fetch = (async (_input, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as Record<
                string,
                unknown
            >;
            requests.push(body);
            const requestNumber = requests.length;
            const message =
                requestNumber === 1
                    ? {
                          tool_calls: [
                              {
                                  function: {
                                      name: "search_project_documents",
                                      arguments: { query: "contract term" },
                                  },
                              },
                          ],
                      }
                    : { content: requestNumber === 2 ? "짧음" : "여전히 짧음" };
            return new Response(
                `${JSON.stringify({ message, done: true })}\n`,
                {
                    status: 200,
                    headers: { "Content-Type": "application/x-ndjson" },
                },
            );
        }) as typeof fetch;

        const result = await runLLMStream({
            apiMessages: [{ role: "user", content: "계약 조건을 찾아줘" }],
            docStore: new Map(),
            docIndex: {},
            userId: "user-1",
            db: {} as never,
            write: (value) => writes.push(value),
            model: "ollama:test-model",
        });

        assert.equal(requests.length, 3);
        assert.equal(result.fullText, "짧음여전히 짧음");
        const continuationMessages = requests[2].messages as Array<{
            role?: string;
            content?: string;
        }>;
        assert.match(
            continuationMessages[0]?.content ?? "",
            new RegExp(FINAL_ANSWER_CONTINUATION_PROMPT),
        );
        assert.equal(
            requests
                .map((request) => JSON.stringify(request))
                .join("")
                .split(FINAL_ANSWER_CONTINUATION_PROMPT).length - 1,
            1,
        );
        assert.match(
            continuationMessages.at(-1)?.content ?? "",
            /DOCUMENT TOOL RESULTS FROM THIS TURN/,
        );
        assert.equal("tools" in requests[2], false);
        const summary = result.events.find(
            (event) => event.type === "citation_summary",
        );
        assert.deepEqual(summary, {
            type: "citation_summary",
            verified_count: 0,
            used_document_tools: true,
        });
        assert.equal(
            writes.some((value) =>
                value.includes(
                    '"type":"citation_summary","verified_count":0,"used_document_tools":true',
                ),
            ),
            true,
        );
    } finally {
        globalThis.fetch = oldFetch;
        console.log = oldConsoleLog;
        if (oldRepair === undefined) delete process.env.DOCKET_CITATION_REPAIR;
        else process.env.DOCKET_CITATION_REPAIR = oldRepair;
    }
});
