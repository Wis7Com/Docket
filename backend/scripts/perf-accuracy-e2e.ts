/**
 * Project-chat E2E evaluation runner.
 *
 * This calls the production runLLMStream/tool/citation path directly inside a
 * registered project database context. It does not create persistent chats.
 * Live inference and report writes require explicit flags.
 */
import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { closeDb, runWithDatabaseContext } from "../src/db/sqlite";
import {
  buildMessages,
  buildProjectDocContext,
  buildWorkflowStore,
  documentToolResultMaxCharsForModel,
  PROJECT_EXTRA_TOOLS,
  runLLMStream,
  type ChatMessage,
} from "../src/lib/chatTools";
import { measurePassageAnnotationByteOverhead } from "../src/lib/citationHandles";
import { citationLexicalSupport } from "../src/lib/citationRepair";
import { getProjectIndexCorpusStats } from "../src/lib/indexing/search";
import {
  assertRetrievalResultCoversEvaluationSet,
  evaluationRunResultSchema,
  evaluationSetSchema,
  renderEvaluationResultJson,
  renderEvaluationResultMarkdown,
  type EvaluationRunResult,
  type EvaluationSet,
} from "../src/lib/perfAccuracyEval";
import {
  aggregateRound3Runs,
  renderRound3AggregateMarkdown,
} from "../src/lib/perfAccuracyRuns";
import {
  getRegisteredProjectByPath,
  projectContextFor,
} from "../src/lib/projectRegistry";
import { createServerSupabase } from "../src/lib/supabase";
import {
  getUserApiKeys,
  getUserRetrievalSettings,
} from "../src/lib/userSettings";
import {
  buildProjectColorLegendPrompt,
  buildProjectSystemPromptExtra,
  PROJECT_ANNOTATION_TOOL_PROMPT,
} from "../src/routes/projectChat";

type Mode = "qa" | "scenarios" | "all";

type Options = {
  live: boolean;
  evalsetPath?: string;
  projectPath?: string;
  model?: string;
  outputDir?: string;
  retrievalResultPath?: string;
  appDataPath?: string;
  scenarioId?: string;
  scenarioIds?: string[];
  mode: Mode;
  maxIterations: number;
  runs: number;
};

type ToolBatch = {
  iteration: number;
  calls: {
    id: string;
    name: string;
    input: unknown;
  }[];
};

type ToolResultBatch = {
  iteration: number;
  results: {
    id: string;
    name: string;
    content_bytes: number;
    controlled_bytes_with_passage_annotations: number;
    controlled_bytes_without_passage_annotations: number;
    controlled_passage_annotation_byte_delta: number;
  }[];
  content_bytes: number;
  controlled_bytes_with_passage_annotations: number;
  controlled_bytes_without_passage_annotations: number;
  controlled_passage_annotation_byte_delta: number;
};

type ConversationCapture = {
  answer: string;
  raw_answer: string;
  wall_time_ms: number;
  emitted_citations: number;
  valid_citations: number;
  raw_numeric_marker_occurrences: number;
  raw_leaked_handle_tokens: number;
  final_numeric_marker_occurrences: number;
  final_resolved_marker_occurrences: number;
  final_unresolved_marker_occurrences: number;
  final_tier_a_marker_occurrences: number;
  final_tier_b_marker_occurrences: number;
  final_dead_marker_occurrences: number;
  final_leaked_handle_tokens: number;
  tier_a_support_failures: number;
  marker_occurrences_inside_quotes: number;
  repeated_ref_marker_occurrences: number;
  citations: unknown[];
  tool_batches: ToolBatch[];
  tool_result_batches: ToolResultBatch[];
  tool_output_bytes: number;
  controlled_tool_output_bytes_with_passage_annotations: number;
  controlled_tool_output_bytes_without_passage_annotations: number;
  controlled_passage_annotation_byte_delta: number;
  controlled_passage_annotation_percent_delta: number;
  tool_calls: number;
  sse_events: unknown[];
  error?: string;
};

const VALUE_OPTIONS = new Set([
  "--evalset",
  "--project-path",
  "--model",
  "--output-dir",
  "--retrieval-result",
  "--app-data-path",
  "--scenario-id",
  "--scenario-ids",
  "--mode",
  "--max-iterations",
  "--runs",
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
    if (!VALUE_OPTIONS.has(argument))
      throw new Error(`Unknown option: ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }

  const rawMode = values.get("--mode") ?? "all";
  if (rawMode !== "qa" && rawMode !== "scenarios" && rawMode !== "all") {
    throw new Error("--mode must be qa, scenarios, or all");
  }
  const maxIterations = Number(values.get("--max-iterations") ?? "10");
  if (
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > 24
  ) {
    throw new Error("--max-iterations must be an integer from 1 to 24");
  }
  const runs = Number(values.get("--runs") ?? "1");
  if (!Number.isInteger(runs) || runs < 1 || runs > 9) {
    throw new Error("--runs must be an integer from 1 to 9");
  }
  if (values.has("--scenario-id") && values.has("--scenario-ids")) {
    throw new Error("Use only one of --scenario-id and --scenario-ids");
  }
  const scenarioIds = values
    .get("--scenario-ids")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.has("--scenario-ids") && scenarioIds?.length === 0) {
    throw new Error("--scenario-ids requires a comma-separated scenario list");
  }
  return {
    live,
    evalsetPath: values.get("--evalset"),
    projectPath: values.get("--project-path"),
    model: values.get("--model"),
    outputDir: values.get("--output-dir"),
    retrievalResultPath: values.get("--retrieval-result"),
    appDataPath: values.get("--app-data-path"),
    scenarioId: values.get("--scenario-id"),
    scenarioIds,
    mode: rawMode,
    maxIterations,
    runs,
  };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(file), "utf8")) as unknown;
}

async function configureAppDataPath(optionValue?: string): Promise<void> {
  const configured = optionValue ?? process.env.APP_DATA_PATH;
  if (!configured)
    throw new Error("Live mode requires --app-data-path or APP_DATA_PATH");
  const resolved = path.resolve(configured);
  await access(path.join(resolved, "app.db"), fsConstants.R_OK);
  process.env.APP_DATA_PATH = resolved;
}

function projectToolsForCorpus(smallIndexedCorpus: boolean): unknown[] {
  if (!smallIndexedCorpus) return PROJECT_EXTRA_TOOLS;
  return PROJECT_EXTRA_TOOLS.filter((tool) => {
    if (typeof tool !== "object" || tool === null || !("function" in tool))
      return true;
    const name = (tool as { function?: { name?: string } }).function?.name;
    return name !== "search_project_documents" && name !== "read_index_chunk";
  });
}

function parseSseWrite(chunk: string): unknown[] {
  return chunk
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .flatMap((line) => {
      const payload = line.slice("data: ".length);
      if (payload === "[DONE]") return [];
      try {
        return [JSON.parse(payload) as unknown];
      } catch {
        return [];
      }
    });
}

function visibleAnswer(
  events: readonly { type: string; text?: string }[],
): string {
  return events
    .filter(
      (event) => event.type === "content" && typeof event.text === "string",
    )
    .map((event) => event.text ?? "")
    .join("")
    .trim();
}

function visibleCitationMarkerRefs(text: string): number[] {
  const visible = text.replace(
    /<CITATIONS>\s*[\s\S]*?\s*<\/CITATIONS>/gi,
    "",
  );
  return Array.from(
    visible.matchAll(/\[(\d+(?:,\s*\d+)*)\]/g),
  ).flatMap((match) =>
    match[1]
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter(Number.isFinite),
  );
}

function countLeakedHandleTokens(text: string): number {
  const visible = text.replace(
    /<CITATIONS>\s*[\s\S]*?\s*<\/CITATIONS>/gi,
    "",
  );
  return Array.from(visible.matchAll(/\[[^\]\n]*\bp\d[^\]\n]*\]/gi)).reduce(
    (count, bracket) =>
      count +
      Array.from(bracket[0].matchAll(/\bp\d+(?:-p[^\s,\]]+)?/gi)).length,
    0,
  );
}

function citationRefs(
  citations: readonly unknown[],
  support: "verified" | "unconfirmed" | "any",
): Set<number> {
  return new Set(
    citations.flatMap((citation) => {
      if (!citation || typeof citation !== "object") return [];
      const item = citation as { ref?: unknown; support?: unknown };
      if (
        support !== "any" &&
        (support === "unconfirmed"
          ? item.support !== "unconfirmed"
          : item.support === "unconfirmed")
      ) {
        return [];
      }
      const ref = item.ref;
      return typeof ref === "number" && Number.isSafeInteger(ref) ? [ref] : [];
    }),
  );
}

function countRepeatedMarkerRefs(refs: readonly number[]): number {
  const seen = new Set<number>();
  let repeated = 0;
  for (const ref of refs) {
    if (seen.has(ref)) repeated += 1;
    else seen.add(ref);
  }
  return repeated;
}

function countMarkersInsideQuotes(text: string): number {
  const spans = [
    ...text.matchAll(/“[^”\n]+”/g),
    ...text.matchAll(/‘[^’\n]+’/g),
    ...text.matchAll(/"[^"\n]+"/g),
    ...text.matchAll(/(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])/gu),
  ].flatMap((match) =>
    match.index === undefined
      ? []
      : [{ start: match.index, end: match.index + match[0].length }],
  );
  return Array.from(text.matchAll(/\[(\d+(?:,\s*\d+)*)\]/g)).filter(
    (marker) =>
      marker.index !== undefined &&
      spans.some(
        (span) =>
          span.start < (marker.index as number) &&
          (marker.index as number) < span.end,
      ),
  ).length;
}

function countTierASupportFailures(
  text: string,
  citations: readonly unknown[],
): number {
  const citationByRef = new Map<number, { quote: string }>();
  for (const raw of citations) {
    if (!raw || typeof raw !== "object") continue;
    const citation = raw as {
      ref?: unknown;
      quote?: unknown;
      support?: unknown;
    };
    if (
      typeof citation.ref === "number" &&
      typeof citation.quote === "string" &&
      citation.support !== "unconfirmed"
    ) {
      citationByRef.set(citation.ref, { quote: citation.quote });
    }
  }
  let failures = 0;
  for (const marker of text.matchAll(/\[(\d+(?:,\s*\d+)*)\]/g)) {
    if (marker.index === undefined) continue;
    const context = text
      .slice(Math.max(0, marker.index - 200), marker.index)
      .replace(/\[(?:\d+(?:,\s*\d+)*)\]/g, " ");
    for (const rawRef of marker[1].split(",")) {
      const citation = citationByRef.get(
        Number.parseInt(rawRef.trim(), 10),
      );
      if (!citation) continue;
      const support = citationLexicalSupport(context, citation.quote);
      if (
        !support.nearVerbatim &&
        (support.sharedWords < 2 || support.score < 0.3)
      ) {
        failures += 1;
      }
    }
  }
  return failures;
}

function parsedToolPayload(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

async function writeExclusive(file: string, content: string): Promise<void> {
  await writeFile(file, content, { encoding: "utf8", flag: "wx" });
}

async function runLiveOnce(
  options: Options,
  runNumber: number,
): Promise<EvaluationRunResult> {
  if (
    !options.evalsetPath ||
    !options.projectPath ||
    !options.model ||
    !options.outputDir
  ) {
    throw new Error(
      "Live mode requires --evalset, --project-path, --model, and --output-dir",
    );
  }
  if (
    (options.mode === "qa" || options.mode === "all") &&
    !options.retrievalResultPath
  ) {
    throw new Error("QA mode requires --retrieval-result");
  }
  const model = options.model;
  const evalset = evaluationSetSchema.parse(
    await readJson(options.evalsetPath),
  );
  const retrievalRun = options.retrievalResultPath
    ? evaluationRunResultSchema.parse(
        await readJson(options.retrievalResultPath),
      )
    : null;
  if (retrievalRun && (options.mode === "qa" || options.mode === "all")) {
    assertRetrievalResultCoversEvaluationSet(evalset, retrievalRun);
  }
  const retrievalById = new Map(
    retrievalRun?.qa_results.map(
      (item) => [item.id, item.retrieval] as const,
    ) ?? [],
  );
  const project = getRegisteredProjectByPath(options.projectPath);
  if (!project?.user_id)
    throw new Error("Project is not registered with a user");
  const context = projectContextFor(project);
  const startedAt = new Date();
  const transcriptRuns: Record<string, ConversationCapture> = {};

  const result = await runWithDatabaseContext(context, async () => {
    const db = createServerSupabase();
    const projectDocs = await buildProjectDocContext(
      project.id,
      project.user_id,
      db,
    );
    const retrievalSettings = await getUserRetrievalSettings(
      project.user_id,
      db,
    );
    const stats = getProjectIndexCorpusStats(project.id);
    const documentResultMaxChars = documentToolResultMaxCharsForModel(
      model,
      retrievalSettings.chat_fetch_max_text_bytes,
    );
    const fullReadMaxTextBytes = documentToolResultMaxCharsForModel(
      model,
      retrievalSettings.chat_full_read_max_text_bytes,
    );
    const smallIndexedCorpus =
      stats.total_documents > 0 &&
      stats.ready_documents === stats.total_documents &&
      stats.total_documents <= retrievalSettings.chat_full_read_max_docs &&
      stats.text_bytes <=
        (fullReadMaxTextBytes ??
          retrievalSettings.chat_full_read_max_text_bytes);
    const docAvailability = Object.entries(projectDocs.docIndex).map(
      ([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        folder_path: projectDocs.folderPaths.get(doc_id),
        doc_role: info.doc_role,
        party_role: info.party_role,
        party_side: info.party_side,
        brief_sequence: info.brief_sequence,
      }),
    );
    let systemPromptSuffix = "";
    if (smallIndexedCorpus) {
      systemPromptSuffix += `\n\nSMALL PROJECT CORPUS:\nThis project is small enough to preserve full-context behavior (${stats.total_documents} documents, ${stats.text_bytes} indexed bytes; current budget ${retrievalSettings.chat_full_read_max_docs} documents / ${fullReadMaxTextBytes ?? retrievalSettings.chat_full_read_max_text_bytes} bytes). Prefer list_documents plus read_document/fetch_documents directly instead of search_project_documents. For comparison requests, read each document fully and build the issue table from the full text.`;
    } else {
      systemPromptSuffix += `\n\nPROJECT RETRIEVAL BUDGETS:\nUse search_project_documents for broad questions, read_index_chunk with neighbors for context, and only full-read selected documents when there are at most ${retrievalSettings.chat_fetch_max_docs} selected documents and about ${documentResultMaxChars ?? retrievalSettings.chat_fetch_max_text_bytes} bytes of text. If search reports unindexed documents, use find_in_document for a targeted cold fallback; read_document results above the current budget are rejected.`;
    }
    const legend = await buildProjectColorLegendPrompt({
      db,
      projectId: project.id,
    });
    if (legend) systemPromptSuffix += `\n\n${legend}`;
    systemPromptSuffix += `\n\n${PROJECT_ANNOTATION_TOOL_PROMPT}`;
    const workflowStore = await buildWorkflowStore(
      project.user_id,
      undefined,
      db,
    );
    const apiKeys = await getUserApiKeys(project.user_id, db);

    const runConversation = async (
      id: string,
      prompt: string,
    ): Promise<ConversationCapture> => {
      const messages: ChatMessage[] = [{ role: "user", content: prompt }];
      const systemPromptExtra = `${buildProjectSystemPromptExtra(messages)}${systemPromptSuffix}`;
      const apiMessages = buildMessages(
        messages,
        docAvailability,
        systemPromptExtra,
        projectDocs.docIndex,
      );
      const sseEvents: unknown[] = [];
      const toolBatches: ToolBatch[] = [];
      const toolResultBatches: ToolResultBatch[] = [];
      const started = performance.now();
      const originalLog = console.log;
      console.log = (message?: unknown, ...args: unknown[]) => {
        if (
          typeof message === "string" &&
          message.startsWith("[runLLMStream] system prompt:")
        ) {
          return;
        }
        originalLog(message, ...args);
      };
      try {
        const stream = await runLLMStream({
          apiMessages,
          docStore: projectDocs.docStore,
          docIndex: projectDocs.docIndex,
          userId: project.user_id,
          db,
          write: (chunk) => sseEvents.push(...parseSseWrite(chunk)),
          extraTools: projectToolsForCorpus(smallIndexedCorpus),
          workflowStore,
          model,
          apiKeys,
          projectId: project.id,
          documentResultMaxChars,
          maxIterations: options.maxIterations,
          onToolBatch: (batch) => {
            toolBatches.push({
              iteration: batch.iteration,
              calls: batch.calls.map((call) => ({ ...call })),
            });
          },
          onToolResults: (batch) => {
            const results = batch.results.map((result) => {
              const controlled = measurePassageAnnotationByteOverhead(
                parsedToolPayload(result.content),
              );
              return {
                id: result.id,
                name: result.name,
                content_bytes: Buffer.byteLength(result.content, "utf8"),
                controlled_bytes_with_passage_annotations:
                  controlled.serializedBytesWithAnnotations,
                controlled_bytes_without_passage_annotations:
                  controlled.serializedBytesWithoutAnnotations,
                controlled_passage_annotation_byte_delta: controlled.byteDelta,
              };
            });
            toolResultBatches.push({
              iteration: batch.iteration,
              results,
              content_bytes: results.reduce(
                (total, result) => total + result.content_bytes,
                0,
              ),
              controlled_bytes_with_passage_annotations: results.reduce(
                (total, result) =>
                  total + result.controlled_bytes_with_passage_annotations,
                0,
              ),
              controlled_bytes_without_passage_annotations: results.reduce(
                (total, result) =>
                  total + result.controlled_bytes_without_passage_annotations,
                0,
              ),
              controlled_passage_annotation_byte_delta: results.reduce(
                (total, result) =>
                  total + result.controlled_passage_annotation_byte_delta,
                0,
              ),
            });
          },
        });
        const citations = stream.citations as unknown[];
        const answer = visibleAnswer(
          stream.events as { type: string; text?: string }[],
        );
        const rawMarkerRefs = visibleCitationMarkerRefs(stream.fullText);
        const finalMarkerRefs = visibleCitationMarkerRefs(answer);
        const resolvedRefs = citationRefs(citations, "any");
        const tierARefs = citationRefs(citations, "verified");
        const tierBRefs = citationRefs(citations, "unconfirmed");
        const resolvedFinalMarkers = finalMarkerRefs.filter((ref) =>
          resolvedRefs.has(ref),
        ).length;
        const tierAFinalMarkers = finalMarkerRefs.filter((ref) =>
          tierARefs.has(ref),
        ).length;
        const tierBFinalMarkers = finalMarkerRefs.filter((ref) =>
          tierBRefs.has(ref),
        ).length;
        const emitted = Math.max(finalMarkerRefs.length, citations.length);
        const toolOutputBytes = toolResultBatches.reduce(
          (total, batch) => total + batch.content_bytes,
          0,
        );
        const controlledToolOutputBytesWithoutPassageAnnotations =
          toolResultBatches.reduce(
            (total, batch) =>
              total + batch.controlled_bytes_without_passage_annotations,
            0,
          );
        const controlledToolOutputBytesWithPassageAnnotations =
          toolResultBatches.reduce(
            (total, batch) =>
              total + batch.controlled_bytes_with_passage_annotations,
            0,
          );
        const controlledPassageAnnotationByteDelta = toolResultBatches.reduce(
          (total, batch) =>
            total + batch.controlled_passage_annotation_byte_delta,
          0,
        );
        const capture: ConversationCapture = {
          answer,
          raw_answer: stream.fullText,
          wall_time_ms: performance.now() - started,
          emitted_citations: emitted,
          valid_citations: citations.length,
          raw_numeric_marker_occurrences: rawMarkerRefs.length,
          raw_leaked_handle_tokens: countLeakedHandleTokens(stream.fullText),
          final_numeric_marker_occurrences: finalMarkerRefs.length,
          final_resolved_marker_occurrences: resolvedFinalMarkers,
          final_unresolved_marker_occurrences:
            finalMarkerRefs.length - resolvedFinalMarkers,
          final_tier_a_marker_occurrences: tierAFinalMarkers,
          final_tier_b_marker_occurrences: tierBFinalMarkers,
          final_dead_marker_occurrences:
            finalMarkerRefs.length - tierAFinalMarkers - tierBFinalMarkers,
          final_leaked_handle_tokens: countLeakedHandleTokens(answer),
          tier_a_support_failures: countTierASupportFailures(answer, citations),
          marker_occurrences_inside_quotes: countMarkersInsideQuotes(answer),
          repeated_ref_marker_occurrences:
            countRepeatedMarkerRefs(finalMarkerRefs),
          citations,
          tool_batches: toolBatches,
          tool_result_batches: toolResultBatches,
          tool_output_bytes: toolOutputBytes,
          controlled_tool_output_bytes_with_passage_annotations:
            controlledToolOutputBytesWithPassageAnnotations,
          controlled_tool_output_bytes_without_passage_annotations:
            controlledToolOutputBytesWithoutPassageAnnotations,
          controlled_passage_annotation_byte_delta:
            controlledPassageAnnotationByteDelta,
          controlled_passage_annotation_percent_delta:
            controlledToolOutputBytesWithoutPassageAnnotations > 0
              ? (controlledPassageAnnotationByteDelta /
                  controlledToolOutputBytesWithoutPassageAnnotations) *
                100
              : 0,
          tool_calls: toolBatches.reduce(
            (sum, batch) => sum + batch.calls.length,
            0,
          ),
          sse_events: sseEvents,
        };
        transcriptRuns[id] = capture;
        return capture;
      } catch (error) {
        const controlledBytesWithoutPassageAnnotations =
          toolResultBatches.reduce(
            (total, batch) =>
              total + batch.controlled_bytes_without_passage_annotations,
            0,
          );
        const controlledBytesWithPassageAnnotations = toolResultBatches.reduce(
          (total, batch) =>
            total + batch.controlled_bytes_with_passage_annotations,
          0,
        );
        const controlledPassageAnnotationByteDelta = toolResultBatches.reduce(
          (total, batch) =>
            total + batch.controlled_passage_annotation_byte_delta,
          0,
        );
        const capture: ConversationCapture = {
          answer: "",
          raw_answer: "",
          wall_time_ms: performance.now() - started,
          emitted_citations: 0,
          valid_citations: 0,
          raw_numeric_marker_occurrences: 0,
          raw_leaked_handle_tokens: 0,
          final_numeric_marker_occurrences: 0,
          final_resolved_marker_occurrences: 0,
          final_unresolved_marker_occurrences: 0,
          final_tier_a_marker_occurrences: 0,
          final_tier_b_marker_occurrences: 0,
          final_dead_marker_occurrences: 0,
          final_leaked_handle_tokens: 0,
          tier_a_support_failures: 0,
          marker_occurrences_inside_quotes: 0,
          repeated_ref_marker_occurrences: 0,
          citations: [],
          tool_batches: toolBatches,
          tool_result_batches: toolResultBatches,
          tool_output_bytes: toolResultBatches.reduce(
            (total, batch) => total + batch.content_bytes,
            0,
          ),
          controlled_tool_output_bytes_with_passage_annotations:
            controlledBytesWithPassageAnnotations,
          controlled_tool_output_bytes_without_passage_annotations:
            controlledBytesWithoutPassageAnnotations,
          controlled_passage_annotation_byte_delta:
            controlledPassageAnnotationByteDelta,
          controlled_passage_annotation_percent_delta:
            controlledBytesWithoutPassageAnnotations > 0
              ? (controlledPassageAnnotationByteDelta /
                  controlledBytesWithoutPassageAnnotations) *
                100
              : 0,
          tool_calls: toolBatches.reduce(
            (sum, batch) => sum + batch.calls.length,
            0,
          ),
          sse_events: sseEvents,
          error: error instanceof Error ? error.message : String(error),
        };
        transcriptRuns[id] = capture;
        return capture;
      } finally {
        console.log = originalLog;
      }
    };

    const qaResults: EvaluationRunResult["qa_results"] = [];
    if (options.mode === "qa" || options.mode === "all") {
      for (const [index, qa] of evalset.qa.entries()) {
        const id = qa.id ?? `qa-${index + 1}`;
        console.info(`[e2e] ${model} ${id}`);
        const capture = await runConversation(id, qa.question);
        qaResults.push({
          id,
          question: qa.question,
          expected_answer_gist: qa.expected_answer_gist,
          gold_doc: qa.gold_doc,
          gold_page: qa.gold_page,
          retrieval:
            retrievalById.get(id) ??
            missingRetrievalHit(retrievalRun?.top_k ?? 8),
          answer: capture.answer || undefined,
          answer_review: { status: "pending" },
          wall_time_ms: capture.wall_time_ms,
          emitted_citations: capture.emitted_citations,
          valid_citations: capture.valid_citations,
          error: capture.error,
        });
      }
    }

    const requestedScenarioIds = options.scenarioId
      ? [options.scenarioId]
      : options.scenarioIds;
    const scenarios = requestedScenarioIds
      ? evalset.scenarios.filter((scenario) =>
          requestedScenarioIds.includes(scenario.id),
        )
      : evalset.scenarios;
    if (requestedScenarioIds) {
      const found = new Set(scenarios.map((scenario) => scenario.id));
      const unknown = requestedScenarioIds.filter((id) => !found.has(id));
      if (unknown.length > 0) {
        throw new Error(`Unknown scenario id: ${unknown.join(", ")}`);
      }
    }
    const scenarioResults: EvaluationRunResult["scenario_results"] = [];
    if (options.mode === "scenarios" || options.mode === "all") {
      for (const scenario of scenarios) {
        console.info(`[e2e] ${model} ${scenario.id}`);
        const capture = await runConversation(scenario.id, scenario.prompt);
        scenarioResults.push({
          id: scenario.id,
          title: scenario.title,
          prompt: scenario.prompt,
          tool_chain_status: capture.error ? "incomplete" : "completed",
          tool_iterations: capture.tool_batches.length,
          tool_calls: capture.tool_calls,
          checklist: scenario.checklist.map((criterion, index) => ({
            id: `criterion-${index + 1}`,
            criterion,
            status: "pending",
          })),
          human_review: { status: "pending" },
          wall_time_ms: capture.wall_time_ms,
          emitted_citations: capture.emitted_citations,
          valid_citations: capture.valid_citations,
          failure_mode: capture.error ? "runtime_error" : null,
          error: capture.error,
        });
      }
    }

    return evaluationRunResultSchema.parse({
      schema_version: 1,
      run_id: `e2e-${safeStem(model)}-${startedAt.toISOString().replace(/[-:.]/g, "")}`,
      evalset_name: evalset.name,
      model,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      top_k: retrievalRun?.top_k ?? 8,
      qa_results: qaResults,
      scenario_results: scenarioResults,
      notes: `Direct production project-chat E2E; mode=${options.mode}; run=${runNumber}/${options.runs}; persistent chats disabled.${retrievalRun ? ` retrieval_run=${retrievalRun.run_id}.` : ""}`,
    });
  });

  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const stem = `perf-accuracy-${result.run_id}`;
  await Promise.all([
    writeExclusive(
      path.join(outputDir, `${stem}.json`),
      renderEvaluationResultJson(result),
    ),
    writeExclusive(
      path.join(outputDir, `${stem}.md`),
      renderEvaluationResultMarkdown(result),
    ),
    writeExclusive(
      path.join(outputDir, `${stem}-transcript.json`),
      `${JSON.stringify(
        {
          schema_version: 3,
          run_id: result.run_id,
          model: result.model,
          citation_handles:
            process.env.DOCKET_CITATION_HANDLES?.trim() === "0"
              ? "disabled"
              : "enabled",
          runs: transcriptRuns,
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  console.info(`Wrote ${path.join(outputDir, `${stem}.json`)}`);
  return result;
}

async function mainLive(options: Options): Promise<void> {
  await configureAppDataPath(options.appDataPath);
  const results: EvaluationRunResult[] = [];
  for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
    console.info(`[e2e] starting run ${runNumber}/${options.runs}`);
    results.push(await runLiveOnce(options, runNumber));
  }
  if (results.length === 1 || !options.outputDir) return;

  const aggregate = aggregateRound3Runs(results);
  const outputDir = path.resolve(options.outputDir);
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const stem = `perf-accuracy-round3-median-${safeStem(aggregate.model)}-${stamp}`;
  await Promise.all([
    writeExclusive(
      path.join(outputDir, `${stem}.json`),
      `${JSON.stringify(aggregate, null, 2)}\n`,
    ),
    writeExclusive(
      path.join(outputDir, `${stem}.md`),
      renderRound3AggregateMarkdown(aggregate),
    ),
  ]);
  console.info(`Wrote ${path.join(outputDir, `${stem}.json`)}`);
}

function safeStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function selfTest(): void {
  assert.deepEqual(
    parseSseWrite('data: {"type":"tool_call_start","name":"x"}\n\n'),
    [{ type: "tool_call_start", name: "x" }],
  );
  assert.deepEqual(parseSseWrite("data: [DONE]\n\n"), []);
  assert.deepEqual(visibleCitationMarkerRefs("Alpha [1]. Both [2, 3]."), [
    1, 2, 3,
  ]);
  assert.equal(countLeakedHandleTokens("Both [p8, p24] and [p51-p5ern]."), 3);
  assert.equal(
    countRepeatedMarkerRefs(
      visibleCitationMarkerRefs("A [1]. B [2, 3]. C [2]."),
    ),
    1,
  );
  assert.equal(countMarkersInsideQuotes('Outside [1]. "Inside [2]."'), 1);
  assert.equal(
    countMarkersInsideQuotes(
      "NCBCP's response [1]. Defendant's reply [2].",
    ),
    0,
  );
  assert.equal(
    visibleAnswer([{ type: "content", text: " answer " }]),
    "answer",
  );
  const controlledMeasurement = measurePassageAnnotationByteOverhead(
    parsedToolPayload(
      JSON.stringify({
        indexed_quote: "[p1] Exact source text.",
        citation_passage: "p1",
      }),
    ),
  );
  assert.equal(
    controlledMeasurement.serializedBytesWithoutAnnotations,
    Buffer.byteLength(JSON.stringify({ indexed_quote: "Exact source text." })),
  );
  assert.ok(controlledMeasurement.byteDelta > 0);
  assert.equal(parseCli([]).runs, 1);
  assert.equal(parseCli(["--runs", "3"]).runs, 3);
  assert.deepEqual(
    parseCli(["--scenario-ids", "as-1, as-3,as-3b"]).scenarioIds,
    ["as-1", "as-3", "as-3b"],
  );
  assert.throws(() =>
    parseCli(["--scenario-id", "as-1", "--scenario-ids", "as-3"]),
  );
  assert.throws(() => parseCli(["--runs", "0"]));
  console.info("perf-accuracy-e2e deterministic self-test passed");
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (!options.live) {
    if (process.argv.length > 2)
      throw new Error("Evaluation options require --live");
    selfTest();
    return;
  }
  await mainLive(options);
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
