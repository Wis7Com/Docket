/**
 * Offline Qwen citation-repair mapper experiment.
 *
 * The WP-G2 transcripts retain answers and exact tool-call batches, but not
 * tool-result bodies. Live mode replays those recorded batches against the
 * registered evaluation project, rebuilds the deterministic quote menu, and
 * compares Qwen with thinking disabled and enabled. No product state is
 * mutated and output writes require --live.
 */
import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { closeDb, runWithDatabaseContext } from "../src/db/sqlite";
import {
  buildProjectDocContext,
  documentToolResultMaxCharsForModel,
  runToolCalls,
  validateCitationContract,
  validateCitationEvidence,
  type ToolCall,
} from "../src/lib/chatTools";
import {
  applyCitationRepairPlan,
  buildCitationRepairRequest,
  buildQuoteCandidateMenu,
  parseCitationRepairResponse,
  type CitationRepairEvidence,
} from "../src/lib/citationRepair";
import { completeText } from "../src/lib/llm";
import {
  getRegisteredProjectByPath,
  projectContextFor,
} from "../src/lib/projectRegistry";
import { createServerSupabase } from "../src/lib/supabase";
import {
  getUserApiKeys,
  getUserRetrievalSettings,
} from "../src/lib/userSettings";

type Options = {
  live: boolean;
  reviewPath?: string;
  projectPath?: string;
  outputDir?: string;
  appDataPath?: string;
  model: string;
};

type RecordedToolCall = {
  id: string;
  name: string;
  input: unknown;
};

type RecordedToolBatch = {
  iteration: number;
  calls: RecordedToolCall[];
};

type TranscriptCapture = {
  answer: string;
  tool_batches: RecordedToolBatch[];
};

type CaseSource = {
  id: string;
  resultFile: string;
  transcriptFile: string;
};

type ModeResult = {
  think: "off" | "on";
  wall_time_ms: number;
  raw_response: string;
  mappings_proposed: number;
  mappings_anchor_accepted: number;
  mappings_accepted: number;
  mappings_ambiguous: number;
  contract_errors: unknown[];
  evidence_errors: unknown[];
  repaired_text: string | null;
};

const CASE_IDS = ["qa-01", "qa-10", "qa-14", "as-1", "as-3"] as const;
const VALUE_OPTIONS = new Set([
  "--review",
  "--project-path",
  "--output-dir",
  "--app-data-path",
  "--model",
]);

function parseCli(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  let live = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--live") {
      if (live) throw new Error("Duplicate option: --live");
      live = true;
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
  return {
    live,
    reviewPath: values.get("--review"),
    projectPath: values.get("--project-path"),
    outputDir: values.get("--output-dir"),
    appDataPath: values.get("--app-data-path"),
    model: values.get("--model") ?? "ollama:qwen3.5:35b",
  };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(file), "utf8")) as unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function resolveReviewSources(reviewValue: unknown, reviewPath: string): CaseSource[] {
  const review = record(reviewValue, "review");
  const resultsDir = path.dirname(path.resolve(reviewPath));
  const qa = record(review.qa, "review.qa");
  const qaResult = text(qa.result_file, "review.qa.result_file");
  const qaTranscript = text(
    qa.transcript_file,
    "review.qa.transcript_file",
  );
  const scenarios = review.scenarios;
  if (!Array.isArray(scenarios)) throw new Error("review.scenarios must be an array");
  const scenarioSource = (id: string): CaseSource => {
    const item = scenarios.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).id === id,
    );
    const row = record(item, `review.scenarios.${id}`);
    return {
      id,
      resultFile: path.join(
        resultsDir,
        text(row.result_file, `${id}.result_file`),
      ),
      transcriptFile: path.join(
        resultsDir,
        text(row.transcript_file, `${id}.transcript_file`),
      ),
    };
  };
  return [
    ...CASE_IDS.slice(0, 3).map((id) => ({
      id,
      resultFile: path.join(resultsDir, qaResult),
      transcriptFile: path.join(resultsDir, qaTranscript),
    })),
    scenarioSource("as-1"),
    scenarioSource("as-3"),
  ];
}

function parseTranscriptCapture(value: unknown, id: string): TranscriptCapture {
  const transcript = record(value, `${id} transcript`);
  const runs = record(transcript.runs, `${id} transcript.runs`);
  const capture = record(runs[id], `${id} transcript run`);
  const batches = capture.tool_batches;
  if (!Array.isArray(batches)) throw new Error(`${id} tool_batches must be an array`);
  return {
    answer: text(capture.answer, `${id}.answer`),
    tool_batches: batches.map((batchValue, batchIndex) => {
      const batch = record(batchValue, `${id}.tool_batches[${batchIndex}]`);
      if (!Array.isArray(batch.calls)) {
        throw new Error(`${id}.tool_batches[${batchIndex}].calls must be an array`);
      }
      return {
        iteration:
          typeof batch.iteration === "number" ? batch.iteration : batchIndex + 1,
        calls: batch.calls.map((callValue, callIndex) => {
          const call = record(
            callValue,
            `${id}.tool_batches[${batchIndex}].calls[${callIndex}]`,
          );
          return {
            id: text(call.id, `${id}.call.id`),
            name: text(call.name, `${id}.call.name`),
            input: call.input ?? {},
          };
        }),
      };
    }),
  };
}

function resultContainsCase(value: unknown, id: string): boolean {
  const result = record(value, `${id} result`);
  for (const key of ["qa_results", "scenario_results"]) {
    const rows = result[key];
    if (
      Array.isArray(rows) &&
      rows.some(
        (row) =>
          row &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          (row as Record<string, unknown>).id === id,
      )
    ) {
      return true;
    }
  }
  return false;
}

function toolCalls(batch: RecordedToolBatch): ToolCall[] {
  return batch.calls.map((call) => ({
    id: call.id,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.input ?? {}),
    },
  }));
}

function docIdFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).doc_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function configureAppDataPath(optionValue?: string): Promise<void> {
  const configured = optionValue ?? process.env.APP_DATA_PATH;
  if (!configured) {
    throw new Error("Live mode requires --app-data-path or APP_DATA_PATH");
  }
  const resolved = path.resolve(configured);
  await access(path.join(resolved, "app.db"), fsConstants.R_OK);
  process.env.APP_DATA_PATH = resolved;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

async function writeExclusive(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function mainLive(options: Options): Promise<void> {
  if (!options.reviewPath || !options.projectPath || !options.outputDir) {
    throw new Error(
      "Live mode requires --review, --project-path, and --output-dir",
    );
  }
  await configureAppDataPath(options.appDataPath);
  const reviewPath = path.resolve(options.reviewPath);
  const sources = resolveReviewSources(await readJson(reviewPath), reviewPath);
  for (const source of sources) {
    await access(source.resultFile, fsConstants.R_OK);
    await access(source.transcriptFile, fsConstants.R_OK);
  }
  const project = getRegisteredProjectByPath(path.resolve(options.projectPath));
  if (!project) throw new Error("Project path is not registered");

  const output = await runWithDatabaseContext(
    projectContextFor(project),
    async () => {
      const db = createServerSupabase();
      const docs = await buildProjectDocContext(project.id, project.user_id, db);
      const settings = await getUserRetrievalSettings(project.user_id, db);
      const apiKeys = await getUserApiKeys(project.user_id, db);
      const documentResultMaxChars = documentToolResultMaxCharsForModel(
        options.model,
        settings.chat_fetch_max_text_bytes,
      );
      const caseResults: unknown[] = [];

      for (const source of sources) {
        const [resultValue, transcriptValue] = await Promise.all([
          readJson(source.resultFile),
          readJson(source.transcriptFile),
        ]);
        if (!resultContainsCase(resultValue, source.id)) {
          throw new Error(`${source.id} is absent from its result file`);
        }
        const capture = parseTranscriptCapture(transcriptValue, source.id);
        const evidence: CitationRepairEvidence[] = [];
        for (const batch of capture.tool_batches) {
          const replay = await runToolCalls(
            toolCalls(batch),
            docs.docStore,
            project.user_id,
            db,
            () => undefined,
            undefined,
            undefined,
            docs.docIndex,
            undefined,
            project.id,
            undefined,
            documentResultMaxChars,
          );
          const resultRows = replay.toolResults as Array<{
            tool_call_id?: unknown;
            content?: unknown;
          }>;
          for (const call of batch.calls) {
            const row = resultRows.find(
              (candidate) => candidate.tool_call_id === call.id,
            );
            evidence.push({
              toolName: call.name,
              content: String(row?.content ?? ""),
              ...(docIdFromInput(call.input)
                ? { docId: docIdFromInput(call.input) }
                : {}),
            });
          }
        }
        const candidates = buildQuoteCandidateMenu(evidence);
        const request = buildCitationRepairRequest({
          answerText: capture.answer,
          evidence,
          candidates,
        });
        const modes: ModeResult[] = [];
        for (const think of [false, true] as const) {
          console.info(
            `[citation-repair-qwen] ${source.id} think=${think ? "on" : "off"} candidates=${candidates.length}`,
          );
          const started = performance.now();
          const rawResponse = await completeText({
            model: options.model,
            systemPrompt: request.systemPrompt,
            user: request.userPrompt,
            maxTokens: 4_096,
            think,
            apiKeys,
          });
          const wallTimeMs = performance.now() - started;
          const plan = parseCitationRepairResponse(rawResponse, candidates);
          const assembled = plan
            ? applyCitationRepairPlan(capture.answer, plan, candidates)
            : null;
          const contract = assembled?.text
            ? validateCitationContract(
                assembled.text,
                assembled.citations,
                docs.docIndex,
              )
            : { citations: [], errors: [] };
          const verified = validateCitationEvidence(
            contract.citations,
            docs.docIndex,
          );
          modes.push({
            think: think ? "on" : "off",
            wall_time_ms: wallTimeMs,
            raw_response: rawResponse,
            mappings_proposed: plan?.mappings.length ?? 0,
            mappings_anchor_accepted:
              assembled?.diagnostics.mappingsAccepted ?? 0,
            mappings_accepted: verified.citations.length,
            mappings_ambiguous:
              assembled?.diagnostics.mappingsAmbiguous ?? 0,
            contract_errors: contract.errors,
            evidence_errors: verified.errors,
            repaired_text:
              verified.citations.length > 0 ? (assembled?.text ?? null) : null,
          });
          console.info(
            `[citation-repair-qwen] ${source.id} think=${think ? "on" : "off"} proposed=${plan?.mappings.length ?? 0} accepted=${verified.citations.length} wall_ms=${Math.round(wallTimeMs)}`,
          );
        }
        caseResults.push({
          id: source.id,
          source_result_file: path.basename(source.resultFile),
          source_transcript_file: path.basename(source.transcriptFile),
          answer: capture.answer,
          tool_batches: capture.tool_batches,
          evidence,
          quote_candidate_menu: candidates,
          modes,
        });
      }

      const modeSummary = (["off", "on"] as const).map((think) => {
        const rows = caseResults as Array<{
          modes: ModeResult[];
        }>;
        const modeRows = rows.map(
          (row) => row.modes.find((mode) => mode.think === think)!,
        );
        return {
          think,
          cases_with_accepted_mapping: modeRows.filter(
            (row) => row.mappings_accepted >= 1,
          ).length,
          total_mappings_proposed: modeRows.reduce(
            (sum, row) => sum + row.mappings_proposed,
            0,
          ),
          total_mappings_accepted: modeRows.reduce(
            (sum, row) => sum + row.mappings_accepted,
            0,
          ),
          total_wall_time_ms: modeRows.reduce(
            (sum, row) => sum + row.wall_time_ms,
            0,
          ),
        };
      });
      const qualifiedModes = modeSummary.filter(
        (mode) => mode.cases_with_accepted_mapping >= 3,
      );
      return {
        schema_version: 1,
        experiment: "round-3-r1-qwen-citation-repair-mapper",
        started_from_review: path.basename(reviewPath),
        model: options.model,
        evidence_reconstruction:
          "replayed_exact_tool_batches_against_current_evaluation_db",
        evidence_reconstruction_note:
          "WP-G2 transcripts retain answers and exact tool inputs but not tool-result bodies; results were replayed read-only in the registered evaluation project context before deterministic candidate-menu construction.",
        acceptance_rule:
          "A mode qualifies when at least 3 of 5 cases have mappings_accepted >= 1 after unique exact-anchor assembly and server citation-contract plus source-evidence validation.",
        case_results: caseResults,
        mode_summary: modeSummary,
        decision: {
          status: qualifiedModes.length > 0 ? "pass" : "fail",
          qualified_modes: qualifiedModes.map((mode) => mode.think),
          product_reactivation_required: qualifiedModes.length > 0,
        },
      };
    },
  );

  const finalOutput = {
    ...output,
    completed_at: new Date().toISOString(),
  };
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const outputFile = path.join(
    outputDir,
    `citation-repair-qwen-offline-${timestamp()}.json`,
  );
  await writeExclusive(outputFile, finalOutput);
  console.info(`[citation-repair-qwen] wrote ${outputFile}`);
  console.info(
    `[citation-repair-qwen] decision=${finalOutput.decision.status} ${JSON.stringify(finalOutput.mode_summary)}`,
  );
}

async function selfTest(): Promise<void> {
  assert.deepEqual(parseCli([]), {
    live: false,
    reviewPath: undefined,
    projectPath: undefined,
    outputDir: undefined,
    appDataPath: undefined,
    model: "ollama:qwen3.5:35b",
  });
  assert.throws(() => parseCli(["--live", "--live"]), /Duplicate/);
  assert.throws(() => parseCli(["--unknown"]), /Unknown option/);
  assert.equal(
    resultContainsCase({ qa_results: [{ id: "qa-01" }] }, "qa-01"),
    true,
  );
  assert.equal(
    parseTranscriptCapture(
      {
        runs: {
          "qa-01": {
            answer: "answer",
            tool_batches: [
              {
                iteration: 1,
                calls: [{ id: "call-1", name: "search", input: {} }],
              },
            ],
          },
        },
      },
      "qa-01",
    ).tool_batches[0].calls[0].name,
    "search",
  );
  console.info("citation-repair-qwen-offline self-test passed");
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  try {
    if (options.live) await mainLive(options);
    else await selfTest();
  } finally {
    closeDb();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
