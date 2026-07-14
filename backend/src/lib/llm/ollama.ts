import type {
  NormalizedToolCall,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import {
  fetchWithResponseStartTimeout,
  readWithStreamIdleTimeout,
} from "./timeouts";

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: {
    function: { name: string; arguments?: Record<string, unknown> };
  }[];
};

type OllamaChatResponse = {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: {
      function?: { name?: string; arguments?: Record<string, unknown> };
    }[];
  };
};

type OllamaChatStreamChunk = OllamaChatResponse & {
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
};

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_RESPONSE_START_TIMEOUT_ENV = "OLLAMA_RESPONSE_START_TIMEOUT_MS";
// Measured against gemma4:12b on Korean/English legal text: ~1.9-2.0 chars per
// token (delta method, prompt_eval_count). 2.5 over-fills batches for CJK-heavy
// input; 1.9 keeps a small safety margin. Override with OLLAMA_CHARS_PER_TOKEN.
const DEFAULT_OLLAMA_CHARS_PER_TOKEN = 1.9;
const DEFAULT_OLLAMA_MAX_NUM_CTX = 16_384;
const DEFAULT_OLLAMA_NUM_PREDICT = 1_024;
const OLLAMA_CONTEXT_SAFETY_OVERHEAD = 768;
const OLLAMA_CONTEXT_BUCKETS = [4_096, 8_192, 16_384, 32_768] as const;

type OllamaResponse = {
  response: Response;
  controller: AbortController;
  baseUrl: string;
  model: string;
};

function ollamaModelName(model: string): string {
  if (model.startsWith("ollama:")) return model.slice("ollama:".length);
  if (model.startsWith("ollama/")) return model.slice("ollama/".length);
  return model;
}

function ollamaBaseUrl(): string {
  return (
    process.env.OLLAMA_BASE_URL ||
    process.env.LOCAL_OLLAMA_BASE_URL ||
    DEFAULT_OLLAMA_BASE_URL
  ).replace(/\/+$/, "");
}

function positiveNumberFromEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveIntegerFromEnv(name: string): number | null {
  const parsed = positiveNumberFromEnv(name);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

export function resolveOllamaCharsPerToken(): number {
  return (
    positiveNumberFromEnv("OLLAMA_CHARS_PER_TOKEN") ??
    DEFAULT_OLLAMA_CHARS_PER_TOKEN
  );
}

export function resolveOllamaMaxNumCtx(): number {
  return Math.min(
    OLLAMA_CONTEXT_BUCKETS.at(-1)!,
    Math.max(
      OLLAMA_CONTEXT_BUCKETS[0],
      positiveIntegerFromEnv("OLLAMA_MAX_NUM_CTX") ??
        DEFAULT_OLLAMA_MAX_NUM_CTX,
    ),
  );
}

export function resolveOllamaContextWindow(): number {
  return positiveIntegerFromEnv("OLLAMA_NUM_CTX") ?? resolveOllamaMaxNumCtx();
}

export function resolveOllamaNumCtx(params: {
  promptChars: number;
  maxTokens?: number;
}): number {
  const hardOverride = positiveIntegerFromEnv("OLLAMA_NUM_CTX");
  if (hardOverride !== null) return hardOverride;

  const estimatedPromptTokens = Math.ceil(
    Math.max(0, params.promptChars) / resolveOllamaCharsPerToken(),
  );
  const needed =
    estimatedPromptTokens +
    Math.max(0, params.maxTokens ?? DEFAULT_OLLAMA_NUM_PREDICT) +
    OLLAMA_CONTEXT_SAFETY_OVERHEAD;
  const bucket =
    OLLAMA_CONTEXT_BUCKETS.find((candidate) => candidate >= needed) ??
    OLLAMA_CONTEXT_BUCKETS.at(-1)!;
  return Math.min(resolveOllamaMaxNumCtx(), bucket);
}

async function postOllamaChatResponse(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<OllamaResponse> {
  const model = typeof body.model === "string" ? body.model : "unknown";
  const baseUrl = ollamaBaseUrl();
  const { response, controller } = await fetchWithResponseStartTimeout({
    url: `${baseUrl}/api/chat`,
    provider: "ollama",
    model,
    providerOverrideEnv: OLLAMA_RESPONSE_START_TIMEOUT_ENV,
    signal,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Ollama chat failed (${response.status}): ${detail.slice(0, 500)}`,
    );
  }
  return { response, controller, baseUrl, model };
}

function toOllamaMessages(params: StreamChatParams): OllamaMessage[] {
  return [
    { role: "system", content: params.systemPrompt },
    ...params.messages.map(
      (m): OllamaMessage => ({ role: m.role, content: m.content }),
    ),
  ];
}

function normalizeToolCalls(
  calls: NonNullable<OllamaChatResponse["message"]>["tool_calls"],
): NormalizedToolCall[] {
  return (calls ?? [])
    .filter((call) => call.function?.name)
    .map((call, idx) => ({
      id: `${call.function?.name ?? "tool"}-${idx}`,
      name: call.function?.name ?? "tool",
      input: call.function?.arguments ?? {},
    }));
}

async function readOllamaStream(params: {
  response: OllamaResponse;
  onThinking: (text: string) => void;
  onContent: (text: string) => void;
}): Promise<{
  toolCalls: NormalizedToolCall[];
  finalChunk: OllamaChatStreamChunk | null;
}> {
  const reader = params.response.response.body?.getReader();
  if (!reader) throw new Error("Ollama chat returned no stream body");

  const decoder = new TextDecoder();
  let buffer = "";
  let toolCalls: NormalizedToolCall[] = [];
  let finalChunk: OllamaChatStreamChunk | null = null;

  const applyLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed) as OllamaChatStreamChunk;
    const thinking = parsed.message?.thinking ?? "";
    if (thinking) params.onThinking(thinking);
    const content = parsed.message?.content ?? "";
    if (content) params.onContent(content);
    const nextToolCalls = normalizeToolCalls(parsed.message?.tool_calls);
    if (nextToolCalls.length) toolCalls = nextToolCalls;
    if (parsed.done) finalChunk = parsed;
  };

  while (true) {
    const { done, value } = await readWithStreamIdleTimeout(reader, {
      controller: params.response.controller,
      baseUrl: params.response.baseUrl,
      provider: "ollama",
      model: params.response.model,
    });
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd = buffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      applyLine(line);
      lineEnd = buffer.indexOf("\n");
    }
  }

  const tail = buffer.trim();
  if (tail) applyLine(tail);
  return { toolCalls, finalChunk };
}

export async function streamOllama(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  params.signal?.throwIfAborted();
  const { tools = [], callbacks = {}, runTools, enableThinking } = params;
  const messages = toOllamaMessages(params);
  const maxIter = params.maxIterations ?? 10;
  const model = ollamaModelName(params.model);
  let fullText = "";

  for (let iter = 0; iter < maxIter; iter++) {
    const response = await postOllamaChatResponse(
      {
        model,
        messages,
        stream: true,
        tools: tools.length ? tools : undefined,
        think: enableThinking ? "high" : false,
      },
      params.signal,
    );
    let sawThinking = false;
    let content = "";
    const { toolCalls } = await readOllamaStream({
      response,
      onThinking: (delta) => {
        sawThinking = true;
        callbacks.onReasoningDelta?.(delta);
      },
      onContent: (delta) => {
        content += delta;
        fullText += delta;
        callbacks.onContentDelta?.(delta);
      },
    });
    if (sawThinking) callbacks.onReasoningBlockEnd?.();

    if (!toolCalls.length || !runTools) break;

    for (const call of toolCalls) callbacks.onToolCallStart?.(call);
    messages.push({
      role: "assistant",
      content,
      tool_calls: toolCalls.map((call) => ({
        function: { name: call.name, arguments: call.input },
      })),
    });
    const results = await runTools(toolCalls);
    for (const result of results) {
      const call = toolCalls.find((tc) => tc.id === result.tool_use_id);
      messages.push({
        role: "tool",
        tool_name: call?.name,
        content: result.content,
      });
    }
  }

  return { fullText };
}

export async function completeOllamaText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  responseJsonSchema?: Record<string, unknown>;
  think?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const startedAt = Date.now();
  const model = ollamaModelName(params.model);
  const promptChars = (params.systemPrompt?.length ?? 0) + params.user.length;
  const numPredict = params.maxTokens ?? DEFAULT_OLLAMA_NUM_PREDICT;
  const numCtx = resolveOllamaNumCtx({
    promptChars,
    maxTokens: numPredict,
  });
  let finalChunk: OllamaChatStreamChunk | null = null;

  try {
    const response = await postOllamaChatResponse(
      {
        model,
        messages: [
          ...(params.systemPrompt
            ? [{ role: "system", content: params.systemPrompt }]
            : []),
          { role: "user", content: params.user },
        ],
        stream: true,
        think: params.think ? "high" : false,
        ...(params.think ? {} : { format: params.responseJsonSchema }),
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || "10m",
        options: {
          temperature: 0,
          num_ctx: numCtx,
          num_predict: numPredict,
        },
      },
      params.signal,
    );
    let content = "";
    const result = await readOllamaStream({
      response,
      onThinking: () => undefined,
      onContent: (delta) => {
        content += delta;
      },
    });
    finalChunk = result.finalChunk;
    return content;
  } finally {
    console.info("[ollama/complete]", {
      model,
      num_ctx: numCtx,
      num_predict: numPredict,
      prompt_chars: promptChars,
      prompt_eval_count: finalChunk?.prompt_eval_count,
      eval_count: finalChunk?.eval_count,
      total_duration: finalChunk?.total_duration,
      load_duration: finalChunk?.load_duration,
      done_reason: finalChunk?.done_reason,
      elapsed_ms: Date.now() - startedAt,
    });
  }
}
