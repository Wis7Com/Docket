/**
 * Offline retrieval reranking experiment.
 *
 * This script intentionally does not alter the production index or retrieval
 * path. Without --live it runs a deterministic scoring self-test.
 */
import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { closeDb, runWithDatabaseContext } from "../src/db/sqlite";
import {
  embedDocumentTexts,
  embedQueryText,
  readUserEmbeddingSettings,
  type EmbeddingSettings,
} from "../src/lib/indexing/embeddings";
import { searchProjectIndex } from "../src/lib/indexing/search";
import type { SearchResult } from "../src/lib/indexing/types";
import {
  evaluationSetSchema,
  scoreRetrievalHit,
} from "../src/lib/perfAccuracyEval";
import {
  getRegisteredProjectByPath,
  projectContextFor,
} from "../src/lib/projectRegistry";

const DEFAULT_CANDIDATE_K = 40;
const DEFAULT_RESULT_K = 8;
const DEFAULT_RERANK_MODEL = "batiai/qwen3-embedding:4b";
const EMBEDDING_BATCH_SIZE = 16;
const MAX_SEARCH_K = 200;

const VALUE_OPTIONS = new Set([
  "--evalset",
  "--project-path",
  "--app-data-path",
  "--output-dir",
  "--candidate-k",
  "--result-k",
  "--rerank-model",
]);
const FLAG_OPTIONS = new Set(["--live", "--help"]);

type CliOptions = {
  live: boolean;
  help: boolean;
  evalsetPath?: string;
  projectPath?: string;
  appDataPath?: string;
  outputDir?: string;
  candidateK: number;
  resultK: number;
  rerankModel: string;
};

type CandidateWithVector = {
  candidate: SearchResult;
  originalRank: number;
  vector: number[];
};

type RankedCandidate = CandidateWithVector & {
  cosine: number;
  normalizedReciprocalRank: number;
  blend: number;
};

type QaResult = {
  id: string;
  question: string;
  gold_doc: string;
  gold_page: number;
  candidate_count: number;
  search_wall_time_ms: number;
  rerank_latency_ms: number;
  baseline_rank: number | null;
  candidate_ceiling_rank: number | null;
  cosine_rank: number | null;
  blend_rank: number | null;
  baseline_top: CandidateSummary[];
  cosine_top: CandidateSummary[];
  blend_top: CandidateSummary[];
};

type CandidateSummary = {
  original_rank: number;
  document_id: string;
  filename: string;
  page_number: number | null;
  cosine?: number;
  blend?: number;
};

type MetricSummary = {
  k: number;
  hits: number;
  total: number;
  hit_rate: number;
};

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SEARCH_K) {
    throw new Error(`${option} must be an integer from 1 to ${MAX_SEARCH_K}`);
  }
  return parsed;
}

function parseCli(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (FLAG_OPTIONS.has(argument)) {
      if (flags.has(argument)) throw new Error(`Duplicate option: ${argument}`);
      flags.add(argument);
      continue;
    }
    if (!VALUE_OPTIONS.has(argument))
      throw new Error(`Unknown option: ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
    index += 1;
  }

  const candidateK = values.has("--candidate-k")
    ? parsePositiveInteger(values.get("--candidate-k")!, "--candidate-k")
    : DEFAULT_CANDIDATE_K;
  const resultK = values.has("--result-k")
    ? parsePositiveInteger(values.get("--result-k")!, "--result-k")
    : DEFAULT_RESULT_K;
  if (resultK > candidateK) {
    throw new Error("--result-k cannot exceed --candidate-k");
  }

  return {
    live: flags.has("--live"),
    help: flags.has("--help"),
    evalsetPath: values.get("--evalset"),
    projectPath: values.get("--project-path"),
    appDataPath: values.get("--app-data-path"),
    outputDir: values.get("--output-dir"),
    candidateK,
    resultK,
    rerankModel: values.get("--rerank-model") ?? DEFAULT_RERANK_MODEL,
  };
}

function usage(): string {
  return [
    "Offline retrieval reranking experiment",
    "",
    "Self-test:",
    "  node --import tsx scripts/perf-accuracy-rerank.ts",
    "",
    "Live experiment:",
    "  APP_DATA_PATH=/path/to/app-data node --import tsx scripts/perf-accuracy-rerank.ts \\",
    "    --live --evalset /path/to/evalset.json --project-path /path/to/project \\",
    "    --output-dir /path/to/results [--candidate-k 40] [--result-k 8] \\",
    `    [--rerank-model ${DEFAULT_RERANK_MODEL}]`,
    "",
    "Live mode requires an output directory. Files are created exclusively.",
  ].join("\n");
}

function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function normalizedReciprocalRank(
  rank: number,
  candidateCount: number,
): number {
  if (candidateCount <= 1) return 1;
  const minimum = 1 / candidateCount;
  return (1 / rank - minimum) / (1 - minimum);
}

function rankCandidates(
  queryVector: readonly number[],
  candidates: readonly CandidateWithVector[],
): { cosine: RankedCandidate[]; blend: RankedCandidate[] } {
  const scored = candidates.map((entry) => {
    const cosine = cosineSimilarity(queryVector, entry.vector);
    const rankPrior = normalizedReciprocalRank(
      entry.originalRank,
      candidates.length,
    );
    const normalizedCosine = Math.max(0, Math.min(1, (cosine + 1) / 2));
    return {
      ...entry,
      cosine,
      normalizedReciprocalRank: rankPrior,
      blend: 0.5 * normalizedCosine + 0.5 * rankPrior,
    };
  });
  const stableSort = (key: "cosine" | "blend") =>
    [...scored].sort(
      (left, right) =>
        right[key] - left[key] || left.originalRank - right.originalRank,
    );
  return { cosine: stableSort("cosine"), blend: stableSort("blend") };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

function exactRank(
  candidates: readonly SearchResult[],
  goldDoc: string,
  goldPage: number,
  k: number,
): number | null {
  return scoreRetrievalHit({ goldDoc, goldPage, candidates, k }).rank;
}

function summarizeCandidate(
  entry: CandidateWithVector | RankedCandidate,
): CandidateSummary {
  const ranked = entry as Partial<RankedCandidate>;
  return {
    original_rank: entry.originalRank,
    document_id: entry.candidate.document_id,
    filename: entry.candidate.filename,
    page_number: entry.candidate.page_number,
    ...(ranked.cosine === undefined ? {} : { cosine: ranked.cosine }),
    ...(ranked.blend === undefined ? {} : { blend: ranked.blend }),
  };
}

function metricSummary(
  results: readonly QaResult[],
  rankField:
    | "baseline_rank"
    | "candidate_ceiling_rank"
    | "cosine_rank"
    | "blend_rank",
  k: number,
): MetricSummary {
  const hits = results.filter((result) => {
    const rank = result[rankField];
    return rank !== null && rank <= k;
  }).length;
  return { k, hits, total: results.length, hit_rate: hits / results.length };
}

async function configureAppDataPath(optionValue?: string): Promise<void> {
  const configured = optionValue ?? process.env.APP_DATA_PATH;
  if (!configured) {
    throw new Error("Live mode requires --app-data-path or APP_DATA_PATH");
  }
  const resolved = path.resolve(configured);
  const appDbFile = path.join(resolved, "app.db");
  await access(appDbFile, fsConstants.R_OK).catch(() => {
    throw new Error(`App database is not readable: ${appDbFile}`);
  });
  process.env.APP_DATA_PATH = resolved;
}

async function loadEvaluationSet(file: string) {
  const raw = await readFile(path.resolve(file), "utf8");
  return evaluationSetSchema.parse(JSON.parse(raw) as unknown);
}

function rerankSettings(userId: string, model: string): EmbeddingSettings {
  const active = readUserEmbeddingSettings(userId);
  return {
    enabled: true,
    provider: "ollama",
    model,
    baseUrl: active.provider === "ollama" ? active.baseUrl : null,
    apiKey: null,
    dimensionsPolicy: "truncate-to-256",
    memoryProfile: "lightweight",
  };
}

async function encodeCandidates(
  candidatesByQa: readonly (readonly SearchResult[])[],
  settings: EmbeddingSettings,
): Promise<{ vectors: Map<string, number[]>; wallTimeMs: number }> {
  const unique = new Map<string, string>();
  for (const candidates of candidatesByQa) {
    for (const candidate of candidates) {
      if (!unique.has(candidate.chunk_id))
        unique.set(candidate.chunk_id, candidate.content);
    }
  }
  const entries = [...unique.entries()];
  const vectors = new Map<string, number[]>();
  const started = performance.now();
  for (
    let offset = 0;
    offset < entries.length;
    offset += EMBEDDING_BATCH_SIZE
  ) {
    const batch = entries.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const embedded = await embedDocumentTexts(
      batch.map(([, content]) => content),
      settings,
    );
    batch.forEach(([chunkId], index) =>
      vectors.set(chunkId, embedded[index].vector),
    );
    console.info(
      `Encoded ${Math.min(offset + batch.length, entries.length)}/${entries.length} unique candidate chunks`,
    );
  }
  return { vectors, wallTimeMs: performance.now() - started };
}

async function runLive(options: CliOptions): Promise<void> {
  if (!options.evalsetPath || !options.projectPath || !options.outputDir) {
    throw new Error(
      "Live mode requires --evalset, --project-path, and --output-dir",
    );
  }
  await configureAppDataPath(options.appDataPath);
  const evalset = await loadEvaluationSet(options.evalsetPath);
  const project = getRegisteredProjectByPath(options.projectPath);
  if (!project?.user_id) {
    throw new Error(
      "Project is not registered with a user in the configured app database",
    );
  }
  const startedAt = new Date();

  try {
    const report = await runWithDatabaseContext(
      projectContextFor(project),
      async () => {
        const candidatesByQa: SearchResult[][] = [];
        const searchWallTimes: number[] = [];
        for (const qa of evalset.qa) {
          const started = performance.now();
          candidatesByQa.push(
            await searchProjectIndex({
              projectId: project.id,
              userId: project.user_id,
              query: qa.question,
              limit: options.candidateK,
              includeNeighbors: false,
            }),
          );
          searchWallTimes.push(performance.now() - started);
        }

        const settings = rerankSettings(project.user_id, options.rerankModel);
        const encoded = await encodeCandidates(candidatesByQa, settings);
        const qaResults: QaResult[] = [];
        const rerankLatencies: number[] = [];
        for (const [index, qa] of evalset.qa.entries()) {
          const candidates = candidatesByQa[index];
          const vectorCandidates = candidates.map(
            (candidate, candidateIndex) => {
              const vector = encoded.vectors.get(candidate.chunk_id);
              if (!vector)
                throw new Error(
                  `Missing cached vector for chunk ${candidate.chunk_id}`,
                );
              return { candidate, originalRank: candidateIndex + 1, vector };
            },
          );
          const rerankStarted = performance.now();
          const queryVector = (await embedQueryText(qa.question, settings))
            .vector;
          const ranked = rankCandidates(queryVector, vectorCandidates);
          const rerankLatency = performance.now() - rerankStarted;
          rerankLatencies.push(rerankLatency);
          const cosineCandidates = ranked.cosine.map(
            (entry) => entry.candidate,
          );
          const blendCandidates = ranked.blend.map((entry) => entry.candidate);
          qaResults.push({
            id: qa.id ?? `qa-${index + 1}`,
            question: qa.question,
            gold_doc: qa.gold_doc,
            gold_page: qa.gold_page,
            candidate_count: candidates.length,
            search_wall_time_ms: searchWallTimes[index],
            rerank_latency_ms: rerankLatency,
            baseline_rank: exactRank(
              candidates,
              qa.gold_doc,
              qa.gold_page,
              options.candidateK,
            ),
            candidate_ceiling_rank: exactRank(
              candidates,
              qa.gold_doc,
              qa.gold_page,
              options.candidateK,
            ),
            cosine_rank: exactRank(
              cosineCandidates,
              qa.gold_doc,
              qa.gold_page,
              options.candidateK,
            ),
            blend_rank: exactRank(
              blendCandidates,
              qa.gold_doc,
              qa.gold_page,
              options.candidateK,
            ),
            baseline_top: vectorCandidates
              .slice(0, options.resultK)
              .map(summarizeCandidate),
            cosine_top: ranked.cosine
              .slice(0, options.resultK)
              .map(summarizeCandidate),
            blend_top: ranked.blend
              .slice(0, options.resultK)
              .map(summarizeCandidate),
          });
          console.info(
            `Reranked ${index + 1}/${evalset.qa.length}: ${qa.id ?? `qa-${index + 1}`}`,
          );
        }

        return {
          schema_version: 1,
          run_id: `rerank-${startedAt.toISOString().replace(/[-:.]/g, "")}`,
          evalset_name: evalset.name,
          started_at: startedAt.toISOString(),
          finished_at: new Date().toISOString(),
          settings: {
            candidate_k: options.candidateK,
            result_k: options.resultK,
            production_candidate_source: "searchProjectIndex",
            rerank_provider: settings.provider,
            rerank_model: settings.model,
            dimensions_policy: settings.dimensionsPolicy,
            blend:
              "0.5 * normalized cosine + 0.5 * normalized reciprocal original rank",
          },
          timings: {
            unique_candidate_chunks: encoded.vectors.size,
            candidate_embedding_batch_size: EMBEDDING_BATCH_SIZE,
            candidate_encoding_wall_time_ms: encoded.wallTimeMs,
            per_query_rerank_latency_ms: {
              values: rerankLatencies,
              p50: percentile(rerankLatencies, 0.5),
              p95: percentile(rerankLatencies, 0.95),
            },
          },
          summaries: {
            baseline_hit_at_result_k: metricSummary(
              qaResults,
              "baseline_rank",
              options.resultK,
            ),
            candidate_ceiling_hit_at_candidate_k: metricSummary(
              qaResults,
              "candidate_ceiling_rank",
              options.candidateK,
            ),
            cosine_hit_at_result_k: metricSummary(
              qaResults,
              "cosine_rank",
              options.resultK,
            ),
            blend_hit_at_result_k: metricSummary(
              qaResults,
              "blend_rank",
              options.resultK,
            ),
          },
          qa_results: qaResults,
          notes:
            "Bounded offline experiment only; candidate and query embeddings are not written to the product index.",
        };
      },
    );

    const outputDir = path.resolve(options.outputDir);
    await mkdir(outputDir, { recursive: true });
    const jsonFile = path.join(
      outputDir,
      `perf-accuracy-${report.run_id}.json`,
    );
    const markdownFile = path.join(
      outputDir,
      `perf-accuracy-${report.run_id}.md`,
    );
    await Promise.all([
      writeFile(jsonFile, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      }),
      writeFile(markdownFile, renderMarkdown(report), {
        encoding: "utf8",
        flag: "wx",
      }),
    ]);
    console.table(report.summaries);
    console.info(`Wrote ${jsonFile}`);
    console.info(`Wrote ${markdownFile}`);
  } finally {
    closeDb();
  }
}

function renderMarkdown(report: {
  run_id: string;
  started_at: string;
  finished_at: string;
  settings: Record<string, unknown>;
  timings: {
    unique_candidate_chunks: number;
    candidate_embedding_batch_size: number;
    candidate_encoding_wall_time_ms: number;
    per_query_rerank_latency_ms: { p50: number; p95: number };
  };
  summaries: Record<string, MetricSummary>;
  qa_results: QaResult[];
}): string {
  const lines = [
    "# Offline Retrieval Reranking Experiment",
    "",
    `- Run: ${report.run_id}`,
    `- Started: ${report.started_at}`,
    `- Finished: ${report.finished_at}`,
    `- Candidate encoding: ${Math.round(report.timings.candidate_encoding_wall_time_ms)} ms for ${report.timings.unique_candidate_chunks} unique chunks (batch ${report.timings.candidate_embedding_batch_size})`,
    `- Per-query rerank latency: p50 ${Math.round(report.timings.per_query_rerank_latency_ms.p50)} ms; p95 ${Math.round(report.timings.per_query_rerank_latency_ms.p95)} ms`,
    "",
    "## Accuracy",
    "",
    "| Method | Hits | Rate | K |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const [name, summary] of Object.entries(report.summaries)) {
    lines.push(
      `| ${name.replaceAll("_", " ")} | ${summary.hits}/${summary.total} | ${(summary.hit_rate * 100).toFixed(1)}% | ${summary.k} |`,
    );
  }
  lines.push(
    "",
    "## Per-QA ranks",
    "",
    "| ID | Baseline | Candidate ceiling | Cosine | 50/50 blend | Rerank latency |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const qa of report.qa_results) {
    lines.push(
      `| ${qa.id} | ${qa.baseline_rank ?? "—"} | ${qa.candidate_ceiling_rank ?? "—"} | ${qa.cosine_rank ?? "—"} | ${qa.blend_rank ?? "—"} | ${Math.round(qa.rerank_latency_ms)} ms |`,
    );
  }
  lines.push(
    "",
    "This is an offline experiment. It does not modify production retrieval or index data.",
  );
  return `${lines.join("\n")}\n`;
}

function runSelfTest(): void {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);

  const candidate = (
    chunkId: string,
    originalRank: number,
    vector: number[],
  ) => ({
    originalRank,
    vector,
    candidate: {
      document_id: chunkId,
      version_id: "version",
      chunk_id: chunkId,
      filename: `${chunkId}.pdf`,
      file_type: "pdf",
      chunk_index: originalRank - 1,
      page_number: originalRank,
      page_end: originalRank,
      location_hint: null,
      quote: chunkId,
      snippet: chunkId,
      content: chunkId,
      score: 0,
      basic_match: false,
    },
  });
  const ranked = rankCandidates(
    [1, 0],
    [candidate("first", 1, [0, 1]), candidate("second", 2, [1, 0])],
  );
  assert.equal(ranked.cosine[0].candidate.chunk_id, "second");
  assert.equal(ranked.blend[0].candidate.chunk_id, "first");
  assert.equal(ranked.blend[0].normalizedReciprocalRank, 1);
  assert.equal(ranked.blend[1].normalizedReciprocalRank, 0);
  console.info("perf-accuracy-rerank deterministic self-test passed");
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    console.info(usage());
    return;
  }
  if (!options.live) {
    if (
      options.evalsetPath ||
      options.projectPath ||
      options.appDataPath ||
      options.outputDir ||
      options.candidateK !== DEFAULT_CANDIDATE_K ||
      options.resultK !== DEFAULT_RESULT_K ||
      options.rerankModel !== DEFAULT_RERANK_MODEL
    ) {
      throw new Error("Experiment options require the explicit --live guard");
    }
    runSelfTest();
    return;
  }
  await runLive(options);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
