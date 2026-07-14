export type LlmTimeoutCode =
  | "LLM_RESPONSE_START_TIMEOUT"
  | "LLM_STREAM_IDLE_TIMEOUT";

export class LlmTimeoutError extends Error {
  readonly code: LlmTimeoutCode;
  readonly provider: string;
  readonly model: string;
  readonly timeoutMs: number;

  constructor(params: {
    code: LlmTimeoutCode;
    provider: string;
    model: string;
    timeoutMs: number;
  }) {
    const phase =
      params.code === "LLM_RESPONSE_START_TIMEOUT"
        ? "response start"
        : "stream activity";
    super(`${params.provider} ${phase} timed out after ${params.timeoutMs}ms`);
    this.name = "LlmTimeoutError";
    this.code = params.code;
    this.provider = params.provider;
    this.model = params.model;
    this.timeoutMs = params.timeoutMs;
  }
}

export function isLlmTimeoutError(error: unknown): error is LlmTimeoutError {
  return error instanceof LlmTimeoutError;
}

const DEFAULT_REMOTE_RESPONSE_START_TIMEOUT_MS = 120_000;
const DEFAULT_LOCAL_RESPONSE_START_TIMEOUT_MS = 600_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

function parseTimeoutMs(
  raw: string | undefined,
  options: { allowDisabled?: boolean } = {},
): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  if (options.allowDisabled && parsed === 0) return 0;
  return parsed > 0 ? parsed : null;
}

export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

export function resolveResponseStartTimeoutMs(params: {
  baseUrl: string;
  providerOverrideEnv: string;
}): number {
  const providerOverride = parseTimeoutMs(
    process.env[params.providerOverrideEnv],
  );
  if (providerOverride !== null) return providerOverride;

  if (isLoopbackUrl(params.baseUrl)) {
    return (
      parseTimeoutMs(process.env.LOCAL_LLM_RESPONSE_START_TIMEOUT_MS) ??
      DEFAULT_LOCAL_RESPONSE_START_TIMEOUT_MS
    );
  }

  return DEFAULT_REMOTE_RESPONSE_START_TIMEOUT_MS;
}

export function resolveStreamIdleTimeoutMs(baseUrl: string): number {
  if (!isLoopbackUrl(baseUrl)) return 0;
  return (
    parseTimeoutMs(process.env.LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS, {
      allowDisabled: true,
    }) ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  );
}

export async function fetchWithResponseStartTimeout(params: {
  url: string;
  init: RequestInit;
  provider: string;
  model: string;
  providerOverrideEnv: string;
  signal?: AbortSignal;
}): Promise<{ response: Response; controller: AbortController }> {
  params.signal?.throwIfAborted();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutMs = resolveResponseStartTimeoutMs({
    baseUrl: params.url,
    providerOverrideEnv: params.providerOverrideEnv,
  });
  const timeoutError = new LlmTimeoutError({
    code: "LLM_RESPONSE_START_TIMEOUT",
    provider: params.provider,
    model: params.model,
    timeoutMs,
  });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  try {
    const response = await fetch(params.url, {
      ...params.init,
      signal: params.signal
        ? AbortSignal.any([controller.signal, params.signal])
        : controller.signal,
    });
    console.info("[llm/response-start]", {
      provider: params.provider,
      model: params.model,
      local_endpoint: isLoopbackUrl(params.url),
      elapsed_ms: Date.now() - startedAt,
      timeout_ms: timeoutMs,
    });
    return { response, controller };
  } catch (error) {
    if (controller.signal.reason === timeoutError) {
      console.warn("[llm/response-start-timeout]", {
        provider: params.provider,
        model: params.model,
        local_endpoint: isLoopbackUrl(params.url),
        elapsed_ms: Date.now() - startedAt,
        timeout_ms: timeoutMs,
      });
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readWithStreamIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  params: {
    controller: AbortController;
    baseUrl: string;
    provider: string;
    model: string;
  },
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timeoutMs = resolveStreamIdleTimeoutMs(params.baseUrl);
  if (timeoutMs === 0) return reader.read();

  const timeoutError = new LlmTimeoutError({
    code: "LLM_STREAM_IDLE_TIMEOUT",
    provider: params.provider,
    model: params.model,
    timeoutMs,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          console.warn("[llm/stream-idle-timeout]", {
            provider: params.provider,
            model: params.model,
            timeout_ms: timeoutMs,
          });
          params.controller.abort(timeoutError);
          void reader.cancel(timeoutError).catch(() => undefined);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
