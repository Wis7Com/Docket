import test from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { completeText, streamChatWithTools } from "./index";
import { resolveOllamaNumCtx } from "./ollama";
import { LlmTimeoutError } from "./timeouts";

type CapturedRequest = {
  url: string | undefined;
  body: string;
};

test("Ollama completions stream content with context, residency, and telemetry", async () => {
  const oldBaseUrl = process.env.OLLAMA_BASE_URL;
  const oldKeepAlive = process.env.OLLAMA_KEEP_ALIVE;
  const oldNumCtx = process.env.OLLAMA_NUM_CTX;
  const oldMaxNumCtx = process.env.OLLAMA_MAX_NUM_CTX;
  const oldCharsPerToken = process.env.OLLAMA_CHARS_PER_TOKEN;
  const oldConsoleInfo = console.info;
  const oldFetch = globalThis.fetch;
  const captured: CapturedRequest[] = [];
  const infoCalls: unknown[][] = [];
  const schema = {
    type: "object",
    properties: { points: { type: "array" } },
    required: ["points"],
  };
  const responseLines = [
    JSON.stringify({ message: { content: '{"points":' } }) + "\n",
    JSON.stringify({
      message: { content: "[]}" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 1_337,
      eval_count: 42,
      total_duration: 9_000_000,
      load_duration: 1_000_000,
    }) + "\n",
  ];

  try {
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    delete process.env.OLLAMA_KEEP_ALIVE;
    delete process.env.OLLAMA_NUM_CTX;
    delete process.env.OLLAMA_MAX_NUM_CTX;
    delete process.env.OLLAMA_CHARS_PER_TOKEN;
    console.info = (...args: unknown[]) => infoCalls.push(args);
    globalThis.fetch = (async (input, init) => {
      captured.push({
        url: String(input),
        body: String(init?.body ?? ""),
      });
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const line of responseLines) {
              controller.enqueue(encoder.encode(line));
            }
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        },
      );
    }) as typeof fetch;
    const result = await completeText({
      model: "ollama:test-model",
      systemPrompt: "return JSON",
      user: "extract points",
      maxTokens: 1_234,
      responseJsonSchema: schema,
    });
    process.env.OLLAMA_KEEP_ALIVE = "30m";
    const largeResult = await completeText({
      model: "ollama:test-model",
      systemPrompt: "return JSON",
      user: "x".repeat(20_000),
      maxTokens: 1_234,
      responseJsonSchema: schema,
    });
    const thinkingResult = await completeText({
      model: "ollama:test-model",
      systemPrompt: "synthesize JSON",
      user: "compare points",
      maxTokens: 1_234,
      responseJsonSchema: schema,
      think: true,
    });

    assert.equal(result, '{"points":[]}');
    assert.equal(largeResult, '{"points":[]}');
    assert.equal(thinkingResult, '{"points":[]}');
    const body = JSON.parse(captured[0].body);
    assert.deepEqual(body.format, schema);
    assert.equal(body.think, false);
    assert.equal(body.stream, true);
    assert.equal(body.keep_alive, "10m");
    assert.equal(body.options.num_ctx, 4_096);
    assert.ok(
      body.options.num_ctx >=
        Math.ceil(("return JSON".length + "extract points".length) / 1.9) +
          1_234 +
          768,
    );
    assert.equal(body.options.num_predict, 1_234);
    assert.equal(body.options.temperature, 0);
    const largeBody = JSON.parse(captured[1].body);
    assert.equal(largeBody.keep_alive, "30m");
    assert.equal(largeBody.options.num_ctx, 16_384);
    const thinkingBody = JSON.parse(captured[2].body);
    assert.equal(thinkingBody.think, "high");
    assert.equal(Object.hasOwn(thinkingBody, "format"), false);

    const completionLogs = infoCalls.filter(
      ([message]) => message === "[ollama/complete]",
    );
    assert.equal(completionLogs.length, 3);
    const telemetry = completionLogs[0][1] as Record<string, unknown>;
    assert.equal(telemetry.prompt_eval_count, 1_337);
    assert.equal(telemetry.eval_count, 42);
    assert.equal(telemetry.total_duration, 9_000_000);
    assert.equal(telemetry.load_duration, 1_000_000);
    assert.equal(telemetry.done_reason, "stop");
    assert.equal(typeof telemetry.elapsed_ms, "number");
  } finally {
    console.info = oldConsoleInfo;
    globalThis.fetch = oldFetch;
    restoreEnv("OLLAMA_BASE_URL", oldBaseUrl);
    restoreEnv("OLLAMA_KEEP_ALIVE", oldKeepAlive);
    restoreEnv("OLLAMA_NUM_CTX", oldNumCtx);
    restoreEnv("OLLAMA_MAX_NUM_CTX", oldMaxNumCtx);
    restoreEnv("OLLAMA_CHARS_PER_TOKEN", oldCharsPerToken);
  }
});

test("resolveOllamaNumCtx buckets estimates, clamps max context, and honors overrides", () => {
  const oldNumCtx = process.env.OLLAMA_NUM_CTX;
  const oldMaxNumCtx = process.env.OLLAMA_MAX_NUM_CTX;
  const oldCharsPerToken = process.env.OLLAMA_CHARS_PER_TOKEN;

  try {
    delete process.env.OLLAMA_NUM_CTX;
    delete process.env.OLLAMA_MAX_NUM_CTX;
    delete process.env.OLLAMA_CHARS_PER_TOKEN;

    assert.equal(
      resolveOllamaNumCtx({ promptChars: 1_000, maxTokens: 1_024 }),
      4_096,
    );
    assert.equal(
      resolveOllamaNumCtx({ promptChars: 10_000, maxTokens: 1_536 }),
      8_192,
    );
    assert.equal(
      resolveOllamaNumCtx({ promptChars: 20_000, maxTokens: 1_536 }),
      16_384,
    );

    process.env.OLLAMA_MAX_NUM_CTX = "8192";
    assert.equal(
      resolveOllamaNumCtx({ promptChars: 20_000, maxTokens: 1_536 }),
      8_192,
    );

    delete process.env.OLLAMA_MAX_NUM_CTX;
    process.env.OLLAMA_CHARS_PER_TOKEN = "5";
    assert.equal(
      resolveOllamaNumCtx({ promptChars: 20_000, maxTokens: 1_536 }),
      8_192,
    );

    delete process.env.OLLAMA_CHARS_PER_TOKEN;
    process.env.OLLAMA_MAX_NUM_CTX = "65536";
    assert.equal(
      resolveOllamaNumCtx({ promptChars: 100_000, maxTokens: 10_000 }),
      32_768,
    );

    process.env.OLLAMA_NUM_CTX = "12345";
    assert.equal(
      resolveOllamaNumCtx({ promptChars: 100_000, maxTokens: 10_000 }),
      12_345,
    );
  } finally {
    restoreEnv("OLLAMA_NUM_CTX", oldNumCtx);
    restoreEnv("OLLAMA_MAX_NUM_CTX", oldMaxNumCtx);
    restoreEnv("OLLAMA_CHARS_PER_TOKEN", oldCharsPerToken);
  }
});

test("Ollama completion rejects a pre-aborted signal before fetch", async () => {
  const oldFetch = globalThis.fetch;
  const reason = new Error("completion cancelled");
  let fetchCalls = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run");
    }) as typeof fetch;
    await assert.rejects(
      completeText({
        model: "ollama:test-model",
        user: "summarize",
        signal: AbortSignal.abort(reason),
      }),
      reason,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Ollama streaming composes the caller signal into fetch", async () => {
  const oldFetch = globalThis.fetch;
  const controller = new AbortController();
  let fetchSignal: AbortSignal | null | undefined;

  try {
    globalThis.fetch = (async (_input, init) => {
      fetchSignal = init?.signal;
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(
              encoder.encode(
                JSON.stringify({ message: { content: "done" }, done: true }) +
                  "\n",
              ),
            );
            streamController.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await streamChatWithTools({
      model: "ollama:test-model",
      systemPrompt: "answer briefly",
      messages: [{ role: "user", content: "hello" }],
      signal: controller.signal,
    });

    assert.equal(result.fullText, "done");
    assert.ok(fetchSignal instanceof AbortSignal);
    assert.notEqual(fetchSignal, controller.signal);
    controller.abort();
    assert.equal(fetchSignal.aborted, true);
    assert.equal(fetchSignal.reason?.name, "AbortError");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Ollama streaming rejects a pre-aborted signal before fetch", async () => {
  const oldFetch = globalThis.fetch;
  const controller = new AbortController();
  let fetchCalls = 0;
  controller.abort();

  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run");
    }) as typeof fetch;

    await assert.rejects(
      streamChatWithTools({
        model: "ollama:test-model",
        systemPrompt: "answer briefly",
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
      }),
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Ollama chat requests and forwards streaming chunks", async () => {
  const oldBaseUrl = process.env.OLLAMA_BASE_URL;
  const oldLocalBaseUrl = process.env.LOCAL_OLLAMA_BASE_URL;
  let captured: CapturedRequest | null = null;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      captured = {
        url: req.url,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { content: "hel" } }) + "\n");
      res.write(JSON.stringify({ message: { content: "lo" } }) + "\n");
      res.end(JSON.stringify({ done: true }) + "\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
    delete process.env.LOCAL_OLLAMA_BASE_URL;

    const deltas: string[] = [];
    const result = await streamChatWithTools({
      model: "ollama:test-model",
      systemPrompt: "answer briefly",
      messages: [{ role: "user", content: "hello" }],
      callbacks: {
        onContentDelta: (text) => deltas.push(text),
      },
    });

    assert.equal(result.fullText, "hello");
    assert.deepEqual(deltas, ["hel", "lo"]);
    const seen = requireCaptured(captured);
    assert.equal(seen.url, "/api/chat");
    assert.equal(JSON.parse(seen.body).stream, true);
  } finally {
    restoreEnv("OLLAMA_BASE_URL", oldBaseUrl);
    restoreEnv("LOCAL_OLLAMA_BASE_URL", oldLocalBaseUrl);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("Ollama starts a fresh response-start timeout for every tool iteration", async () => {
  const oldBaseUrl = process.env.OLLAMA_BASE_URL;
  const oldResponseStart = process.env.OLLAMA_RESPONSE_START_TIMEOUT_MS;
  let requestCount = 0;

  const server = http.createServer((_req, res) => {
    requestCount += 1;
    const currentRequest = requestCount;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (currentRequest === 1) {
        res.end(
          JSON.stringify({
            message: {
              tool_calls: [
                {
                  function: {
                    name: "lookup",
                    arguments: { id: 1 },
                  },
                },
              ],
            },
            done: true,
          }) + "\n",
        );
        return;
      }
      res.end(
        JSON.stringify({
          message: { content: "finished" },
          done: true,
        }) + "\n",
      );
    }, 60);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.OLLAMA_RESPONSE_START_TIMEOUT_MS = "100";

    const result = await streamChatWithTools({
      model: "ollama:test-model",
      systemPrompt: "use the tool",
      messages: [{ role: "user", content: "look it up" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Looks up a value",
            parameters: { type: "object" },
          },
        },
      ],
      runTools: async (calls) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return [{ tool_use_id: calls[0].id, content: "tool result" }];
      },
    });

    assert.equal(result.fullText, "finished");
    assert.equal(requestCount, 2);
  } finally {
    restoreEnv("OLLAMA_BASE_URL", oldBaseUrl);
    restoreEnv("OLLAMA_RESPONSE_START_TIMEOUT_MS", oldResponseStart);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("Ollama aborts a stalled response stream with a stable timeout code", async () => {
  const oldBaseUrl = process.env.OLLAMA_BASE_URL;
  const oldIdleTimeout = process.env.LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS;

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(JSON.stringify({ message: { content: "started" } }) + "\n");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS = "20";

    await assert.rejects(
      streamChatWithTools({
        model: "ollama:test-model",
        systemPrompt: "answer briefly",
        messages: [{ role: "user", content: "hello" }],
      }),
      (error: unknown) =>
        error instanceof LlmTimeoutError &&
        error.code === "LLM_STREAM_IDLE_TIMEOUT" &&
        error.provider === "ollama" &&
        error.timeoutMs === 20,
    );
  } finally {
    restoreEnv("OLLAMA_BASE_URL", oldBaseUrl);
    restoreEnv("LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS", oldIdleTimeout);
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("Ollama keeps a long stream alive while response bytes keep arriving", async () => {
  const oldBaseUrl = process.env.OLLAMA_BASE_URL;
  const oldIdleTimeout = process.env.LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS;

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    let chunk = 0;
    const interval = setInterval(() => {
      chunk += 1;
      res.write(JSON.stringify({ message: { content: String(chunk) } }) + "\n");
      if (chunk === 4) {
        clearInterval(interval);
        res.end(JSON.stringify({ done: true }) + "\n");
      }
    }, 15);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS = "30";

    const result = await streamChatWithTools({
      model: "ollama:test-model",
      systemPrompt: "answer briefly",
      messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(result.fullText, "1234");
  } finally {
    restoreEnv("OLLAMA_BASE_URL", oldBaseUrl);
    restoreEnv("LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS", oldIdleTimeout);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function requireCaptured(value: CapturedRequest | null): CapturedRequest {
  assert.ok(value);
  return value;
}
