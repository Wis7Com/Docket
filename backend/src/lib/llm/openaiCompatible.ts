import { spawn } from "child_process";
import type {
  NormalizedToolCall,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import {
  fetchWithResponseStartTimeout,
  readWithStreamIdleTimeout,
} from "./timeouts";

type OpenAIChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
};

type ChatCompletionResponse = {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
};

type ChatCompletionStreamChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
};

type EndpointConfig = {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
  headers?: Record<string, string>;
};

const OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_ENV =
  "OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS";

type OpenAICompatibleResponse = {
  response: Response;
  controller: AbortController;
  baseUrl: string;
  provider: string;
  model: string;
};

function stripProvider(model: string, provider: string): string {
  if (model.startsWith(`${provider}:`)) return model.slice(provider.length + 1);
  if (model.startsWith(`${provider}/`)) return model.slice(provider.length + 1);
  return model;
}

async function runFreeRouterBest(timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("free-router", ["--best"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("free-router --best timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const selected = stdout.trim().split(/\s+/).pop() ?? "";
      if (code === 0 && selected) {
        resolve(selected);
        return;
      }
      reject(
        new Error(
          `free-router --best failed${code === null ? "" : ` (${code})`}: ${stderr.trim()}`,
        ),
      );
    });
  });
}

async function resolveEndpoint(
  requestedModel: string,
  apiKeys: StreamChatParams["apiKeys"],
): Promise<EndpointConfig> {
  let model = requestedModel;
  if (model === "free-router:auto") {
    model = await runFreeRouterBest();
  }

  if (model.startsWith("free-router:") || model.startsWith("free-router/")) {
    return {
      provider: "free-router",
      model: stripProvider(model, "free-router"),
      baseUrl:
        process.env.FREE_ROUTER_PROXY_BASE_URL ?? "http://127.0.0.1:43110/v1",
      apiKey: process.env.FREE_ROUTER_PROXY_LOCAL_API_KEY ?? "local",
    };
  }

  if (model.startsWith("openrouter:") || model.startsWith("openrouter/")) {
    return {
      provider: "openrouter",
      model: stripProvider(model, "openrouter"),
      baseUrl:
        process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      apiKey:
        apiKeys?.openrouter?.trim() || process.env.OPENROUTER_API_KEY || null,
      headers: {
        "HTTP-Referer":
          process.env.OPENROUTER_HTTP_REFERER ?? "http://127.0.0.1",
        "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Docket Local",
      },
    };
  }

  if (model.startsWith("nvidia:") || model.startsWith("nvidia/")) {
    return {
      provider: "nvidia",
      model: stripProvider(model, "nvidia"),
      baseUrl:
        process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      apiKey: apiKeys?.nvidia?.trim() || process.env.NVIDIA_API_KEY || null,
    };
  }

  if (model.startsWith("mlx:") || model.startsWith("mlx/")) {
    return {
      provider: "mlx",
      model: stripProvider(model, "mlx"),
      baseUrl: process.env.LOCAL_MLX_BASE_URL ?? "http://127.0.0.1:8080/v1",
      apiKey: process.env.LOCAL_MLX_API_KEY ?? "local",
    };
  }

  if (model.startsWith("openai:") || model.startsWith("openai/")) {
    return {
      provider: "openai",
      model: stripProvider(model, "openai"),
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: apiKeys?.openai?.trim() || process.env.OPENAI_API_KEY || null,
    };
  }

  if (model.startsWith("openai-compatible:")) {
    return {
      provider: "openai-compatible",
      model: model.slice("openai-compatible:".length),
      baseUrl:
        apiKeys?.openaiCompatibleBaseUrl?.trim() ||
        process.env.OPENAI_COMPATIBLE_BASE_URL ||
        "http://127.0.0.1:8080/v1",
      apiKey:
        apiKeys?.openaiCompatible?.trim() ||
        process.env.OPENAI_COMPATIBLE_API_KEY ||
        null,
    };
  }

  throw new Error(`Unsupported OpenAI-compatible model id: ${requestedModel}`);
}

function toOpenAIMessages(
  systemPrompt: string,
  messages: StreamChatParams["messages"],
): OpenAIChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map(
      (m): OpenAIChatMessage => ({ role: m.role, content: m.content }),
    ),
  ];
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function postChatCompletion(
  endpoint: EndpointConfig,
  body: Record<string, unknown>,
): Promise<ChatCompletionResponse> {
  const { response } = await postChatCompletionResponse(endpoint, body);
  return (await response.json()) as ChatCompletionResponse;
}

async function postChatCompletionResponse(
  endpoint: EndpointConfig,
  body: Record<string, unknown>,
): Promise<OpenAICompatibleResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(endpoint.headers ?? {}),
  };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

  const { response, controller } = await fetchWithResponseStartTimeout({
    url: `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    provider: endpoint.provider,
    model: endpoint.model,
    providerOverrideEnv: OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_ENV,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenAI-compatible chat failed (${response.status}): ${detail.slice(0, 500)}`,
    );
  }
  return {
    response,
    controller,
    baseUrl: endpoint.baseUrl,
    provider: endpoint.provider,
    model: endpoint.model,
  };
}

function normalizeToolCalls(
  rawCalls: NonNullable<
    NonNullable<ChatCompletionResponse["choices"]>[number]["message"]
  >["tool_calls"],
): NormalizedToolCall[] {
  return (rawCalls ?? [])
    .filter((call) => call.function?.name)
    .map((call, idx) => ({
      id: call.id ?? `tool-${idx}`,
      name: call.function?.name ?? "tool",
      input: parseToolArguments(call.function?.arguments),
    }));
}

function toAssistantToolCalls(
  calls: NormalizedToolCall[],
): OpenAIChatMessage["tool_calls"] {
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
  }));
}

type ToolCallParts = {
  id?: string;
  name?: string;
  arguments: string;
};

function applyOpenAIStreamChunk(
  raw: string,
  toolCallParts: Map<number, ToolCallParts>,
  onContent: (text: string) => void,
): void {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return;

  const parsed = JSON.parse(data) as ChatCompletionStreamChunk;
  const delta = parsed.choices?.[0]?.delta;
  const content = delta?.content ?? "";
  if (content) onContent(content);

  for (const rawCall of delta?.tool_calls ?? []) {
    const idx = rawCall.index ?? toolCallParts.size;
    const existing = toolCallParts.get(idx) ?? { arguments: "" };
    if (rawCall.id) existing.id = rawCall.id;
    if (rawCall.function?.name) existing.name = rawCall.function.name;
    if (rawCall.function?.arguments) {
      existing.arguments += rawCall.function.arguments;
    }
    toolCallParts.set(idx, existing);
  }
}

async function readOpenAIStream(
  response: OpenAICompatibleResponse,
  onContent: (text: string) => void,
): Promise<NormalizedToolCall[]> {
  const reader = response.response.body?.getReader();
  if (!reader)
    throw new Error("OpenAI-compatible chat returned no stream body");

  const decoder = new TextDecoder();
  const toolCallParts = new Map<number, ToolCallParts>();
  let buffer = "";

  while (true) {
    const { done, value } = await readWithStreamIdleTimeout(reader, {
      controller: response.controller,
      baseUrl: response.baseUrl,
      provider: response.provider,
      model: response.model,
    });
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd >= 0) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      applyOpenAIStreamChunk(frame, toolCallParts, onContent);
      frameEnd = buffer.indexOf("\n\n");
    }
  }

  const tail = buffer.trim();
  if (tail) applyOpenAIStreamChunk(tail, toolCallParts, onContent);

  return Array.from(toolCallParts.values())
    .filter((call) => call.name)
    .map((call, idx) => ({
      id: call.id ?? `tool-${idx}`,
      name: call.name ?? "tool",
      input: parseToolArguments(call.arguments),
    }));
}

export async function streamOpenAICompatible(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const { tools = [], callbacks = {}, runTools } = params;
  const endpoint = await resolveEndpoint(params.model, params.apiKeys);
  const messages = toOpenAIMessages(params.systemPrompt, params.messages);
  const maxIter = params.maxIterations ?? 10;
  let fullText = "";

  for (let iter = 0; iter < maxIter; iter++) {
    const body: Record<string, unknown> = {
      model: endpoint.model,
      messages,
      stream: true,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      max_tokens: 16_384,
    };
    let content = "";
    const resp = await postChatCompletionResponse(endpoint, body);
    const toolCalls = await readOpenAIStream(resp, (delta) => {
      content += delta;
      fullText += delta;
      callbacks.onContentDelta?.(delta);
    });

    if (!toolCalls.length || !runTools) break;

    for (const call of toolCalls) callbacks.onToolCallStart?.(call);
    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: toAssistantToolCalls(toolCalls),
    });
    const results = await runTools(toolCalls);
    for (const result of results) {
      messages.push({
        role: "tool",
        tool_call_id: result.tool_use_id,
        content: result.content,
      });
    }
  }

  return { fullText };
}

export async function completeOpenAICompatibleText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: StreamChatParams["apiKeys"];
}): Promise<string> {
  const endpoint = await resolveEndpoint(params.model, params.apiKeys);
  const completion = await postChatCompletion(endpoint, {
    model: endpoint.model,
    messages: [
      ...(params.systemPrompt
        ? [{ role: "system", content: params.systemPrompt }]
        : []),
      { role: "user", content: params.user },
    ],
    stream: false,
    max_tokens: params.maxTokens ?? 512,
  });
  return completion.choices?.[0]?.message?.content ?? "";
}

export type { OpenAIToolSchema };
