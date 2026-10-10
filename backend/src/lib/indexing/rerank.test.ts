import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  clearRerankScoreCache,
  rerankResults,
  rerankScoreCacheSize,
  type RerankSettings,
} from "./rerank";
import type { RerankServerManager } from "./rerankServer";

type Row = {
  chunk_id: string;
  content: string;
  match_reasons?: string[];
  rerank_score?: number | null;
};

type Handler = (
  body: { query: string; documents: string[]; top_n: number },
  res: http.ServerResponse,
) => void;

let server: http.Server;
let baseUrl = "";
let requestCount = 0;
let receivedDocuments: string[][] = [];
let receivedQueries: string[] = [];
let handler: Handler = respondWithScores({});
const pending = new Set<http.ServerResponse>();

/** Scores documents by exact content; unknown documents score 0. Replies in reverse order. */
function respondWithScores(scores: Record<string, number>): Handler {
  return (body, res) => {
    const results = body.documents
      .map((doc, index) => ({ index, relevance_score: scores[doc] ?? 0 }))
      .reverse();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
  };
}

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/rerank") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        query: string;
        documents: string[];
        top_n: number;
      };
      requestCount += 1;
      receivedDocuments.push(body.documents);
      receivedQueries.push(body.query);
      pending.add(res);
      res.on("close", () => pending.delete(res));
      handler(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const res of pending) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  clearRerankScoreCache();
  requestCount = 0;
  receivedDocuments = [];
  receivedQueries = [];
  handler = respondWithScores({});
});

function settings(overrides: Partial<RerankSettings> = {}): RerankSettings {
  return {
    enabled: true,
    preference: true,
    depth: 3,
    baseUrl,
    modelPath: null,
    binaryPath: null,
    timeoutMs: 1500,
    idleSeconds: 600,
    ...overrides,
  };
}

function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    chunk_id: `c${i}`,
    content: `doc ${i}`,
    match_reasons: ["fts"],
  }));
}

function collectWarnings(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m) => void messages.push(m), messages };
}

async function closedPortUrl(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

test("reorders the head by descending score, keeps the tail, and annotates head rows only", async () => {
  handler = respondWithScores({ "doc 0": 0.1, "doc 1": 0.9, "doc 2": 0.5 });
  const rows = makeRows(5);
  const snapshot = JSON.parse(JSON.stringify(rows));
  const { warn, messages } = collectWarnings();

  const outcome = await rerankResults("indemnity", rows, {
    settings: settings(),
    warn,
  });

  assert.equal(outcome.reranked, true);
  assert.equal(outcome.scored, 3);
  assert.deepEqual(
    outcome.rows.map((r) => r.chunk_id),
    ["c1", "c2", "c0", "c3", "c4"],
  );
  assert.deepEqual(
    outcome.rows.slice(0, 3).map((r) => r.rerank_score),
    [0.9, 0.5, 0.1],
  );
  for (const row of outcome.rows.slice(0, 3)) {
    assert.deepEqual(row.match_reasons, ["fts", "rerank"]);
  }
  for (const row of outcome.rows.slice(3)) {
    assert.equal(row.rerank_score, undefined);
    assert.deepEqual(row.match_reasons, ["fts"]);
  }
  assert.deepEqual(rows, snapshot, "input rows must not be mutated");
  assert.equal(messages.length, 0);
  assert.equal(requestCount, 1);
  assert.deepEqual(receivedDocuments[0], ["doc 0", "doc 1", "doc 2"]);
  assert.equal(receivedQueries[0], "indemnity");
});

test("ties keep their original order", async () => {
  handler = respondWithScores({ "doc 0": 0.5, "doc 1": 0.5, "doc 2": 0.5 });
  const outcome = await rerankResults("q", makeRows(4), {
    settings: settings(),
  });
  assert.deepEqual(
    outcome.rows.map((r) => r.chunk_id),
    ["c0", "c1", "c2", "c3"],
  );
  assert.equal(outcome.reranked, true);
});

test("options.depth overrides settings.depth", async () => {
  handler = respondWithScores({ "doc 0": 0.1, "doc 1": 0.9 });
  const outcome = await rerankResults("q", makeRows(4), {
    settings: settings({ depth: 3 }),
    depth: 2,
  });
  assert.equal(outcome.scored, 2);
  assert.deepEqual(
    outcome.rows.map((r) => r.chunk_id),
    ["c1", "c0", "c2", "c3"],
  );
});

test("falls back to the original order when the server returns 500", async () => {
  handler = (_body, res) => {
    res.writeHead(500).end("boom");
  };
  const rows = makeRows(4);
  const { warn, messages } = collectWarnings();
  const outcome = await rerankResults("q", rows, {
    settings: settings(),
    warn,
  });
  assert.equal(outcome.reranked, false);
  assert.equal(outcome.scored, 0);
  assert.deepEqual(outcome.rows, rows);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^falling back/);
  assert.match(messages[0], /500/);
  assert.equal(rerankScoreCacheSize(), 0);
});

test("falls back when the server hangs past timeoutMs", async () => {
  handler = () => {
    /* never respond */
  };
  const rows = makeRows(4);
  const { warn, messages } = collectWarnings();
  const startedAt = Date.now();
  const outcome = await rerankResults("q", rows, {
    settings: settings({ timeoutMs: 300 }),
    warn,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(outcome.reranked, false);
  assert.deepEqual(outcome.rows, rows);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^falling back/);
  assert.ok(elapsed < 1400, `should abort near timeoutMs, took ${elapsed} ms`);
});

test("falls back when the base URL points at a closed port", async () => {
  const rows = makeRows(4);
  const { warn, messages } = collectWarnings();
  const outcome = await rerankResults("q", rows, {
    settings: settings({ baseUrl: await closedPortUrl() }),
    warn,
  });
  assert.equal(outcome.reranked, false);
  assert.deepEqual(outcome.rows, rows);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^falling back/);
  assert.equal(requestCount, 0);
});

test("falls back when the response is missing one index", async () => {
  handler = (body, res) => {
    const results = body.documents
      .map((_doc, index) => ({ index, relevance_score: 1 - index * 0.1 }))
      .slice(0, body.documents.length - 1);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
  };
  const rows = makeRows(4);
  const { warn, messages } = collectWarnings();
  const outcome = await rerankResults("q", rows, {
    settings: settings(),
    warn,
  });
  assert.equal(outcome.reranked, false);
  assert.deepEqual(outcome.rows, rows);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^falling back/);
  assert.match(messages[0], /2 of 3/);
  assert.equal(
    rerankScoreCacheSize(),
    0,
    "partial responses must not be cached",
  );
});

test("falls back when the response has no results array", async () => {
  handler = (_body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "nope" }));
  };
  const { warn, messages } = collectWarnings();
  const outcome = await rerankResults("q", makeRows(3), {
    settings: settings(),
    warn,
  });
  assert.equal(outcome.reranked, false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^falling back/);
});

test("score cache: repeat call sends nothing, a changed row sends one, a new query resends all", async () => {
  handler = respondWithScores({
    "doc 0": 0.1,
    "doc 1": 0.9,
    "doc 2": 0.5,
    "doc 2 edited": 0.95,
  });
  const rows = makeRows(5);

  const first = await rerankResults("q", rows, { settings: settings() });
  assert.equal(requestCount, 1);
  assert.equal(first.scored, 3);

  const second = await rerankResults("q", rows, { settings: settings() });
  assert.equal(requestCount, 1, "second call must be fully cached");
  assert.equal(second.scored, 0);
  assert.equal(second.reranked, true);
  assert.deepEqual(
    second.rows.map((r) => r.chunk_id),
    first.rows.map((r) => r.chunk_id),
  );

  const edited = rows.map((r) =>
    r.chunk_id === "c2" ? { ...r, content: "doc 2 edited" } : r,
  );
  const third = await rerankResults("q", edited, { settings: settings() });
  assert.equal(requestCount, 2);
  assert.deepEqual(receivedDocuments[1], ["doc 2 edited"]);
  assert.equal(third.scored, 1);
  assert.equal(third.rows[0].chunk_id, "c2");

  const fourth = await rerankResults("other query", rows, {
    settings: settings(),
  });
  assert.equal(requestCount, 3);
  assert.deepEqual(receivedDocuments[2], ["doc 0", "doc 1", "doc 2"]);
  assert.equal(fourth.scored, 3);
});

test("query is trimmed before it is sent and cached", async () => {
  const rows = makeRows(3);
  await rerankResults("  q  ", rows, { settings: settings() });
  await rerankResults("q", rows, { settings: settings() });
  assert.equal(requestCount, 1);
  assert.equal(receivedQueries[0], "q");
});

test("fewer rows than depth: all rows are scored", async () => {
  handler = respondWithScores({ "doc 0": 0.2, "doc 1": 0.8 });
  const outcome = await rerankResults("q", makeRows(2), {
    settings: settings({ depth: 10 }),
  });
  assert.equal(outcome.reranked, true);
  assert.equal(outcome.scored, 2);
  assert.deepEqual(
    outcome.rows.map((r) => r.chunk_id),
    ["c1", "c0"],
  );
});

test("exactly depth rows: no tail", async () => {
  handler = respondWithScores({ "doc 0": 0.2, "doc 1": 0.3, "doc 2": 0.9 });
  const outcome = await rerankResults("q", makeRows(3), {
    settings: settings({ depth: 3 }),
  });
  assert.equal(outcome.rows.length, 3);
  assert.deepEqual(
    outcome.rows.map((r) => r.chunk_id),
    ["c2", "c1", "c0"],
  );
  assert.ok(outcome.rows.every((r) => typeof r.rerank_score === "number"));
});

test("empty rows and blank query return unchanged without a request", async () => {
  const { warn, messages } = collectWarnings();
  const empty = await rerankResults("q", [], { settings: settings(), warn });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.reranked, false);

  const rows = makeRows(3);
  const blank = await rerankResults("   ", rows, {
    settings: settings(),
    warn,
  });
  assert.deepEqual(blank.rows, rows);
  assert.equal(blank.reranked, false);
  assert.equal(requestCount, 0);
  assert.equal(messages.length, 0);
});

test("rows without match_reasons are annotated with a score but no reasons", async () => {
  const rows: Row[] = [
    { chunk_id: "a", content: "doc 0" },
    { chunk_id: "b", content: "doc 1" },
  ];
  handler = respondWithScores({ "doc 0": 0.1, "doc 1": 0.9 });
  const outcome = await rerankResults("q", rows, { settings: settings() });
  assert.equal(outcome.rows[0].chunk_id, "b");
  assert.equal(outcome.rows[0].rerank_score, 0.9);
  assert.equal(outcome.rows[0].match_reasons, undefined);
});

test("disabled settings return unchanged with no request and no warning", async () => {
  const rows = makeRows(4);
  const { warn, messages } = collectWarnings();
  const outcome = await rerankResults("q", rows, {
    settings: settings({ enabled: false }),
    warn,
  });
  assert.equal(outcome.reranked, false);
  assert.equal(outcome.scored, 0);
  assert.deepEqual(outcome.rows, rows);
  assert.equal(requestCount, 0);
  assert.equal(messages.length, 0);
});

function fakeManager(
  ensureResult: { baseUrl: string } | null,
): RerankServerManager & { ensureCalls: unknown[]; markUsedCalls: number } {
  const manager = {
    ensureCalls: [] as unknown[],
    markUsedCalls: 0,
    ensure: async (options: unknown) => {
      manager.ensureCalls.push(options);
      return ensureResult;
    },
    markUsed: () => {
      manager.markUsedCalls += 1;
    },
    beginRequest: () => undefined,
    endRequest: () => undefined,
    stop: () => undefined,
    getState: () => ({
      status: "running" as const,
      baseUrl: ensureResult?.baseUrl ?? null,
      pid: null,
      consecutiveFailures: 0,
      lastError: null,
    }),
    isDisabled: () => false,
  };
  return manager;
}

const sidecarSettings = (): RerankSettings =>
  settings({
    baseUrl: null,
    modelPath: "/x.gguf",
    binaryPath: "/x/llama-server",
  });

test("sidecar path: ensure() supplies the URL and markUsed() is called once", async () => {
  handler = respondWithScores({ "doc 0": 0.1, "doc 1": 0.9, "doc 2": 0.5 });
  const manager = fakeManager({ baseUrl });
  const outcome = await rerankResults("q", makeRows(4), {
    settings: sidecarSettings(),
    manager,
  });
  assert.equal(outcome.reranked, true);
  assert.equal(outcome.rows[0].chunk_id, "c1");
  assert.equal(manager.markUsedCalls, 1);
  assert.equal(manager.ensureCalls.length, 1);
  assert.deepEqual(manager.ensureCalls[0], {
    binaryPath: "/x/llama-server",
    modelPath: "/x.gguf",
    idleSeconds: 600,
  });
});

test("sidecar path: a manager that cannot start returns unchanged with no request", async () => {
  const manager = fakeManager(null);
  const rows = makeRows(4);
  const outcome = await rerankResults("q", rows, {
    settings: sidecarSettings(),
    manager,
  });
  assert.equal(outcome.reranked, false);
  assert.deepEqual(outcome.rows, rows);
  assert.equal(requestCount, 0);
  assert.equal(manager.markUsedCalls, 0);
});

test("sidecar path: a fully cached call does not start the sidecar", async () => {
  handler = respondWithScores({ "doc 0": 0.1, "doc 1": 0.9, "doc 2": 0.5 });
  const manager = fakeManager({ baseUrl });
  const rows = makeRows(4);
  await rerankResults("q", rows, { settings: sidecarSettings(), manager });
  const again = await rerankResults("q", rows, {
    settings: sidecarSettings(),
    manager,
  });
  assert.equal(again.reranked, true);
  assert.equal(again.scored, 0);
  assert.equal(manager.ensureCalls.length, 1);
  assert.equal(manager.markUsedCalls, 1);
});

test("sidecar path: a manager whose ensure() throws still never throws out of rerankResults", async () => {
  const manager = fakeManager({ baseUrl });
  manager.ensure = async () => {
    throw new Error("spawn exploded");
  };
  const { warn, messages } = collectWarnings();
  const rows = makeRows(3);
  const outcome = await rerankResults("q", rows, {
    settings: sidecarSettings(),
    manager,
    warn,
  });
  assert.equal(outcome.reranked, false);
  assert.deepEqual(outcome.rows, rows);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^falling back/);
});
