export type ChatStreamErrorCode =
    | "LLM_RESPONSE_START_TIMEOUT"
    | "LLM_STREAM_IDLE_TIMEOUT"
    | "LLM_PROVIDER_ERROR"
    | "CHAT_STREAM_ERROR";

export type ChatStreamErrorPayload = {
    type: "error";
    code: ChatStreamErrorCode;
    message: string;
};

function errorCode(error: unknown): string | null {
    if (!error || typeof error !== "object" || !("code" in error)) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
}

export function presentChatStreamError(error: unknown): ChatStreamErrorPayload {
    const code = errorCode(error);
    if (code === "LLM_RESPONSE_START_TIMEOUT") {
        return {
            type: "error",
            code,
            message:
                "The local model did not start responding before the configured timeout. It may still be loading or processing a large prompt. Retry with a smaller document scope or increase LOCAL_LLM_RESPONSE_START_TIMEOUT_MS.",
        };
    }
    if (code === "LLM_STREAM_IDLE_TIMEOUT") {
        return {
            type: "error",
            code,
            message:
                "The local model stopped sending data before it finished. Retry the request or increase LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS.",
        };
    }

    const message = error instanceof Error ? error.message : "";
    if (
        code === "LLM_PROVIDER_ERROR" ||
        /(?:Ollama|OpenAI-compatible|Claude|Gemini) (?:chat )?failed/i.test(message)
    ) {
        return {
            type: "error",
            code: "LLM_PROVIDER_ERROR",
            message:
                "The model provider could not complete the request. Check that the selected local model service is running and try again.",
        };
    }

    return {
        type: "error",
        code: "CHAT_STREAM_ERROR",
        message:
            "The assistant stream ended unexpectedly. Please retry the request.",
    };
}
