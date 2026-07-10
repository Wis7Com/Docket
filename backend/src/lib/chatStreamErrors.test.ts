import test from "node:test";
import assert from "node:assert/strict";
import { presentChatStreamError } from "./chatStreamErrors";

test("presentChatStreamError exposes safe timeout guidance", () => {
    const error = Object.assign(new Error("secret provider detail"), {
        code: "LLM_RESPONSE_START_TIMEOUT",
    });

    assert.deepEqual(presentChatStreamError(error), {
        type: "error",
        code: "LLM_RESPONSE_START_TIMEOUT",
        message:
            "The local model did not start responding before the configured timeout. It may still be loading or processing a large prompt. Retry with a smaller document scope or increase LOCAL_LLM_RESPONSE_START_TIMEOUT_MS.",
    });
    assert.doesNotMatch(presentChatStreamError(error).message, /secret/);
});

test("presentChatStreamError classifies provider failures without leaking detail", () => {
    const payload = presentChatStreamError(
        new Error("Ollama chat failed (500): sensitive backend output"),
    );

    assert.equal(payload.code, "LLM_PROVIDER_ERROR");
    assert.doesNotMatch(payload.message, /sensitive/);
});
