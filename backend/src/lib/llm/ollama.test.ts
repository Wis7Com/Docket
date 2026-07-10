import test from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { streamChatWithTools } from "./index";
import { LlmTimeoutError } from "./timeouts";

type CapturedRequest = {
  url: string | undefined;
  body: string;
};

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
                { function: { name: "lookup", arguments: { id: 1 } } },
              ],
            },
            done: true,
          }) + "\n",
        );
        return;
      }
      res.end(
        JSON.stringify({ message: { content: "finished" }, done: true }) + "\n",
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
