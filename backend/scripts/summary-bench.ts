/**
 * Live calibration harness for Gemma 12B on this Mac.
 *
 * Usage:
 *   node --import tsx scripts/summary-bench.ts
 *   node --import tsx scripts/summary-bench.ts --live --chunks ./chunks.json
 *   node --import tsx scripts/summary-bench.ts --live --db ./.docket/project.db --document-id <id>
 *
 * The live sweep compares num_ctx, reduce thinking, and chars-per-token. Pick
 * the fastest complete-coverage setting whose prompt_eval_count stays below
 * num_ctx on every call; equality is flagged as possible prompt truncation.
 * Live Ollama/DB access requires --live or SUMMARY_BENCH_LIVE=1. Without that
 * guard this file runs a deterministic fake map/reduce self-test for CI.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  summarizeDocumentWithCoverage,
  type DocumentSummaryChunk,
} from "../src/lib/documentSummary";
import { completeText } from "../src/lib/llm";

type BenchConfig = {
  numCtx: 8_192 | 16_384;
  reduceThinking: boolean;
  charsPerToken: 2 | 2.5;
};

type BenchInput = {
  filename: string;
  documentId: string;
  versionId: string;
  pageCount: number;
  chunks: DocumentSummaryChunk[];
};

type Completion = typeof completeText;

type CallTelemetry = {
  stage: "map" | "reduce";
  promptEvalCount?: number;
  numCtx?: number;
};

type BenchResult = {
  config: BenchConfig;
  wallMs: number;
  mapCalls: number;
  halfSplits: number;
  retries: number;
  promptEval: CallTelemetry[];
  coverageComplete: boolean;
  finalPoints: number;
  reduceMs: number;
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function loadJsonInput(file: string): Promise<BenchInput> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as
    | DocumentSummaryChunk[]
    | Partial<BenchInput>;
  const chunks = Array.isArray(parsed) ? parsed : parsed.chunks;
  if (!chunks?.length) throw new Error("Chunk JSON must contain indexed chunks");
  const pageCount =
    (!Array.isArray(parsed) && parsed.pageCount) ||
    Math.max(...chunks.map((chunk) => chunk.page_end ?? chunk.page_number ?? 0));
  if (pageCount < 1) throw new Error("Unable to derive a positive page count");
  return {
    filename:
      (!Array.isArray(parsed) && parsed.filename) || option("--filename") || "document.pdf",
    documentId:
      (!Array.isArray(parsed) && parsed.documentId) ||
      option("--document-id") ||
      "benchmark-document",
    versionId:
      (!Array.isArray(parsed) && parsed.versionId) ||
      option("--version-id") ||
      "benchmark-version",
    pageCount,
    chunks,
  };
}

async function loadDbInput(dbPath: string, documentId: string): Promise<BenchInput> {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  try {
    const document = db
      .prepare(
        "SELECT filename, page_count, current_version_id FROM documents WHERE id = ?",
      )
      .get(documentId) as
      | {
          filename: string;
          page_count: number | null;
          current_version_id: string | null;
        }
      | undefined;
    const versionId = option("--version-id") || document?.current_version_id;
    if (!document || !versionId) throw new Error("Document/version not found");
    const chunks = db
      .prepare(
        `SELECT id AS chunk_id, chunk_index, page_number, content,
                start_char, end_char
         FROM document_index_chunks
         WHERE document_id = ? AND version_id = ?
         ORDER BY chunk_index ASC`,
      )
      .all(documentId, versionId) as DocumentSummaryChunk[];
    if (!chunks.length) throw new Error("Document has no indexed chunks");
    return {
      filename: document.filename,
      documentId,
      versionId,
      pageCount:
        document.page_count ??
        Math.max(...chunks.map((chunk) => chunk.page_number ?? 0)),
      chunks,
    };
  } finally {
    db.close();
  }
}

function stageForPrompt(systemPrompt: string | undefined): "map" | "reduce" {
  return systemPrompt?.startsWith("You summarize one ordered slice")
    ? "map"
    : "reduce";
}

async function runConfig(
  input: BenchInput,
  config: BenchConfig,
  completion: Completion,
  summaryOverrides: { maxBatchPages?: number } = {},
): Promise<BenchResult> {
  const oldNumCtx = process.env.OLLAMA_MAX_NUM_CTX;
  const oldThinking = process.env.DOCKET_SUMMARY_REDUCE_THINKING;
  const oldChars = process.env.OLLAMA_CHARS_PER_TOKEN;
  const oldInfo = console.info;
  const promptEval: CallTelemetry[] = [];
  const mapBatchIds: string[] = [];
  let retries = 0;
  let reduceMs = 0;
  let activeStage: "map" | "reduce" = "map";

  process.env.OLLAMA_MAX_NUM_CTX = String(config.numCtx);
  process.env.DOCKET_SUMMARY_REDUCE_THINKING = config.reduceThinking
    ? "on"
    : "off";
  process.env.OLLAMA_CHARS_PER_TOKEN = String(config.charsPerToken);
  console.info = (message: unknown, details?: unknown) => {
    if (message !== "[ollama/complete]") return;
    const record = details as Record<string, unknown> | undefined;
    promptEval.push({
      stage: activeStage,
      promptEvalCount:
        typeof record?.prompt_eval_count === "number"
          ? record.prompt_eval_count
          : undefined,
      numCtx: typeof record?.num_ctx === "number" ? record.num_ctx : undefined,
    });
  };

  const instrumented: Completion = async (params) => {
    const stage = stageForPrompt(params.systemPrompt);
    activeStage = stage;
    if (stage === "map") {
      const batchId = params.user.match(/^Batch: (\S+)$/m)?.[1] ?? "unknown";
      mapBatchIds.push(batchId);
      if (params.user.includes("Validation feedback:")) retries += 1;
    }
    const startedAt = Date.now();
    try {
      return await completion(params);
    } finally {
      if (stage === "reduce") reduceMs += Date.now() - startedAt;
    }
  };

  try {
    const startedAt = Date.now();
    const result = await summarizeDocumentWithCoverage(
      {
        model: option("--model") || process.env.SUMMARY_BENCH_MODEL || "ollama:gemma3:12b",
        apiKeys: {},
        filename: input.filename,
        docId: "doc-0",
        documentId: input.documentId,
        versionId: input.versionId,
        chunks: input.chunks,
        pageCount: input.pageCount,
        language: option("--language") || "English",
        focus: option("--focus"),
        mapConcurrency: 1,
        ...summaryOverrides,
      },
      { complete: instrumented, cacheResults: false },
    );
    return {
      config,
      wallMs: Date.now() - startedAt,
      mapCalls: mapBatchIds.length,
      halfSplits: new Set(
        mapBatchIds
          .filter((batchId) => /^batch-\d+[ab]+$/.test(batchId))
          .map((batchId) => batchId.slice(0, -1)),
      ).size,
      retries,
      promptEval,
      coverageComplete: result.coverage.complete,
      finalPoints: result.preparedText
        .split("\n")
        .filter((line) => line.startsWith("- ")).length,
      reduceMs,
    };
  } finally {
    console.info = oldInfo;
    restoreEnv("OLLAMA_MAX_NUM_CTX", oldNumCtx);
    restoreEnv("DOCKET_SUMMARY_REDUCE_THINKING", oldThinking);
    restoreEnv("OLLAMA_CHARS_PER_TOKEN", oldChars);
  }
}

function printResults(results: BenchResult[]): void {
  console.table(
    results.map((result) => ({
      num_ctx: result.config.numCtx,
      thinking: result.config.reduceThinking ? "on" : "off",
      chars_token: result.config.charsPerToken,
      wall_ms: result.wallMs,
      maps: result.mapCalls,
      splits: result.halfSplits,
      retries: result.retries,
      prompt_eval: result.promptEval.length
        ? result.promptEval
            .map(({ stage, promptEvalCount, numCtx }) =>
              `${stage[0]}:${promptEvalCount ?? "?"}/${numCtx ?? "?"}${
                promptEvalCount !== undefined &&
                numCtx !== undefined &&
                promptEvalCount >= numCtx
                  ? "!"
                  : ""
              }`,
            )
            .join(" ")
        : "fake",
      complete: result.coverageComplete,
      points: result.finalPoints,
      reduce_ms: result.reduceMs,
    })),
  );
}

function fakeCompletion(): Completion {
  return async (params) => {
    if (stageForPrompt(params.systemPrompt) === "map") {
      const records = params.user
        .split("\n")
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as {
              chunk_id?: string;
              content?: string;
            };
            return parsed.chunk_id && parsed.content ? [parsed] : [];
          } catch {
            return [];
          }
        });
      return JSON.stringify({
        points: records.map((record) => ({
          text: `Summary of ${record.chunk_id}`,
          evidence: [
            {
              chunk_id: record.chunk_id,
              quote: record.content!.split(/\s+/).slice(0, 4).join(" "),
            },
          ],
        })),
      });
    }
    const summaries = JSON.parse(
      params.user.split("Validated batch summaries:\n")[1],
    ) as {
      points: { text: string; evidence_ids: string[] }[];
    }[];
    return JSON.stringify({
      title: "Self-test summary",
      sections: [
        {
          heading: "Coverage",
          points: summaries.flatMap((summary) => summary.points),
        },
      ],
    });
  };
}

async function selfTest(): Promise<void> {
  const chunks: DocumentSummaryChunk[] = [1, 2].map((page, index) => ({
    chunk_id: `chunk-${page}`,
    chunk_index: index,
    page_number: page,
    content: `Page ${page} contains material benchmark evidence.`,
    start_char: index * 50,
    end_char: index * 50 + 44,
  }));
  const result = await runConfig(
    {
      filename: "self-test.pdf",
      documentId: "self-test-document",
      versionId: "self-test-version",
      pageCount: 2,
      chunks,
    },
    { numCtx: 8_192, reduceThinking: false, charsPerToken: 2.5 },
    fakeCompletion(),
    { maxBatchPages: 1 },
  );
  assert.equal(result.mapCalls, 2);
  assert.equal(result.coverageComplete, true);
  assert.equal(result.finalPoints, 2);
  printResults([result]);
  console.log("summary benchmark self-test passed (live Ollama not used)");
}

async function main(): Promise<void> {
  const live =
    process.argv.includes("--live") || process.env.SUMMARY_BENCH_LIVE === "1";
  if (!live) return selfTest();

  const chunksPath = option("--chunks");
  const dbPath = option("--db");
  const documentId = option("--document-id");
  const input = chunksPath
    ? await loadJsonInput(chunksPath)
    : dbPath && documentId
      ? await loadDbInput(dbPath, documentId)
      : null;
  if (!input) {
    throw new Error(
      "Live mode requires --chunks <json> or --db <project.db> --document-id <id>",
    );
  }

  const configs: BenchConfig[] = [8_192, 16_384].flatMap((numCtx) =>
    [false, true].flatMap((reduceThinking) =>
      ([2, 2.5] as const).map((charsPerToken) => ({
        numCtx: numCtx as BenchConfig["numCtx"],
        reduceThinking,
        charsPerToken,
      })),
    ),
  );
  const results: BenchResult[] = [];
  for (const config of configs) {
    results.push(await runConfig(input, config, completeText));
  }
  printResults(results);
}

main().catch((error) => {
  console.error("summary benchmark failed", error);
  process.exitCode = 1;
});
