/**
 * Retrieval-only performance and accuracy evaluation runner.
 *
 * Usage:
 *   node --import tsx scripts/perf-accuracy-eval.ts
 *   APP_DATA_PATH=/path/to/app-data node --import tsx scripts/perf-accuracy-eval.ts \
 *     --live --evalset /path/to/evalset.json --project-path /path/to/project
 *   node --import tsx scripts/perf-accuracy-eval.ts --live \
 *     --app-data-path /path/to/app-data --evalset /path/to/evalset.json \
 *     --project-path /path/to/project --output-dir /path/to/results
 *
 * Without --live, this script runs an isolated deterministic self-test. Live
 * mode evaluates direct retrieval only: answer reviews remain pending and
 * scenarios are not executed until the evaluation set has human approval.
 * Report files are written only when --output-dir is explicitly supplied.
 */
import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { closeDb, getDb, runWithDatabaseContext } from "../src/db/sqlite";
import {
  evaluationRunResultSchema,
  evaluationSetSchema,
  renderEvaluationResultJson,
  renderEvaluationResultMarkdown,
  scoreRetrievalHit,
  summarizeRetrieval,
  type EvaluationRunResult,
} from "../src/lib/perfAccuracyEval";
import {
  getProjectIndexStatus,
  getProjectSemanticIndexStatus,
} from "../src/lib/indexing/indexer";
import {
  expectedDimensionsForSettings,
  resolveProjectEmbeddingSettings,
  type EmbeddingSettings,
} from "../src/lib/indexing/embeddings";
import { searchProjectIndex } from "../src/lib/indexing/search";
import {
  getRegisteredProjectByPath,
  projectContextFor,
  type ProjectRegistryRow,
} from "../src/lib/projectRegistry";

const DEFAULT_TOP_K = 8;
// searchProjectIndex applies the same hard cap internally.
const MAX_TOP_K = 200;
const VALUE_OPTIONS = new Set([
  "--evalset",
  "--project-path",
  "--app-data-path",
  "--output-dir",
  "--top-k",
]);
const FLAG_OPTIONS = new Set(["--live", "--help"]);

type CliOptions = {
  live: boolean;
  help: boolean;
  evalsetPath?: string;
  projectPath?: string;
  appDataPath?: string;
  outputDir?: string;
  topK: number;
};

type LexicalStatus = ReturnType<typeof getProjectIndexStatus>;
type SemanticStatus = ReturnType<typeof getProjectSemanticIndexStatus>;

type SemanticCoverage = {
  eligible_chunks: number;
  ready_chunks: number;
};

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
    if (!VALUE_OPTIONS.has(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
    index += 1;
  }

  const rawTopK = values.get("--top-k");
  const topK = rawTopK === undefined ? DEFAULT_TOP_K : Number(rawTopK);
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
    throw new Error(`--top-k must be an integer from 1 to ${MAX_TOP_K}`);
  }

  return {
    live: flags.has("--live"),
    help: flags.has("--help"),
    evalsetPath: values.get("--evalset"),
    projectPath: values.get("--project-path"),
    appDataPath: values.get("--app-data-path"),
    outputDir: values.get("--output-dir"),
    topK,
  };
}

function usage(): string {
  return [
    "Retrieval-only evaluation runner",
    "",
    "Self-test:",
    "  node --import tsx scripts/perf-accuracy-eval.ts",
    "",
    "Live retrieval evaluation:",
    "  APP_DATA_PATH=/path/to/app-data node --import tsx scripts/perf-accuracy-eval.ts \\",
    "    --live --evalset /path/to/evalset.json --project-path /path/to/project \\",
    "    [--top-k 8] [--output-dir /path/to/results]",
    "",
    "Use --app-data-path instead of APP_DATA_PATH when preferred. JSON and",
    "Markdown report files are created only with an explicit --output-dir.",
  ].join("\n");
}

async function loadEvaluationSet(file: string) {
  const raw = await readFile(path.resolve(file), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Unable to parse evaluation set JSON: ${errorMessage(error)}`,
    );
  }
  return evaluationSetSchema.parse(parsed);
}

async function configureAppDataPath(optionValue?: string): Promise<string> {
  const configured = optionValue ?? process.env.APP_DATA_PATH;
  if (!configured) {
    throw new Error(
      "Live mode requires --app-data-path or APP_DATA_PATH so registered project and user settings can be resolved",
    );
  }
  const resolved = path.resolve(configured);
  const appDbFile = path.join(resolved, "app.db");
  try {
    await access(appDbFile, fsConstants.R_OK);
  } catch {
    throw new Error(`App database is not readable: ${appDbFile}`);
  }
  process.env.APP_DATA_PATH = resolved;
  return resolved;
}

function resolveRegisteredProject(projectPath: string): ProjectRegistryRow {
  let project: ProjectRegistryRow | null;
  try {
    project = getRegisteredProjectByPath(projectPath);
  } catch (error) {
    throw new Error(`Unable to read project registry: ${errorMessage(error)}`);
  }
  if (!project) {
    throw new Error(
      "Project path is not registered in the configured app database; open or import it in the app first",
    );
  }
  if (!project.user_id) {
    throw new Error(
      "Registered project has no user_id for app settings lookup",
    );
  }
  return project;
}

function verifyProjectIdentity(project: ProjectRegistryRow): void {
  const row = getDb()
    .prepare("SELECT user_id FROM projects WHERE id = ?")
    .get(project.id) as { user_id: string } | undefined;
  if (!row) {
    throw new Error("Registered project is missing from its project database");
  }
  if (row.user_id !== project.user_id) {
    throw new Error(
      "Project registry and project database user_id do not match",
    );
  }
}

function activeSemanticCoverage(
  projectId: string,
  settings: EmbeddingSettings,
): SemanticCoverage {
  const expectedDimensions = expectedDimensionsForSettings(settings);
  return getDb()
    .prepare(
      `
      SELECT
        COUNT(*) AS eligible_chunks,
        COALESCE(SUM(
          CASE WHEN EXISTS (
            SELECT 1
            FROM document_index_vectors v
            WHERE v.chunk_id = c.id
              AND v.provider = ?
              AND v.model_id = ?
              AND v.status = 'ready'
              AND v.embedding_blob IS NOT NULL
              AND (? = 0 OR v.dimensions = ?)
          ) THEN 1 ELSE 0 END
        ), 0) AS ready_chunks
      FROM document_index_chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN document_index_files f
        ON f.document_id = c.document_id
       AND f.version_id = c.version_id
       AND f.status = 'ready'
      WHERE d.project_id = ?
        AND d.current_version_id = c.version_id
      `,
    )
    .get(
      settings.provider,
      settings.model,
      expectedDimensions,
      expectedDimensions,
      projectId,
    ) as SemanticCoverage;
}

function assertLexicalReady(status: LexicalStatus): void {
  const ready = status.status_counts.ready ?? 0;
  if (status.total_documents < 1) {
    throw new Error("Project has no documents to evaluate");
  }
  if (status.queued_jobs !== 0) {
    throw new Error(
      `Lexical index still has ${status.queued_jobs} queued jobs`,
    );
  }
  if (ready !== status.total_documents) {
    throw new Error(
      `Lexical index is not ready for every document (${ready}/${status.total_documents})`,
    );
  }
  if (status.chunk_count < 1) {
    throw new Error("Lexical index contains no searchable chunks");
  }
}

function assertSemanticReady(
  status: SemanticStatus,
  coverage: SemanticCoverage,
): void {
  if (!status.enabled) {
    throw new Error("Semantic indexing is disabled for the registered user");
  }
  if (status.queued_vectors !== 0) {
    throw new Error(
      `Semantic index still has ${status.queued_vectors} queued vectors`,
    );
  }
  const unfinished = ["pending", "embedding", "error"].reduce(
    (sum, key) => sum + (status.status_counts[key] ?? 0),
    0,
  );
  if (unfinished !== 0) {
    throw new Error(`Semantic index has ${unfinished} unfinished vectors`);
  }
  if (
    status.total_vectors < 1 ||
    status.ready_vectors !== status.total_vectors
  ) {
    throw new Error(
      `Semantic vector status is incomplete (${status.ready_vectors}/${status.total_vectors})`,
    );
  }
  if (
    coverage.eligible_chunks < 1 ||
    coverage.ready_chunks !== coverage.eligible_chunks
  ) {
    throw new Error(
      `Active semantic settings do not cover every chunk (${coverage.ready_chunks}/${coverage.eligible_chunks})`,
    );
  }
}

async function runLive(options: CliOptions): Promise<void> {
  if (!options.evalsetPath || !options.projectPath) {
    throw new Error("Live mode requires --evalset and --project-path");
  }
  await configureAppDataPath(options.appDataPath);
  const evalset = await loadEvaluationSet(options.evalsetPath);
  const project = resolveRegisteredProject(options.projectPath);
  const context = projectContextFor(project);

  try {
    const result = await runWithDatabaseContext(context, async () => {
      verifyProjectIdentity(project);
      const lexical = getProjectIndexStatus(project.id);
      const settings = resolveProjectEmbeddingSettings(
        project.user_id,
        project.id,
      );
      const semantic = getProjectSemanticIndexStatus(
        project.id,
        project.user_id,
      );
      const coverage = activeSemanticCoverage(project.id, settings);
      assertLexicalReady(lexical);
      assertSemanticReady(semantic, coverage);

      console.info(
        `Index ready: ${lexical.total_documents} documents, ${lexical.chunk_count} chunks`,
      );
      console.info(
        `Semantic ready: ${semantic.provider}/${semantic.model_id}, ${semantic.dimensions_policy}, ${coverage.ready_chunks} vectors`,
      );

      const startedAt = new Date();
      const qaResults: EvaluationRunResult["qa_results"] = [];
      for (const [index, qa] of evalset.qa.entries()) {
        const started = performance.now();
        const candidates = await searchProjectIndex({
          projectId: project.id,
          userId: project.user_id,
          query: qa.question,
          limit: options.topK,
          includeNeighbors: false,
        });
        const wallTimeMs = performance.now() - started;
        qaResults.push({
          id: qa.id ?? `qa-${index + 1}`,
          question: qa.question,
          expected_answer_gist: qa.expected_answer_gist,
          gold_doc: qa.gold_doc,
          gold_page: qa.gold_page,
          retrieval: scoreRetrievalHit({
            goldDoc: qa.gold_doc,
            goldPage: qa.gold_page,
            candidates,
            k: options.topK,
          }),
          answer_review: { status: "pending" },
          wall_time_ms: wallTimeMs,
          emitted_citations: 0,
          valid_citations: 0,
        });
      }

      const timestamp = startedAt.toISOString().replace(/[-:.]/g, "");
      return evaluationRunResultSchema.parse({
        schema_version: 1,
        run_id: `retrieval-${timestamp}`,
        evalset_name: evalset.name,
        model: "retrieval-only",
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        top_k: options.topK,
        qa_results: qaResults,
        scenario_results: [],
        notes:
          "Retrieval-only baseline. Answer reviews remain pending and scenarios were not executed pending human approval.",
      });
    });

    printSummary(result, evalset.scenarios.length);
    if (options.outputDir) await writeReports(result, options.outputDir);
    else
      console.info(
        "No report files written. Supply --output-dir to create JSON and Markdown reports.",
      );
  } finally {
    closeDb();
  }
}

function printSummary(
  result: EvaluationRunResult,
  skippedScenarioCount: number,
): void {
  const summary = summarizeRetrieval(result.qa_results);
  console.info(
    `Retrieval-only hit@${result.top_k}: ${summary.hits}/${summary.total}`,
  );
  console.info(
    `Answer reviews pending: ${result.qa_results.length}; scenarios skipped: ${skippedScenarioCount}`,
  );
  console.table(
    result.qa_results.map((qa) => ({
      id: qa.id,
      hit: qa.retrieval.hit,
      rank: qa.retrieval.rank ?? "-",
      documentHit: qa.retrieval.document_hit,
      wallMs: Math.round(qa.wall_time_ms ?? 0),
    })),
  );
}

async function writeReports(
  result: EvaluationRunResult,
  outputDir: string,
): Promise<void> {
  const resolved = path.resolve(outputDir);
  await mkdir(resolved, { recursive: true });
  const stem = `perf-accuracy-${result.run_id}`;
  const jsonFile = path.join(resolved, `${stem}.json`);
  const markdownFile = path.join(resolved, `${stem}.md`);
  await Promise.all([
    writeFile(jsonFile, renderEvaluationResultJson(result), {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(markdownFile, renderEvaluationResultMarkdown(result), {
      encoding: "utf8",
      flag: "wx",
    }),
  ]);
  console.info(`Wrote ${jsonFile}`);
  console.info(`Wrote ${markdownFile}`);
}

function runSelfTest(): void {
  const evalset = evaluationSetSchema.parse({
    schema_version: 1,
    qa: [
      {
        id: "qa-1",
        question: "Which page contains the target statement?",
        expected_answer_gist: "The target statement is identified.",
        gold_doc: "target.pdf",
        gold_page: 2,
      },
    ],
    scenarios: [
      {
        id: "scenario-1",
        prompt: "Compare the indexed positions.",
        checklist: ["The output is grounded in indexed sources."],
      },
    ],
  });
  const retrieval = scoreRetrievalHit({
    goldDoc: evalset.qa[0].gold_doc,
    goldPage: evalset.qa[0].gold_page,
    candidates: [
      { document_id: "other", filename: "other.pdf", page_number: 1 },
      { document_id: "target", filename: "target.pdf", page_number: 2 },
    ],
    k: DEFAULT_TOP_K,
  });
  assert.equal(retrieval.hit, true);
  assert.equal(retrieval.rank, 2);

  const result = evaluationRunResultSchema.parse({
    schema_version: 1,
    run_id: "retrieval-self-test",
    model: "retrieval-only",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:01.000Z",
    top_k: DEFAULT_TOP_K,
    qa_results: [
      {
        id: evalset.qa[0].id,
        question: evalset.qa[0].question,
        expected_answer_gist: evalset.qa[0].expected_answer_gist,
        gold_doc: evalset.qa[0].gold_doc,
        gold_page: evalset.qa[0].gold_page,
        retrieval,
        answer_review: { status: "pending" },
        wall_time_ms: 1,
        emitted_citations: 0,
        valid_citations: 0,
      },
    ],
    scenario_results: [],
    notes: "Retrieval-only deterministic self-test.",
  });
  assert.deepEqual(summarizeRetrieval(result.qa_results), {
    total: 1,
    hits: 1,
    hit_rate: 1,
  });
  assert.match(
    renderEvaluationResultMarkdown(result),
    /1\/1 \(100\.0%\) hit@8/,
  );
  assert.equal(result.qa_results[0].answer_review.status, "pending");
  assert.deepEqual(result.scenario_results, []);
  console.info("perf-accuracy-eval deterministic self-test passed");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      options.topK !== DEFAULT_TOP_K
    ) {
      throw new Error("Evaluation options require the explicit --live guard");
    }
    runSelfTest();
    return;
  }
  await runLive(options);
}

void main().catch((error) => {
  closeDb();
  console.error(errorMessage(error));
  process.exitCode = 1;
});
