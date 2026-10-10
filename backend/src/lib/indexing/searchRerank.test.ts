import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { closeDb, getDb } from "../../db/sqlite";
import { runMigrations } from "../../db/migrate";
import { clearRerankScoreCache } from "./rerank";
import { searchProjectIndex } from "./search";

const RERANK_ENV_KEYS = [
  "DOCKET_RERANK_ENABLED",
  "DOCKET_RERANK_DEPTH",
  "DOCKET_RERANK_BASE_URL",
  "DOCKET_RERANK_BINARY",
  "DOCKET_RERANK_MODEL",
  "DOCKET_RERANK_TIMEOUT_MS",
] as const;

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"] as const;
type Word = (typeof WORDS)[number];

let testRoot = "";
let server: http.Server;
let baseUrl = "";
let receivedDocuments: string[][] = [];
let respond: (documents: string[], res: http.ServerResponse) => void = () =>
  undefined;
const savedEnv = new Map<string, string | undefined>();

function wordOf(content: string): Word {
  const found = WORDS.find((word) => content.includes(word));
  assert.ok(found, `no marker word in "${content}"`);
  return found;
}

/** Scores each document from a word -> score table (higher is better). */
function scoreByWord(table: Record<Word, number>) {
  return (documents: string[], res: http.ServerResponse) => {
    const results = documents.map((doc, index) => ({
      index,
      relevance_score: table[wordOf(doc)],
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
  };
}

const ZETA_FIRST: Record<Word, number> = {
  zeta: 0.99,
  epsilon: 0.8,
  delta: 0.6,
  gamma: 0.4,
  beta: 0.2,
  alpha: 0.05,
};

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docket-search-rerank-"));
  process.env.APP_DATA_PATH = path.join(testRoot, "app-data");
  process.env.DOCKET_EMBEDDING_ENABLED = "0";
  delete process.env.WORKSPACE_PATH;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  for (const key of RERANK_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  runMigrations();

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        documents: string[];
      };
      receivedDocuments.push(body.documents);
      respond(body.documents, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of RERANK_ENV_KEYS) {
    const original = savedEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  closeDb();
  delete process.env.DOCKET_EMBEDDING_ENABLED;
  if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of RERANK_ENV_KEYS) delete process.env[key];
  clearRerankScoreCache();
  receivedDocuments = [];
  respond = scoreByWord(ZETA_FIRST);
});

function useFakeServer(depth = 20): void {
  process.env.DOCKET_RERANK_BASE_URL = baseUrl;
  process.env.DOCKET_RERANK_DEPTH = String(depth);
}

function insertProject(projectId: string): void {
  getDb()
    .prepare(
      "INSERT INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)",
    )
    .run(projectId, "owner", projectId, "[]");
}

function insertIndexedDocument(args: {
  projectId: string;
  documentId: string;
  filename: string;
  content: string;
  chunkCount?: number;
}): void {
  const db = getDb();
  const versionId = `version-${args.documentId}`;
  const chunkCount = args.chunkCount ?? 1;
  db.prepare(
    `INSERT INTO documents
      (id, project_id, user_id, filename, file_type, status, folder_id, current_version_id)
     VALUES (?, ?, ?, ?, 'pdf', 'ready', NULL, ?)`,
  ).run(args.documentId, args.projectId, "owner", args.filename, versionId);
  db.prepare(
    `INSERT INTO document_versions
      (id, document_id, storage_path, source, version_number, display_name)
     VALUES (?, ?, ?, 'upload', 1, NULL)`,
  ).run(versionId, args.documentId, args.filename);
  db.prepare(
    `INSERT INTO document_index_files
      (id, document_id, version_id, status, chunk_count, text_bytes)
     VALUES (?, ?, ?, 'ready', ?, ?)`,
  ).run(
    `index-${args.documentId}`,
    args.documentId,
    versionId,
    chunkCount,
    Buffer.byteLength(args.content) * chunkCount,
  );
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const chunkId = `chunk-${args.documentId}-${chunkIndex}`;
    const content = `${args.content} part${chunkIndex}`;
    db.prepare(
      `INSERT INTO document_index_chunks
        (id, document_id, version_id, chunk_index, page_number, content,
         start_char, end_char, token_count)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      chunkId,
      args.documentId,
      versionId,
      chunkIndex,
      chunkIndex + 1,
      content,
      content.length,
      content.split(/\s+/).length,
    );
    db.prepare(
      `INSERT INTO document_index_chunks_fts (chunk_id, document_id, version_id, content)
       VALUES (?, ?, ?, ?)`,
    ).run(chunkId, args.documentId, versionId, content);
    db.prepare(
      `INSERT INTO document_index_chunks_fts_trigram (chunk_id, document_id, version_id, content)
       VALUES (?, ?, ?, ?)`,
    ).run(chunkId, args.documentId, versionId, content);
  }
}

/** Every chunk contains "indemnity" plus one unique marker word. */
function seedProject(projectId: string, chunkCount = 1): void {
  insertProject(projectId);
  WORDS.forEach((word, index) => {
    insertIndexedDocument({
      projectId,
      documentId: `${projectId}-${word}`,
      filename: `file-${index}.pdf`,
      content: `The indemnity obligation is discussed here ${word}`.repeat(
        // Different lengths give BM25 something to distinguish the chunks by.
        index + 1,
      ),
      chunkCount,
    });
  });
}

const QUERY = "indemnity";

// ---------------------------------------------------------------------------
// (a) Identity
// ---------------------------------------------------------------------------

test("rerank omitted, false, or unavailable all yield the identical hybrid ranking", async (t) => {
  const projectId = "rr-identity";
  seedProject(projectId);

  const baseline = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 6,
  });
  assert.equal(baseline.length, 6, "fixture should be fully retrievable");
  assert.ok(baseline.every((row) => !row.match_reasons?.includes("rerank")));
  assert.ok(baseline.every((row) => row.rerank_score == null));

  const explicitFalse = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 6,
    rerank: false,
  });
  assert.deepEqual(explicitFalse, baseline);

  process.env.DOCKET_RERANK_BASE_URL = baseUrl;
  process.env.DOCKET_RERANK_ENABLED = "0";
  const disabled = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 6,
    rerank: true,
  });
  assert.deepEqual(disabled, baseline);
  assert.equal(
    receivedDocuments.length,
    0,
    "disabled reranker must not call the server",
  );

  delete process.env.DOCKET_RERANK_BASE_URL;
  delete process.env.DOCKET_RERANK_ENABLED;
  process.env.DOCKET_RERANK_BINARY = "/nonexistent/llama-server";
  process.env.DOCKET_RERANK_MODEL = "/nonexistent/model.gguf";
  const warn = t.mock.method(console, "warn", () => undefined);
  const unavailable = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 6,
    rerank: true,
  });
  assert.deepEqual(unavailable, baseline);
  assert.equal(
    warn.mock.callCount(),
    0,
    "an unavailable reranker must stay silent",
  );
  assert.equal(receivedDocuments.length, 0);
});

// ---------------------------------------------------------------------------
// (b) Reordering with a widened candidate pool
// ---------------------------------------------------------------------------

test("rerank: true reorders by the cross-encoder and widens the candidate pool beyond limit", async () => {
  const projectId = "rr-reorder";
  seedProject(projectId);

  const baseline = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 6,
  });
  // Make the cross-encoder disagree with hybrid: the hybrid-last chunk wins.
  const hybridOrder = baseline.map((row) => wordOf(row.content));
  const adversarial = Object.fromEntries(
    hybridOrder.map((word, position) => [word, 0.1 + position * 0.1]),
  ) as Record<Word, number>;
  respond = scoreByWord(adversarial);
  useFakeServer(20);

  const reranked = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 2,
    rerank: true,
  });

  assert.equal(reranked.length, 2);
  assert.deepEqual(
    reranked.map((row) => wordOf(row.content)),
    [...hybridOrder].reverse().slice(0, 2),
  );
  assert.notEqual(
    wordOf(reranked[0].content),
    hybridOrder[0],
    "fixture must make reranking visibly change the top result",
  );
  for (const row of reranked) {
    assert.equal(typeof row.rerank_score, "number");
    assert.ok(row.match_reasons?.includes("rerank"));
  }
  assert.ok(reranked[0].rerank_score! >= reranked[1].rerank_score!);

  assert.equal(receivedDocuments.length, 1);
  assert.ok(
    receivedDocuments[0].length > 2,
    `candidate pool was not widened (${receivedDocuments[0].length} documents)`,
  );
  assert.equal(receivedDocuments[0].length, 6);
});

test("rerank: the best-scored chunk is first (zeta fixture)", async () => {
  const projectId = "rr-zeta";
  seedProject(projectId);
  useFakeServer(20);
  const results = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 3,
    rerank: true,
  });
  assert.deepEqual(
    results.map((row) => wordOf(row.content)),
    ["zeta", "epsilon", "delta"],
  );
});

test("rerank depth below the pool size reranks only the head", async () => {
  const projectId = "rr-depth";
  seedProject(projectId);
  const baseline = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 6,
  });
  useFakeServer(5);
  const results = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 6,
    rerank: true,
  });
  assert.equal(receivedDocuments[0].length, 5);
  assert.equal(results.length, 6);
  assert.equal(
    results[5]?.chunk_id,
    baseline[5]?.chunk_id,
    "tail row keeps its hybrid position",
  );
  assert.ok(!results[5]?.match_reasons?.includes("rerank"));
  assert.ok(
    results.slice(0, 5).every((row) => row.match_reasons?.includes("rerank")),
  );
});

// ---------------------------------------------------------------------------
// (c) Neighbours and (d) document grouping
// ---------------------------------------------------------------------------

test("includeNeighbors groups neighbour rows around the reranked order", async () => {
  const projectId = "rr-neighbors";
  seedProject(projectId, 3);
  useFakeServer(20);

  const results = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 6,
    includeNeighbors: true,
    rerank: true,
  });

  assert.ok(results.length > 0);
  assert.equal(results[0].document_id, `${projectId}-zeta`);
  // Neighbours of the top hit stay adjacent to it, before the next document.
  const firstOtherIndex = results.findIndex(
    (row) => row.document_id !== `${projectId}-zeta`,
  );
  const lastZetaIndex = results
    .map((row) => row.document_id)
    .lastIndexOf(`${projectId}-zeta`);
  assert.ok(firstOtherIndex === -1 || lastZetaIndex < firstOtherIndex);
});

test("group: 'documents' returns documents in reranked order with chunk counts", async () => {
  const projectId = "rr-group";
  seedProject(projectId, 2);
  useFakeServer(20);

  const results = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 6,
    group: "documents",
    rerank: true,
  });

  assert.equal(results.length, 6);
  assert.deepEqual(
    results.map((row) => wordOf(row.content)),
    ["zeta", "epsilon", "delta", "gamma", "beta", "alpha"],
  );
  assert.equal(new Set(results.map((row) => row.document_id)).size, 6);
  for (const row of results) {
    assert.equal(row.grouped_chunk_count, 2);
    assert.ok(row.match_reasons?.includes("rerank"));
    assert.equal(typeof row.rerank_score, "number");
  }
});

// ---------------------------------------------------------------------------
// (e) Failure
// ---------------------------------------------------------------------------

test("a failing rerank server leaves the hybrid results intact and never throws", async (t) => {
  const projectId = "rr-failure";
  seedProject(projectId);
  const baseline = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 2,
  });

  respond = (_documents, res) => {
    res.writeHead(500).end("boom");
  };
  useFakeServer(20);
  const warn = t.mock.method(console, "warn", () => undefined);

  const results = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 2,
    rerank: true,
  });

  assert.equal(results.length, 2);
  assert.ok(results.every((row) => row.rerank_score == null));
  assert.ok(results.every((row) => !row.match_reasons?.includes("rerank")));
  assert.equal(receivedDocuments.length, 1);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /falling back/);
  assert.deepEqual(
    results.map((row) => row.chunk_id),
    baseline.map((row) => row.chunk_id),
  );
});

test("an unreachable rerank server also falls back without throwing", async (t) => {
  const projectId = "rr-unreachable";
  seedProject(projectId);
  const baseline = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 3,
  });

  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  process.env.DOCKET_RERANK_BASE_URL = `http://127.0.0.1:${closedPort}`;
  process.env.DOCKET_RERANK_DEPTH = "20";
  const warn = t.mock.method(console, "warn", () => undefined);

  const results = await searchProjectIndex({
    projectId,
    query: QUERY,
    limit: 3,
    rerank: true,
  });
  assert.equal(results.length, 3);
  assert.ok(results.every((row) => row.rerank_score == null));
  assert.deepEqual(
    results.map((row) => row.chunk_id),
    baseline.map((row) => row.chunk_id),
  );
  assert.equal(warn.mock.callCount(), 1);
});
