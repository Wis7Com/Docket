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
};

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_RESPONSE_START_TIMEOUT_ENV = "OLLAMA_RESPONSE_START_TIMEOUT_MS";

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

async function postOllamaChat(
  body: Record<string, unknown>,
): Promise<OllamaChatResponse> {
  const { response } = await postOllamaChatResponse(body);
  return (await response.json()) as OllamaChatResponse;
}

async function postOllamaChatResponse(
  body: Record<string, unknown>,
): Promise<OllamaResponse> {
  const model = typeof body.model === "string" ? body.model : "unknown";
  const baseUrl = ollamaBaseUrl();
  const { response, controller } = await fetchWithResponseStartTimeout({
    url: `${baseUrl}/api/chat`,
    provider: "ollama",
    model,
    providerOverrideEnv: OLLAMA_RESPONSE_START_TIMEOUT_ENV,
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
}): Promise<NormalizedToolCall[]> {
  const reader = params.response.response.body?.getReader();
  if (!reader) throw new Error("Ollama chat returned no stream body");

  const decoder = new TextDecoder();
  let buffer = "";
  let toolCalls: NormalizedToolCall[] = [];

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
  return toolCalls;
}

export async function streamOllama(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const { tools = [], callbacks = {}, runTools, enableThinking } = params;
  const messages = toOllamaMessages(params);
  const maxIter = params.maxIterations ?? 10;
  const model = ollamaModelName(params.model);
  let fullText = "";

  for (let iter = 0; iter < maxIter; iter++) {
    const response = await postOllamaChatResponse({
      model,
      messages,
      stream: true,
      tools: tools.length ? tools : undefined,
      think: enableThinking ? "high" : false,
    });
    let sawThinking = false;
    let content = "";
    const toolCalls = await readOllamaStream({
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
}): Promise<string> {
  const resp = await postOllamaChat({
    model: ollamaModelName(params.model),
    messages: [
      ...(params.systemPrompt
        ? [{ role: "system", content: params.systemPrompt }]
        : []),
      { role: "user", content: params.user },
    ],
    stream: false,
    think: false,
  });
  return resp.message?.content ?? "";
}
