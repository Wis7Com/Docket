import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { completeText, streamChatWithTools } from "./index";
import {
  LlmTimeoutError,
  resolveResponseStartTimeoutMs,
  resolveStreamIdleTimeoutMs,
} from "./timeouts";

type CapturedRequest = {
  url: string | undefined;
  authorization: string | undefined;
  body: string;
};

test("OpenAI-compatible streaming composes the caller signal into fetch", async () => {
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
                `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`,
              ),
            );
            streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
            streamController.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await streamChatWithTools({
      model: "openai-compatible:test-model",
      systemPrompt: "answer briefly",
      messages: [{ role: "user", content: "hello" }],
      apiKeys: {
        openaiCompatibleBaseUrl: "https://llm.example.test/v1",
      },
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

test("OpenAI-compatible streaming rejects a pre-aborted signal before fetch", async () => {
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
        model: "openai-compatible:test-model",
        systemPrompt: "answer briefly",
        messages: [{ role: "user", content: "hello" }],
        apiKeys: {
          openaiCompatibleBaseUrl: "https://llm.example.test/v1",
        },
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

test("free-router:auto selects a routed OpenAI-compatible endpoint", async () => {
  const oldPath = process.env.PATH;
  const oldBaseUrl = process.env.OPENROUTER_BASE_URL;
  const oldApiKey = process.env.OPENROUTER_API_KEY;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "docket-free-router-"));
  const executable = path.join(binDir, "free-router");
  fs.writeFileSync(
    executable,
    "#!/bin/sh\nprintf '%s\\n' 'selected openrouter:free/model'\n",
    { mode: 0o755 },
  );

  let captured: CapturedRequest | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      captured = {
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "routed response" } }],
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";

    const text = await completeText({
      model: "free-router:auto",
      systemPrompt: "route cheaply",
      user: "hello",
    });

    assert.equal(text, "routed response");
    const seen = requireCaptured(captured as CapturedRequest | null);
    assert.equal(seen.url, "/chat/completions");
    assert.equal(seen.authorization, "Bearer test-openrouter-key");
    assert.equal(JSON.parse(seen.body).model, "free/model");
  } finally {
    process.env.PATH = oldPath;
    restoreEnv("OPENROUTER_BASE_URL", oldBaseUrl);
    restoreEnv("OPENROUTER_API_KEY", oldApiKey);
    fs.rmSync(binDir, { recursive: true, force: true });
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("free-router proxy model routes to the local on-demand proxy", async () => {
  const oldBaseUrl = process.env.FREE_ROUTER_PROXY_BASE_URL;
  const oldLocalApiKey = process.env.FREE_ROUTER_PROXY_LOCAL_API_KEY;

  let captured: CapturedRequest | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      captured = {
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "proxy response" } }],
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.FREE_ROUTER_PROXY_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    delete process.env.FREE_ROUTER_PROXY_LOCAL_API_KEY;

    const text = await completeText({
      model: "free-router:free-router/best",
      systemPrompt: "route through the proxy",
      user: "hello",
    });

    assert.equal(text, "proxy response");
    const seen = requireCaptured(captured as CapturedRequest | null);
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.authorization, "Bearer local");
    assert.equal(JSON.parse(seen.body).model, "free-router/best");
  } finally {
    restoreEnv("FREE_ROUTER_PROXY_BASE_URL", oldBaseUrl);
    restoreEnv("FREE_ROUTER_PROXY_LOCAL_API_KEY", oldLocalApiKey);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("FreeRouter streaming requests use the bounded desktop token budget", async () => {
  const oldBaseUrl = process.env.FREE_ROUTER_PROXY_BASE_URL;
  let capturedBody: Record<string, unknown> | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.FREE_ROUTER_PROXY_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    await streamChatWithTools({
      model: "free-router:free-router/best",
      systemPrompt: "answer",
      messages: [{ role: "user", content: "question" }],
    });
    assert.equal(capturedBody?.max_tokens, 4_096);
  } finally {
    restoreEnv("FREE_ROUTER_PROXY_BASE_URL", oldBaseUrl);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("OpenAI-compatible one-shot completions forward strict JSON schema", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"points":[]}' } }],
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const schema = {
      type: "object",
      properties: { points: { type: "array" } },
      required: ["points"],
    };
    const text = await completeText({
      model: "openai-compatible:test-model",
      user: "extract",
      responseJsonSchema: schema,
      apiKeys: {
        openaiCompatibleBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
    });

    assert.equal(text, '{"points":[]}');
    assert.deepEqual(capturedBody?.response_format, {
      type: "json_schema",
      json_schema: {
        name: "docket_structured_response",
        strict: true,
        schema,
      },
    });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("one-shot completion retries reasoning-only truncation once", async () => {
  let requests = 0;
  const budgets: number[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requests += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        max_tokens: number;
      };
      budgets.push(body.max_tokens);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          requests === 1
            ? {
                choices: [
                  {
                    finish_reason: "length",
                    message: {
                      content: null,
                      reasoning: "still reasoning",
                    },
                  },
                ],
              }
            : {
                choices: [
                  {
                    finish_reason: "stop",
                    message: { content: '{"role":"brief"}' },
                  },
                ],
              },
        ),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const text = await completeText({
      model: "openai-compatible:reasoning-model",
      user: "classify",
      maxTokens: 120,
      apiKeys: {
        openaiCompatibleBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
    });

    assert.equal(text, '{"role":"brief"}');
    assert.equal(requests, 2);
    assert.deepEqual(budgets, [120, 2_048]);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("OpenAI-compatible chat requests and forwards streaming chunks", async () => {
  let captured: CapturedRequest | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      captured = {
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const deltas: string[] = [];
    const result = await streamChatWithTools({
      model: "openai-compatible:test-model",
      systemPrompt: "answer briefly",
      messages: [{ role: "user", content: "hello" }],
      apiKeys: {
        openaiCompatible: "test-key",
        openaiCompatibleBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
      callbacks: {
        onContentDelta: (text) => deltas.push(text),
      },
    });

    assert.equal(result.fullText, "hello");
    assert.deepEqual(deltas, ["hel", "lo"]);
    const seen = requireCaptured(captured as CapturedRequest | null);
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.authorization, "Bearer test-key");
    assert.equal(JSON.parse(seen.body).stream, true);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("OpenAI-compatible chat reserves its last iteration for a final answer", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      bodies.push(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (bodies.length === 1) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      function: {
                        name: "search_documents",
                        arguments: '{"query":"indemnity"}',
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
      } else {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "grounded answer" } }] })}\n\n`,
        );
      }
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await streamChatWithTools({
      model: "openai-compatible:test-model",
      systemPrompt: "use tools, then answer",
      messages: [{ role: "user", content: "question" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search_documents",
            description: "search",
            parameters: { type: "object" },
          },
        },
      ],
      maxIterations: 2,
      apiKeys: {
        openaiCompatibleBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
      runTools: async (calls) => [
        {
          tool_use_id: calls[0].id,
          content: "the indemnity survives termination",
        },
      ],
    });

    assert.equal(result.fullText, "grounded answer");
    assert.equal(bodies.length, 2);
    assert.ok(Array.isArray(bodies[0].tools));
    assert.equal(bodies[0].tool_choice, "auto");
    assert.ok(Array.isArray(bodies[1].tools));
    assert.equal(bodies[1].tool_choice, "none");
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("a single OpenAI-compatible iteration cannot end on an unhandled tool call", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "final only" } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await streamChatWithTools({
      model: "openai-compatible:test-model",
      systemPrompt: "answer",
      messages: [{ role: "user", content: "question" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search_documents",
            description: "search",
            parameters: { type: "object" },
          },
        },
      ],
      maxIterations: 1,
      apiKeys: {
        openaiCompatibleBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
      runTools: async () => {
        throw new Error("tools must not run on the final-only turn");
      },
    });

    assert.equal(result.fullText, "final only");
    assert.ok(Array.isArray(capturedBody?.tools));
    assert.equal(capturedBody?.tool_choice, "none");
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("OpenAI-compatible chat recovers safe textual tool-call markup", async () => {
  let requests = 0;
  let toolInput: Record<string, unknown> | undefined;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const content =
        requests === 1
          ? "<tool_call><function=read_index_chunk><parameter=chunk_id>chunk-7</parameter></function></tool_call>"
          : "The indemnity survives termination.";
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await streamChatWithTools({
      model: "openai-compatible:test-model",
      systemPrompt: "use tools",
      messages: [{ role: "user", content: "question" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_index_chunk",
            description: "read indexed evidence",
            parameters: { type: "object" },
          },
        },
      ],
      maxIterations: 2,
      apiKeys: {
        openaiCompatibleBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
      runTools: async (calls) => {
        toolInput = calls[0].input;
        return [{ tool_use_id: calls[0].id, content: "evidence" }];
      },
    });

    assert.equal(result.fullText, "The indemnity survives termination.");
    assert.deepEqual(toolInput, {
      chunk_id: "chunk-7",
    });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("response-start timeout defaults distinguish local and remote endpoints", () => {
  const oldLocal = process.env.LOCAL_LLM_RESPONSE_START_TIMEOUT_MS;
  const oldProvider = process.env.OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS;

  try {
    delete process.env.LOCAL_LLM_RESPONSE_START_TIMEOUT_MS;
    delete process.env.OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS;
    assert.equal(
      resolveResponseStartTimeoutMs({
        baseUrl: "http://localhost:8080/v1",
        providerOverrideEnv: "OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS",
      }),
      600_000,
    );
    assert.equal(
      resolveResponseStartTimeoutMs({
        baseUrl: "https://api.example.com/v1",
        providerOverrideEnv: "OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS",
      }),
      120_000,
    );

    process.env.LOCAL_LLM_RESPONSE_START_TIMEOUT_MS = "700000";
    assert.equal(
      resolveResponseStartTimeoutMs({
        baseUrl: "http://[::1]:8080/v1",
        providerOverrideEnv: "OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS",
      }),
      700_000,
    );

    process.env.OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS = "800000";
    assert.equal(
      resolveResponseStartTimeoutMs({
        baseUrl: "https://api.example.com/v1",
        providerOverrideEnv: "OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS",
      }),
      800_000,
    );
  } finally {
    restoreEnv("LOCAL_LLM_RESPONSE_START_TIMEOUT_MS", oldLocal);
    restoreEnv("OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS", oldProvider);
  }
});

test("stream-idle timeout applies only to local endpoints", () => {
  const oldIdleTimeout = process.env.LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS;
  try {
    delete process.env.LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS;
    assert.equal(
      resolveStreamIdleTimeoutMs("http://localhost:8080/v1"),
      300_000,
    );
    assert.equal(resolveStreamIdleTimeoutMs("https://api.example.com/v1"), 0);

    process.env.LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS = "0";
    assert.equal(resolveStreamIdleTimeoutMs("http://127.0.0.1:8080/v1"), 0);
  } finally {
    restoreEnv("LOCAL_LLM_STREAM_IDLE_TIMEOUT_MS", oldIdleTimeout);
  }
});

test("OpenAI-compatible response-start timeout exposes a stable error code", async () => {
  const oldResponseStart =
    process.env.OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS;
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    }, 50);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS = "10";

    await assert.rejects(
      streamChatWithTools({
        model: "openai-compatible:test-model",
        systemPrompt: "answer briefly",
        messages: [{ role: "user", content: "hello" }],
        apiKeys: {
          openaiCompatibleBaseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
      }),
      (error: unknown) =>
        error instanceof LlmTimeoutError &&
        error.code === "LLM_RESPONSE_START_TIMEOUT" &&
        error.timeoutMs === 10,
    );
  } finally {
    restoreEnv("OPENAI_COMPATIBLE_RESPONSE_START_TIMEOUT_MS", oldResponseStart);
    server.closeAllConnections();
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
