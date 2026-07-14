import { GoogleGenAI } from "@google/genai";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
} from "./types";
import { toGeminiTools } from "./tools";

type GeminiPart = {
    text?: string;
    // Set by Gemini when the text content is a thought summary rather than
    // final-answer prose. Requires `thinkingConfig.includeThoughts: true`.
    thought?: boolean;
    functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
    functionResponse?: {
        id?: string;
        name: string;
        response: Record<string, unknown>;
    };
    // Gemini 3 returns a thoughtSignature on parts that contain reasoning or
    // a functionCall. It must be echoed back verbatim on the same part when
    // we replay the model's turn, or the API rejects the next call.
    thoughtSignature?: string;
};

type GeminiContent = {
    role: "user" | "model";
    parts: GeminiPart[];
};

function geminiErrorStatus(error: unknown): number | null {
    if (!error || typeof error !== "object") return null;
    for (const key of ["status", "statusCode", "code"] as const) {
        const value = (error as Record<string, unknown>)[key];
        const parsed = typeof value === "number" ? value : Number(value);
        if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) {
            return parsed;
        }
    }
    return null;
}

function isRetryableGeminiError(error: unknown): boolean {
    const status = geminiErrorStatus(error);
    if (status !== null) return status === 429 || status >= 500;
    const message = error instanceof Error ? error.message : String(error);
    return /(?:fetch failed|network|socket|ECONNRESET|ETIMEDOUT|temporar|unavailable|resource exhausted)/i.test(
        message,
    );
}

function geminiProviderError(error: unknown): Error & { code: string } {
    const detail = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`Gemini chat failed: ${detail}`) as Error & {
        code: string;
        cause?: unknown;
    };
    wrapped.code = "LLM_PROVIDER_ERROR";
    wrapped.cause = error;
    return wrapped;
}

function client(override?: string | null): GoogleGenAI {
    const apiKey = override?.trim() || process.env.GEMINI_API_KEY || "";
    return new GoogleGenAI({ apiKey });
}

function toNativeContents(messages: StreamChatParams["messages"]): GeminiContent[] {
    return messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
    }));
}

export async function streamGemini(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    params.signal?.throwIfAborted();
    const { model, systemPrompt, tools = [], callbacks = {}, runTools, apiKeys, enableThinking } = params;
    const maxIter = params.maxIterations ?? 10;
    const ai = client(apiKeys?.gemini);
    const functionDeclarations = toGeminiTools(tools);

    const contents: GeminiContent[] = toNativeContents(params.messages);
    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        let textParts: string[] = [];
        let callParts: GeminiPart[] = [];
        let toolCalls: NormalizedToolCall[] = [];
        let sawThinking = false;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                params.signal?.throwIfAborted();
                const stream = await ai.models.generateContentStream({
                    model,
                    contents: contents as never,
                    config: {
                        // The SDK documents this as client-side cancellation;
                        // provider-side generation may continue after abort.
                        abortSignal: params.signal,
                        systemInstruction: systemPrompt,
                        tools: functionDeclarations.length
                            ? [{ functionDeclarations } as never]
                            : undefined,
                        thinkingConfig: enableThinking
                            ? { includeThoughts: true }
                            : { thinkingBudget: 0 },
                    },
                });

                for await (const chunk of stream) {
                    params.signal?.throwIfAborted();
                    const parts =
                        (chunk as { candidates?: { content?: { parts?: GeminiPart[] } }[] })
                            .candidates?.[0]?.content?.parts ?? [];

                    for (const part of parts) {
                        if (part.text) {
                            if (part.thought) {
                                sawThinking = true;
                                callbacks.onReasoningDelta?.(part.text);
                            } else {
                                textParts.push(part.text);
                                callbacks.onContentDelta?.(part.text);
                            }
                        }
                        if (part.functionCall) {
                            callParts.push(part);
                            const call: NormalizedToolCall = {
                                id: part.functionCall.id ?? `${part.functionCall.name}-${toolCalls.length}`,
                                name: part.functionCall.name,
                                input: part.functionCall.args ?? {},
                            };
                            callbacks.onToolCallStart?.(call);
                            toolCalls.push(call);
                        }
                    }
                }

                break;
            } catch (error) {
                params.signal?.throwIfAborted();
                if (sawThinking) callbacks.onReasoningBlockEnd?.();
                const canRetry =
                    attempt === 0 &&
                    textParts.length === 0 &&
                    callParts.length === 0 &&
                    isRetryableGeminiError(error);
                if (!canRetry) throw geminiProviderError(error);
                await new Promise((resolve) => setTimeout(resolve, 500));
                textParts = [];
                callParts = [];
                toolCalls = [];
                sawThinking = false;
                continue;
            }
        }

        if (sawThinking) callbacks.onReasoningBlockEnd?.();

        fullText += textParts.join("");

        if (!toolCalls.length || !runTools) {
            break;
        }

        const results = await runTools(toolCalls);

        // Append the model's turn (text + functionCall parts, in that order)
        // and the matching functionResponse turn.
        const modelParts: GeminiPart[] = [];
        if (textParts.length) modelParts.push({ text: textParts.join("") });
        for (const cp of callParts) modelParts.push(cp);
        contents.push({ role: "model", parts: modelParts });

        contents.push({
            role: "user",
            parts: results.map((r) => {
                const match = toolCalls.find((c) => c.id === r.tool_use_id);
                return {
                    functionResponse: {
                        ...(r.tool_use_id && !r.tool_use_id.startsWith(match?.name ?? "")
                            ? { id: r.tool_use_id }
                            : {}),
                        name: match?.name ?? "tool",
                        response: { output: r.content },
                    },
                };
            }),
        });
    }

    return { fullText };
}

export async function completeGeminiText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    apiKeys?: { gemini?: string | null };
}): Promise<string> {
    const ai = client(params.apiKeys?.gemini);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const resp = await ai.models.generateContent({
                model: params.model,
                contents: [{ role: "user", parts: [{ text: params.user }] }],
                config: params.systemPrompt
                    ? { systemInstruction: params.systemPrompt }
                    : undefined,
            });
            return resp.text ?? "";
        } catch (error) {
            if (attempt === 0 && isRetryableGeminiError(error)) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                continue;
            }
            throw geminiProviderError(error);
        }
    }
    return "";
}
