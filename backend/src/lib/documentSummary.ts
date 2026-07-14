import { createHash } from "node:crypto";
import { z } from "zod";
import { completeText, type UserApiKeys } from "./llm";
import {
  resolveOllamaCharsPerToken,
  resolveOllamaContextWindow,
} from "./llm/ollama";

const DEFAULT_BATCH_CHARACTERS = 52_000;
const DEFAULT_BATCH_PAGES = 32;
const LOCAL_REFERENCE_BATCH_CHARACTERS = 26_000;
const LOCAL_REFERENCE_BATCH_PAGES = 16;
// Dense legal batches hit a 1536-token map output cap on gemma4:12b (measured
// done_reason=length), which forced a retry + half-split (correct but ~2-3x
// slower for those batches). 2560 lets most batches emit complete evidence JSON
// in one pass; the half-split remains as a safety net past that. This also
// reserves the map output budget when deriving context-bound batch sizes.
const LOCAL_MAP_MAX_TOKENS = 2_560;
const LOCAL_CONTEXT_SAFETY_OVERHEAD = 768;
// A whole-document reduce must emit one cited point per source interval, so a
// 300-page synthesis needs headroom well past the map budget. 4096 truncated
// real Gemma-12B reduces mid-JSON (measured), which then failed schema parsing.
const LOCAL_REDUCE_MAX_TOKENS = 8_192;
const DEFAULT_STAGE_ATTEMPTS = 2;
const DEFAULT_REDUCE_GROUP_SIZE = 8;
const MAP_MAX_TOKENS = 3_072;
const REDUCE_MAX_TOKENS = 6_144;
const SUMMARY_RESULT_CACHE_LIMIT = 8;
const SUMMARY_MAP_CACHE_LIMIT = 256;
const summaryResultCache = new Map<string, DocumentSummaryResult>();
const summaryMapCache = new Map<string, ValidatedBatchSummary>();

const EVIDENCE_JSON_SCHEMA = {
  type: "object",
  properties: {
    chunk_id: { type: "string" },
    quote: { type: "string" },
  },
  required: ["chunk_id", "quote"],
  additionalProperties: false,
};

const MAP_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    points: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          evidence: { type: "array", items: EVIDENCE_JSON_SCHEMA },
        },
        required: ["text", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["points"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const REDUCE_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          points: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                evidence_ids: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["text", "evidence_ids"],
              additionalProperties: false,
            },
          },
        },
        required: ["heading", "points"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "sections"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const MAP_SYSTEM_PROMPT = `You summarize one ordered slice of a document. Return JSON only.
Preserve every distinct section, chapter, case, party, tribunal, issue, holding, rule, material line of reasoning, remedy, methodology, exception, caveat, and dissent that appears in this slice. Keep the points in source order and do not collapse distinct cases or sections into one generic theme. Prefer 3 to 6 evidence-rich points per slice, combining adjacent details only when they share the same conclusion.
Every factual point must have at least one verbatim source quote of at most 25 words. Copy the quote exactly and name its chunk_id. Never cite text outside the supplied chunks. The server derives offsets; do not estimate them.`;

const REDUCE_SYSTEM_PROMPT = `You synthesize a document summary from validated batch summaries. Return JSON only.
Use only the supplied evidence IDs. Every final point must cite at least one evidence ID. Do not add facts that are absent from the batch summaries.
Produce an executive synthesis followed by an ordered section/chapter/case-level account and cross-cutting conclusions. Preserve distinct holdings, reasoning, exceptions, and disagreements. Every evidence-bearing batch must contribute at least one cited final point; do not silently omit a source interval.`;

export type DocumentSummaryChunk = {
  chunk_id: string;
  chunk_index: number;
  page_number: number | null;
  page_end?: number | null;
  content: string;
  start_char: number;
  end_char: number;
};

export type DocumentSummaryOcrStatus = {
  truncated: boolean;
  ocrPages?: number;
  scannedPages?: number;
};

export type DocumentSummaryPageRange = {
  start: number;
  end: number;
};

export type DocumentSummaryWarning = {
  code:
    | "PARTIAL_OCR"
    | "MISSING_INDEXED_PAGES"
    | "UNKNOWN_PAGE_COVERAGE"
    | "MAP_FAILED";
  message: string;
  pageRanges?: DocumentSummaryPageRange[];
};

export type DocumentSummaryCoverage = {
  pageCount: number;
  indexedPages: number[];
  indexedPageRanges: DocumentSummaryPageRange[];
  indexedChunkCount: number;
  processedChunkCount: number;
  processedChunkIds: string[];
  batchCount: number;
  complete: boolean;
  warnings: DocumentSummaryWarning[];
};

export type DocumentSummaryCitation = {
  ref: number;
  doc_id: string;
  page: number | string;
  quote: string;
  chunk_id: string;
  chunk_index: number;
  /** Zero-based, end-exclusive offsets within chunk_id, matching chatTools. */
  quote_start: number;
  quote_end: number;
  chunk_quote_start: number;
  chunk_quote_end: number;
  document_start_char: number;
  document_end_char: number;
  document_id: string;
  version_id: string;
};

export type DocumentSummaryResult = {
  preparedText: string;
  citations: DocumentSummaryCitation[];
  coverage: DocumentSummaryCoverage;
};

export type DocumentSummaryBatch = {
  id: string;
  chunks: readonly DocumentSummaryChunk[];
  pageRange: DocumentSummaryPageRange | null;
  inputCharacters: number;
};

export type DocumentSummaryMapRequest = {
  filename: string;
  language: string;
  focus?: string;
  batch: DocumentSummaryBatch;
  systemPrompt: string;
  userPrompt: string;
};

export type DocumentSummaryReduceRequest = {
  filename: string;
  language: string;
  focus?: string;
  batchSummaries: readonly ValidatedBatchSummary[];
  systemPrompt: string;
  userPrompt: string;
};

export type DocumentSummaryDependencies = {
  complete?: typeof completeText;
  map?: (request: DocumentSummaryMapRequest) => Promise<string>;
  reduce?: (request: DocumentSummaryReduceRequest) => Promise<string>;
  batchCache?: DocumentSummaryBatchCache;
  /** Test hook; production caching is enabled only for the real adapters. */
  cacheResults?: boolean;
};

export type DocumentSummaryBatchCache = {
  get(
    key: string,
  ): ValidatedBatchSummary | null | Promise<ValidatedBatchSummary | null>;
  set(
    key: string,
    value: ValidatedBatchSummary,
  ): void | Promise<void>;
};

export type DocumentSummaryProgress = {
  completedBatches: number;
  totalBatches: number;
  pageRange: DocumentSummaryPageRange | null;
  etaMs?: number;
};

export type SummarizeDocumentWithCoverageArgs = {
  model: string;
  apiKeys: UserApiKeys;
  filename: string;
  /** Chat-local slug used by the existing citation parser, e.g. doc-0. */
  docId: string;
  documentId: string;
  versionId: string;
  chunks: readonly DocumentSummaryChunk[];
  pageCount: number;
  ocrStatus?: DocumentSummaryOcrStatus;
  focus?: string;
  /** Human-readable requested output language. Defaults to Korean. */
  language?: string;
  maxBatchCharacters?: number;
  maxBatchPages?: number;
  /** Number of map requests allowed in flight. Defaults to one for local models and three for remote models. */
  mapConcurrency?: number;
  /** Validation repair attempts for each map batch and the reduce stage. */
  maxStageAttempts?: number;
  /** Abort on any terminal map failure instead of returning partial coverage. */
  failHard?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: DocumentSummaryProgress) => void | Promise<void>;
};

export class DocumentSummaryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentSummaryValidationError";
  }
}

const mapResponseSchema = z.object({
  points: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        evidence: z
          .array(
            z.object({
              chunk_id: z.string().trim().min(1),
              quote: z.string().trim().min(1),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

const reduceResponseSchema = z.object({
  title: z.string().trim().min(1),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().min(1),
        points: z
          .array(
            z.object({
              text: z.string().trim().min(1),
              evidence_ids: z.array(z.string().trim().min(1)).min(1),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export type ValidatedEvidence = {
  id: string;
  sourceBatchId: string;
  claim: string;
  chunk: DocumentSummaryChunk;
  quote: string;
  quoteStart: number;
  quoteEnd: number;
};

export type ValidatedBatchSummary = {
  batchId: string;
  points: {
    text: string;
    evidenceIds: string[];
  }[];
  evidence: ValidatedEvidence[];
};

function normalizedEvidenceWithOffsets(value: string): {
  text: string;
  starts: number[];
  ends: number[];
} {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of value) {
    const start = offset;
    offset += character.length;
    const normalized = character.normalize("NFKC").toLocaleLowerCase();
    for (const normalizedCharacter of normalized) {
      if (/\s/u.test(normalizedCharacter)) continue;
      text += normalizedCharacter;
      starts.push(start);
      ends.push(offset);
    }
  }
  return { text, starts, ends };
}

type EvidenceToken = { normalized: string; start: number; end: number };

function evidenceTokens(value: string): EvidenceToken[] {
  return Array.from(value.matchAll(/[\p{L}\p{N}]+/gu)).map((match) => ({
    normalized: match[0].normalize("NFKC").toLocaleLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function limitLocatedEvidenceQuote(
  content: string,
  start: number,
  end: number,
): { quote: string; start: number; end: number } {
  const selected = content.slice(start, end);
  const tokens = evidenceTokens(selected);
  const boundedEnd = tokens.length > 25 ? start + tokens[24].end : end;
  const quote = content.slice(start, boundedEnd).trimEnd();
  return { quote, start, end: start + quote.length };
}

function locateFuzzyEvidenceQuote(
  content: string,
  candidate: string,
): { quote: string; start: number; end: number } | null {
  const sourceTokens = evidenceTokens(content);
  const candidateTokens = evidenceTokens(candidate);
  if (sourceTokens.length === 0 || candidateTokens.length === 0) return null;
  const sourcePositions = new Map<string, number[]>();
  sourceTokens.forEach((token, index) => {
    const positions = sourcePositions.get(token.normalized) ?? [];
    positions.push(index);
    sourcePositions.set(token.normalized, positions);
  });
  let bestLength = 0;
  const bestSourceStarts = new Set<number>();
  for (
    let candidateStart = 0;
    candidateStart < candidateTokens.length;
    candidateStart += 1
  ) {
    const positions =
      sourcePositions.get(candidateTokens[candidateStart].normalized) ?? [];
    for (const sourceStart of positions) {
      let length = 0;
      while (
        candidateStart + length < candidateTokens.length &&
        sourceStart + length < sourceTokens.length &&
        candidateTokens[candidateStart + length].normalized ===
          sourceTokens[sourceStart + length].normalized
      ) {
        length += 1;
      }
      if (length > bestLength) {
        bestLength = length;
        bestSourceStarts.clear();
        bestSourceStarts.add(sourceStart);
      } else if (length === bestLength && length > 0) {
        bestSourceStarts.add(sourceStart);
      }
    }
  }
  const requiredLength = Math.min(candidateTokens.length, 3);
  if (bestLength < requiredLength || bestSourceStarts.size !== 1) return null;
  const sourceStart = [...bestSourceStarts][0];
  const windowRoom = Math.max(0, 25 - Math.min(bestLength, 25));
  const windowStart = Math.max(0, sourceStart - Math.floor(windowRoom / 2));
  const windowEnd = Math.min(sourceTokens.length, windowStart + 25);
  const adjustedWindowStart = Math.max(0, windowEnd - 25);
  const start = sourceTokens[adjustedWindowStart].start;
  const end = sourceTokens[windowEnd - 1].end;
  return limitLocatedEvidenceQuote(content, start, end);
}

function locateEvidenceQuote(
  content: string,
  candidate: string,
  allowFuzzy = true,
): { quote: string; start: number; end: number } | null {
  const exactStart = content.indexOf(candidate);
  if (exactStart >= 0 && content.lastIndexOf(candidate) === exactStart) {
    return limitLocatedEvidenceQuote(
      content,
      exactStart,
      exactStart + candidate.length,
    );
  }
  const normalizedContent = normalizedEvidenceWithOffsets(content);
  const normalizedCandidate = normalizedEvidenceWithOffsets(candidate).text;
  if (!normalizedCandidate) return null;
  const normalizedStart = normalizedContent.text.indexOf(normalizedCandidate);
  if (
    normalizedStart < 0 ||
    normalizedContent.text.lastIndexOf(normalizedCandidate) !== normalizedStart
  ) {
    return allowFuzzy ? locateFuzzyEvidenceQuote(content, candidate) : null;
  }
  const normalizedEnd = normalizedStart + normalizedCandidate.length - 1;
  const start = normalizedContent.starts[normalizedStart];
  const end = normalizedContent.ends[normalizedEnd];
  return limitLocatedEvidenceQuote(content, start, end);
}

function stripJsonCodeFence(raw: string): string {
  // Local models frequently wrap JSON in a ```json ... ``` fence. Strip an
  // opening fence and a closing fence independently so a truncated response
  // that lost its closing fence is still recoverable, and a non-fenced
  // response is returned unchanged.
  const withoutOpen = raw.trim().replace(/^```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n?/, "");
  return withoutOpen.replace(/\r?\n?[ \t]*```[ \t]*$/, "").trim();
}

function parseJsonResponse(raw: string, stage: "map" | "reduce"): unknown {
  const candidate = stripJsonCodeFence(raw);
  try {
    return JSON.parse(candidate);
  } catch {
    // Fallback: scan for balanced top-level objects and keep the LARGEST one
    // that parses, so leading prose or a stray fence never lets a nested
    // object shadow the real outer payload.
    let best: unknown;
    let bestLength = 0;
    for (let start = 0; start < candidate.length; start += 1) {
      if (candidate[start] !== "{") continue;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let end = start; end < candidate.length; end += 1) {
        const character = candidate[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === "{") depth += 1;
        else if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            const slice = candidate.slice(start, end + 1);
            if (slice.length > bestLength) {
              try {
                best = JSON.parse(slice);
                bestLength = slice.length;
              } catch {
                // keep scanning for a parseable object
              }
            }
            break;
          }
        }
      }
    }
    if (bestLength > 0) return best;
    throw new DocumentSummaryValidationError(
      `${stage} response was not valid JSON`,
    );
  }
}

function validateChunks(chunks: readonly DocumentSummaryChunk[]): void {
  if (chunks.length === 0) {
    throw new DocumentSummaryValidationError(
      "At least one indexed chunk is required",
    );
  }
  const ids = new Set<string>();
  let priorIndex = -1;
  for (const chunk of chunks) {
    if (!chunk.chunk_id.trim() || ids.has(chunk.chunk_id)) {
      throw new DocumentSummaryValidationError(
        `Chunk IDs must be non-empty and unique: ${chunk.chunk_id}`,
      );
    }
    ids.add(chunk.chunk_id);
    if (
      !Number.isInteger(chunk.chunk_index) ||
      chunk.chunk_index <= priorIndex
    ) {
      throw new DocumentSummaryValidationError(
        "Chunks must be supplied in strictly increasing chunk_index order",
      );
    }
    priorIndex = chunk.chunk_index;
    if (!chunk.content) {
      throw new DocumentSummaryValidationError(
        `Chunk ${chunk.chunk_id} has no indexed content`,
      );
    }
    if (
      !Number.isInteger(chunk.start_char) ||
      !Number.isInteger(chunk.end_char) ||
      chunk.start_char < 0 ||
      chunk.end_char < chunk.start_char
    ) {
      throw new DocumentSummaryValidationError(
        `Chunk ${chunk.chunk_id} has invalid character offsets`,
      );
    }
    const pageEnd = chunk.page_end ?? chunk.page_number;
    if (
      (chunk.page_number !== null &&
        (!Number.isInteger(chunk.page_number) || chunk.page_number < 1)) ||
      (pageEnd !== null &&
        (!Number.isInteger(pageEnd) ||
          pageEnd < 1 ||
          (chunk.page_number !== null && pageEnd < chunk.page_number)))
    ) {
      throw new DocumentSummaryValidationError(
        `Chunk ${chunk.chunk_id} has an invalid page range`,
      );
    }
  }
}

function pageRangeForChunks(
  chunks: readonly DocumentSummaryChunk[],
): DocumentSummaryPageRange | null {
  const starts = chunks
    .map((chunk) => chunk.page_number)
    .filter((page): page is number => page !== null);
  if (!starts.length) return null;
  const ends = chunks.map(
    (chunk) => chunk.page_end ?? chunk.page_number ?? starts[0],
  );
  return { start: Math.min(...starts), end: Math.max(...ends) };
}

function sourceRecords(chunks: readonly DocumentSummaryChunk[]) {
  return chunks.map((chunk) => ({
    chunk_id: chunk.chunk_id,
    page_start: chunk.page_number,
    page_end: chunk.page_end ?? chunk.page_number,
    content: chunk.content,
  }));
}

function buildMapUserPrompt(args: {
  filename: string;
  language: string;
  focus?: string;
  batchId: string;
  chunks: readonly DocumentSummaryChunk[];
}): string {
  return [
    `Filename: ${args.filename}`,
    `Output language: ${args.language}`,
    `Focus: ${args.focus?.trim() || "Summarize all material content"}`,
    `Batch: ${args.batchId}`,
    'Return {"points":[{"text":"...","evidence":[{"chunk_id":"...","quote":"exact verbatim quote, at most 25 words"}]}]}.',
    "Ordered source chunks (one JSON object per line):",
    sourceRecords(args.chunks)
      .map((record) => JSON.stringify(record))
      .join("\n"),
  ].join("\n");
}

export function packDocumentSummaryBatches(args: {
  filename: string;
  chunks: readonly DocumentSummaryChunk[];
  language?: string;
  focus?: string;
  maxBatchCharacters?: number;
  maxBatchPages?: number;
}): DocumentSummaryBatch[] {
  validateChunks(args.chunks);
  const language = args.language?.trim() || "Korean";
  const maxCharacters = Math.max(
    1,
    Math.floor(args.maxBatchCharacters ?? DEFAULT_BATCH_CHARACTERS),
  );
  const maxPages = Math.max(
    1,
    Math.floor(args.maxBatchPages ?? DEFAULT_BATCH_PAGES),
  );
  const batches: DocumentSummaryBatch[] = [];
  let pending: DocumentSummaryChunk[] = [];

  const inputSize = (
    chunks: readonly DocumentSummaryChunk[],
    batchNumber: number,
  ) => {
    const userPrompt = buildMapUserPrompt({
      filename: args.filename,
      language,
      focus: args.focus,
      batchId: `batch-${batchNumber}`,
      chunks,
    });
    return MAP_SYSTEM_PROMPT.length + userPrompt.length;
  };

  const commit = () => {
    if (!pending.length) return;
    const batchNumber = batches.length + 1;
    batches.push({
      id: `batch-${batchNumber}`,
      chunks: pending,
      pageRange: pageRangeForChunks(pending),
      inputCharacters: inputSize(pending, batchNumber),
    });
    pending = [];
  };

  for (const chunk of args.chunks) {
    const candidate = [...pending, chunk];
    const range = pageRangeForChunks(candidate);
    const pageSpan = range ? range.end - range.start + 1 : 0;
    const fits =
      pageSpan <= maxPages &&
      inputSize(candidate, batches.length + 1) <= maxCharacters;
    if (!fits && pending.length) {
      commit();
    }
    const singleRange = pageRangeForChunks([chunk]);
    const singlePageSpan = singleRange
      ? singleRange.end - singleRange.start + 1
      : 0;
    if (
      singlePageSpan > maxPages ||
      inputSize([chunk], batches.length + 1) > maxCharacters
    ) {
      throw new DocumentSummaryValidationError(
        `Chunk ${chunk.chunk_id} cannot fit within the configured batch bounds`,
      );
    }
    pending.push(chunk);
  }
  commit();
  return batches;
}

function validateMapResponse(
  raw: string,
  batch: DocumentSummaryBatch,
): ValidatedBatchSummary {
  const parsed = mapResponseSchema.safeParse(parseJsonResponse(raw, "map"));
  if (!parsed.success) {
    throw new DocumentSummaryValidationError(
      `map response did not match the required evidence schema: ${z.prettifyError(parsed.error)}`,
    );
  }
  const sourceCharacters = batch.chunks.reduce(
    (total, chunk) => total + chunk.content.length,
    0,
  );
  const minimumPoints = Math.min(
    6,
    batch.chunks.length,
    Math.max(1, Math.ceil(sourceCharacters / 12_000)),
  );
  const byId = new Map(batch.chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const evidence: ValidatedEvidence[] = [];
  const rejectedEvidence: string[] = [];
  const points = parsed.data.points.flatMap((point, pointIndex) => {
    const evidenceIds = point.evidence.flatMap(
      (candidate, evidenceIndex): string[] => {
        let chunk = byId.get(candidate.chunk_id);
        let locatedQuote = chunk
          ? locateEvidenceQuote(chunk.content, candidate.quote)
          : null;
        if (!chunk) {
          const strictMatches = batch.chunks
            .map((candidateChunk) => ({
              chunk: candidateChunk,
              located: locateEvidenceQuote(
                candidateChunk.content,
                candidate.quote,
                false,
              ),
            }))
            .filter(
              (
                match,
              ): match is {
                chunk: DocumentSummaryChunk;
                located: {
                  quote: string;
                  start: number;
                  end: number;
                };
              } => match.located !== null,
            );
          const recovered =
            strictMatches.length > 0
              ? strictMatches
              : batch.chunks
                  .map((candidateChunk) => ({
                    chunk: candidateChunk,
                    located: locateEvidenceQuote(
                      candidateChunk.content,
                      candidate.quote,
                    ),
                  }))
                  .filter(
                    (
                      match,
                    ): match is {
                      chunk: DocumentSummaryChunk;
                      located: {
                        quote: string;
                        start: number;
                        end: number;
                      };
                    } => match.located !== null,
                  );
          if (recovered.length === 1) {
            chunk = recovered[0].chunk;
            locatedQuote = recovered[0].located;
          } else {
            rejectedEvidence.push(
              `map evidence referenced a chunk outside ${batch.id} and could not be uniquely recovered: ${candidate.chunk_id}`,
            );
            return [];
          }
        }
        if (!chunk || !locatedQuote) {
          const normalizedContent = normalizedEvidenceWithOffsets(
            chunk?.content ?? "",
          ).text;
          const normalizedCandidate = normalizedEvidenceWithOffsets(
            candidate.quote,
          ).text;
          const normalizedStart =
            normalizedContent.indexOf(normalizedCandidate);
          rejectedEvidence.push(
            normalizedStart < 0
              ? `map evidence quote was not found in chunk ${candidate.chunk_id}`
              : `map evidence quote was ambiguous in chunk ${candidate.chunk_id}`,
          );
          return [];
        }
        const id = `${batch.id}-point-${pointIndex + 1}-evidence-${evidenceIndex + 1}`;
        evidence.push({
          id,
          sourceBatchId: batch.id,
          claim: point.text,
          chunk,
          quote: locatedQuote.quote,
          quoteStart: locatedQuote.start,
          quoteEnd: locatedQuote.end,
        });
        return [id];
      },
    );
    return evidenceIds.length > 0 ? [{ text: point.text, evidenceIds }] : [];
  });
  if (points.length < minimumPoints) {
    const detail = rejectedEvidence[0]
      ? ` First rejected evidence: ${rejectedEvidence[0]}`
      : "";
    throw new DocumentSummaryValidationError(
      `map response was too sparse for ${batch.id} after source validation: expected at least ${minimumPoints} supported points, received ${points.length}.${detail}`,
    );
  }
  return { batchId: batch.id, points, evidence };
}

function buildReduceUserPrompt(args: {
  filename: string;
  language: string;
  focus?: string;
  summaries: readonly ValidatedBatchSummary[];
}): string {
  return [
    `Filename: ${args.filename}`,
    `Output language: ${args.language}`,
    `Focus: ${args.focus?.trim() || "Summarize all material content"}`,
    'Return {"title":"...","sections":[{"heading":"...","points":[{"text":"...","evidence_ids":["batch-1-point-1-evidence-1"]}]}]}.',
    "Validated batch summaries:",
    JSON.stringify(
      args.summaries.map((summary) => ({
        batch_id: summary.batchId,
        points: summary.points.map((point) => ({
          text: point.text,
          evidence_ids: point.evidenceIds,
        })),
        evidence: summary.evidence.map((item) => ({
          id: item.id,
          source_batch_id: item.sourceBatchId,
          quote: item.quote,
          page_start: item.chunk.page_number,
          page_end: item.chunk.page_end ?? item.chunk.page_number,
        })),
      })),
    ),
  ].join("\n");
}

function isLocalSummaryModel(model: string): boolean {
  return (
    model.startsWith("ollama:") ||
    model.startsWith("ollama/") ||
    model.startsWith("mlx:") ||
    model.startsWith("mlx/")
  );
}

function isOllamaSummaryModel(model: string): boolean {
  return model.startsWith("ollama:") || model.startsWith("ollama/");
}

function resolveReduceGroupSize(): number {
  const configured = Number.parseInt(
    process.env.DOCKET_SUMMARY_REDUCE_GROUP_SIZE ?? "",
    10,
  );
  return Number.isFinite(configured)
    ? Math.max(2, configured)
    : DEFAULT_REDUCE_GROUP_SIZE;
}

function enabledByEnvironment(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function defaultDocumentSummaryConcurrency(model: string): number {
  if (isLocalSummaryModel(model)) return 1;
  if (
    model.startsWith("free-router:") ||
    model.startsWith("free-router/") ||
    model === "free-router:auto"
  ) {
    return 2;
  }
  return 3;
}

export function estimateDocumentSummaryEtaMs(
  completedBatchDurationsMs: readonly number[],
  remainingBatches: number,
): number | undefined {
  if (completedBatchDurationsMs.length === 0) return undefined;
  const averageMs =
    completedBatchDurationsMs.reduce((total, duration) => total + duration, 0) /
    completedBatchDurationsMs.length;
  return Math.max(0, Math.round(averageMs * Math.max(0, remainingBatches)));
}

function localDocumentSummaryBatchBounds(): {
  maxBatchCharacters: number;
  maxBatchPages: number;
} {
  const maxBatchCharacters = Math.max(
    1,
    Math.floor(
      (resolveOllamaContextWindow() -
        LOCAL_MAP_MAX_TOKENS -
        LOCAL_CONTEXT_SAFETY_OVERHEAD) *
        resolveOllamaCharsPerToken(),
    ),
  );
  const maxBatchPages = Math.max(
    1,
    Math.floor(
      (maxBatchCharacters / LOCAL_REFERENCE_BATCH_CHARACTERS) *
        LOCAL_REFERENCE_BATCH_PAGES,
    ),
  );
  return { maxBatchCharacters, maxBatchPages };
}

export function defaultDocumentSummaryBatchBounds(model: string): {
  maxBatchCharacters: number;
  maxBatchPages: number;
} {
  if (isOllamaSummaryModel(model)) {
    return localDocumentSummaryBatchBounds();
  }
  if (model.startsWith("mlx:") || model.startsWith("mlx/")) {
    return {
      maxBatchCharacters: LOCAL_REFERENCE_BATCH_CHARACTERS,
      maxBatchPages: LOCAL_REFERENCE_BATCH_PAGES,
    };
  }
  if (
    model.startsWith("free-router:") ||
    model.startsWith("free-router/") ||
    model === "free-router:auto"
  ) {
    return {
      maxBatchCharacters: DEFAULT_BATCH_CHARACTERS,
      maxBatchPages: DEFAULT_BATCH_PAGES,
    };
  }
  return { maxBatchCharacters: 80_000, maxBatchPages: 48 };
}

function validationRepairPrompt(base: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${base}\n\nValidation feedback: ${message}\nReturn a corrected JSON object only. Re-check every evidence ID and copy every quote exactly from the supplied source.`;
}

async function runValidatedStage<T>(args: {
  attempts: number;
  basePrompt: string;
  invoke: (userPrompt: string) => Promise<string>;
  validate: (raw: string) => T;
}): Promise<T> {
  let prompt = args.basePrompt;
  let lastError: unknown;
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    const raw = await args.invoke(prompt);
    try {
      return args.validate(raw);
    } catch (error) {
      if (!(error instanceof DocumentSummaryValidationError)) throw error;
      lastError = error;
      if (attempt < args.attempts) {
        prompt = validationRepairPrompt(args.basePrompt, error);
      }
    }
  }
  throw lastError;
}

function validateReduceResponse(
  raw: string,
  batchSummaries: readonly ValidatedBatchSummary[],
) {
  const reduced = reduceResponseSchema.safeParse(
    parseJsonResponse(raw, "reduce"),
  );
  if (!reduced.success) {
    throw new DocumentSummaryValidationError(
      `reduce response did not match the required schema: ${z.prettifyError(reduced.error)}`,
    );
  }
  const sourceBatchByEvidenceId = new Map<string, string>();
  const evidenceBearingSourceBatches = new Set<string>();
  for (const summary of batchSummaries) {
    for (const evidence of summary.evidence) {
      sourceBatchByEvidenceId.set(evidence.id, evidence.sourceBatchId);
      evidenceBearingSourceBatches.add(evidence.sourceBatchId);
    }
  }
  const representedSourceBatches = new Set<string>();
  for (const section of reduced.data.sections) {
    for (const point of section.points) {
      for (const evidenceId of point.evidence_ids) {
        const sourceBatchId = sourceBatchByEvidenceId.get(evidenceId);
        if (!sourceBatchId) {
          throw new DocumentSummaryValidationError(
            `reduce response referenced unknown evidence: ${evidenceId}`,
          );
        }
        representedSourceBatches.add(sourceBatchId);
      }
    }
  }
  const omitted = [...evidenceBearingSourceBatches].filter(
    (batchId) => !representedSourceBatches.has(batchId),
  );
  if (omitted.length > 0) {
    throw new DocumentSummaryValidationError(
      `reduce response omitted evidence-bearing batches: ${omitted.join(", ")}`,
    );
  }
  const finalPointCount = reduced.data.sections.reduce(
    (total, section) => total + section.points.length,
    0,
  );
  const mappedPointCount = batchSummaries.reduce(
    (total, summary) => total + summary.points.length,
    0,
  );
  const minimumFinalPoints = Math.min(
    24,
    Math.max(
      evidenceBearingSourceBatches.size,
      Math.ceil(mappedPointCount / 3),
    ),
  );
  if (finalPointCount < minimumFinalPoints) {
    throw new DocumentSummaryValidationError(
      `reduce response was too sparse: expected at least ${minimumFinalPoints} distinct final points, received ${finalPointCount}`,
    );
  }
  return reduced.data;
}

type ValidatedReduceResponse = z.infer<typeof reduceResponseSchema>;

function intermediateReduceSummary(args: {
  id: string;
  reduced: ValidatedReduceResponse;
  inputs: readonly ValidatedBatchSummary[];
}): ValidatedBatchSummary {
  const points = args.reduced.sections.flatMap((section) =>
    section.points.map((point) => ({
      text: point.text,
      evidenceIds: point.evidence_ids,
    })),
  );
  const citedEvidenceIds = new Set(
    points.flatMap((point) => point.evidenceIds),
  );
  const evidence = args.inputs
    .flatMap((summary) => summary.evidence)
    .filter((item) => citedEvidenceIds.has(item.id));
  return { batchId: args.id, points, evidence };
}

function pageRanges(pages: readonly number[]): DocumentSummaryPageRange[] {
  if (!pages.length) return [];
  const ranges: DocumentSummaryPageRange[] = [];
  let start = pages[0];
  let end = pages[0];
  for (const page of pages.slice(1)) {
    if (page === end + 1) {
      end = page;
    } else {
      ranges.push({ start, end });
      start = page;
      end = page;
    }
  }
  ranges.push({ start, end });
  return ranges;
}

function formatPageRanges(ranges: readonly DocumentSummaryPageRange[]): string {
  return ranges.length
    ? ranges
        .map((range) =>
          range.start === range.end
            ? `${range.start}`
            : `${range.start}–${range.end}`,
        )
        .join(", ")
    : "none";
}

function buildCoverage(
  args: SummarizeDocumentWithCoverageArgs,
  batches: readonly DocumentSummaryBatch[],
  failedBatches: readonly DocumentSummaryBatch[] = [],
): DocumentSummaryCoverage {
  const indexedPageSet = new Set<number>();
  let hasUnknownPages = false;
  for (const chunk of args.chunks) {
    if (chunk.page_number === null) {
      hasUnknownPages = true;
      continue;
    }
    const end = chunk.page_end ?? chunk.page_number;
    for (let page = chunk.page_number; page <= end; page += 1) {
      if (page <= args.pageCount) indexedPageSet.add(page);
    }
  }
  const indexedPages = [...indexedPageSet].sort((a, b) => a - b);
  const missingPages = Array.from(
    { length: args.pageCount },
    (_, i) => i + 1,
  ).filter((page) => !indexedPageSet.has(page));
  const warnings: DocumentSummaryWarning[] = [];
  if (args.ocrStatus?.truncated) {
    warnings.push({
      code: "PARTIAL_OCR",
      message: `OCR coverage is partial (${args.ocrStatus.ocrPages ?? "unknown"}/${args.ocrStatus.scannedPages ?? "unknown"} scanned pages processed).`,
    });
  }
  if (missingPages.length) {
    const ranges = pageRanges(missingPages);
    warnings.push({
      code: "MISSING_INDEXED_PAGES",
      message: `No indexed chunk covers ${missingPages.length} document page(s).`,
      pageRanges: ranges,
    });
  }
  if (hasUnknownPages) {
    warnings.push({
      code: "UNKNOWN_PAGE_COVERAGE",
      message: "One or more indexed chunks do not have page metadata.",
    });
  }
  for (const batch of failedBatches) {
    warnings.push({
      code: "MAP_FAILED",
      message: batch.pageRange
        ? `Map summarization failed for source pages ${formatPageRanges([batch.pageRange])}.`
        : `Map summarization failed for source interval ${batch.id} with unknown pages.`,
      pageRanges: batch.pageRange ? [batch.pageRange] : undefined,
    });
  }
  const failedBatchIds = new Set(failedBatches.map((batch) => batch.id));
  const processedBatches = batches.filter(
    (batch) => !failedBatchIds.has(batch.id),
  );
  return {
    pageCount: args.pageCount,
    indexedPages,
    indexedPageRanges: pageRanges(indexedPages),
    indexedChunkCount: args.chunks.length,
    processedChunkCount: processedBatches.reduce(
      (total, batch) => total + batch.chunks.length,
      0,
    ),
    processedChunkIds: processedBatches.flatMap((batch) =>
      batch.chunks.map((chunk) => chunk.chunk_id),
    ),
    batchCount: batches.length,
    complete:
      missingPages.length === 0 &&
      !hasUnknownPages &&
      !args.ocrStatus?.truncated &&
      failedBatches.length === 0,
    warnings,
  };
}

function citationPage(chunk: DocumentSummaryChunk): number | string {
  const start = chunk.page_number;
  const end = chunk.page_end ?? start;
  if (start === null) return "unknown";
  return end !== null && end !== start ? `${start}-${end}` : start;
}

function documentSummaryCacheKey(args: {
  request: SummarizeDocumentWithCoverageArgs;
  language: string;
  maxBatchCharacters: number;
  maxBatchPages: number;
  reduceGroupSize: number;
  reduceThinking: boolean;
}): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      model: args.request.model,
      filename: args.request.filename,
      docId: args.request.docId,
      documentId: args.request.documentId,
      versionId: args.request.versionId,
      pageCount: args.request.pageCount,
      focus: args.request.focus?.trim() ?? "",
      language: args.language,
      ocrStatus: args.request.ocrStatus ?? null,
      maxBatchCharacters: args.maxBatchCharacters,
      maxBatchPages: args.maxBatchPages,
      reduceGroupSize: args.reduceGroupSize,
      reduceThinking: args.reduceThinking,
    }),
  );
  for (const chunk of args.request.chunks) {
    hash.update("\0");
    hash.update(
      JSON.stringify({
        chunkId: chunk.chunk_id,
        chunkIndex: chunk.chunk_index,
        pageNumber: chunk.page_number,
        pageEnd: chunk.page_end ?? null,
        startChar: chunk.start_char,
        endChar: chunk.end_char,
      }),
    );
    hash.update("\0");
    hash.update(chunk.content);
  }
  return hash.digest("hex");
}

function documentSummaryBatchCacheKey(args: {
  request: SummarizeDocumentWithCoverageArgs;
  batch: DocumentSummaryBatch;
  language: string;
  maxBatchCharacters: number;
  maxBatchPages: number;
}): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      model: args.request.model,
      filename: args.request.filename,
      focus: args.request.focus?.trim() ?? "",
      language: args.language,
      maxBatchCharacters: args.maxBatchCharacters,
      maxBatchPages: args.maxBatchPages,
      mapSystemPrompt: MAP_SYSTEM_PROMPT,
      batchId: args.batch.id,
      chunks: args.batch.chunks.map((chunk) => ({
        chunkId: chunk.chunk_id,
        chunkIndex: chunk.chunk_index,
        pageNumber: chunk.page_number,
        pageEnd: chunk.page_end ?? null,
        startChar: chunk.start_char,
        endChar: chunk.end_char,
        contentHash: createHash("sha256").update(chunk.content).digest("hex"),
      })),
    }),
  );
  return hash.digest("hex");
}

function cacheDocumentSummary(
  key: string,
  result: DocumentSummaryResult,
): void {
  summaryResultCache.delete(key);
  summaryResultCache.set(key, structuredClone(result));
  while (summaryResultCache.size > SUMMARY_RESULT_CACHE_LIMIT) {
    const oldest = summaryResultCache.keys().next().value;
    if (oldest === undefined) break;
    summaryResultCache.delete(oldest);
  }
}

export function clearDocumentSummaryResultCache(): void {
  summaryResultCache.clear();
  summaryMapCache.clear();
}

export async function summarizeDocumentWithCoverage(
  args: SummarizeDocumentWithCoverageArgs,
  dependencies: DocumentSummaryDependencies = {},
): Promise<DocumentSummaryResult> {
  args.signal?.throwIfAborted();
  if (!Number.isInteger(args.pageCount) || args.pageCount < 1) {
    throw new DocumentSummaryValidationError(
      "pageCount must be a positive integer",
    );
  }
  const language = args.language?.trim() || "Korean";
  const stageAttempts = Math.max(
    1,
    Math.min(
      3,
      Math.floor(
        args.maxStageAttempts ??
          (isLocalSummaryModel(args.model) ? 3 : DEFAULT_STAGE_ATTEMPTS),
      ),
    ),
  );
  const batchBounds = defaultDocumentSummaryBatchBounds(args.model);
  const maxBatchCharacters =
    args.maxBatchCharacters ?? batchBounds.maxBatchCharacters;
  const maxBatchPages = args.maxBatchPages ?? batchBounds.maxBatchPages;
  const batches = packDocumentSummaryBatches({
    filename: args.filename,
    chunks: args.chunks,
    language,
    focus: args.focus,
    maxBatchCharacters,
    maxBatchPages,
  });
  const reduceGroupSize = resolveReduceGroupSize();
  const reduceThinking =
    isOllamaSummaryModel(args.model) &&
    enabledByEnvironment(process.env.DOCKET_SUMMARY_REDUCE_THINKING);
  const failHard =
    args.failHard ??
    enabledByEnvironment(process.env.DOCKET_SUMMARY_FAIL_HARD);
  const shouldCache =
    dependencies.cacheResults ??
    (!dependencies.complete && !dependencies.map && !dependencies.reduce);
  const cacheKey = shouldCache
    ? documentSummaryCacheKey({
        request: args,
        language,
        maxBatchCharacters,
        maxBatchPages,
        reduceGroupSize,
        reduceThinking,
      })
    : null;
  if (cacheKey) {
    const cached = summaryResultCache.get(cacheKey);
    if (cached) {
      summaryResultCache.delete(cacheKey);
      summaryResultCache.set(cacheKey, cached);
      await args.onProgress?.({
        completedBatches: cached.coverage.batchCount,
        totalBatches: cached.coverage.batchCount,
        pageRange: null,
      });
      return structuredClone(cached);
    }
  }
  const complete = dependencies.complete ?? completeText;
  const mapMaxTokens = isLocalSummaryModel(args.model)
    ? LOCAL_MAP_MAX_TOKENS
    : MAP_MAX_TOKENS;
  const reduceMaxTokens = isLocalSummaryModel(args.model)
    ? LOCAL_REDUCE_MAX_TOKENS
    : REDUCE_MAX_TOKENS;
  const map =
    dependencies.map ??
    (async (request: DocumentSummaryMapRequest) =>
      complete({
        model: args.model,
        apiKeys: args.apiKeys,
        maxTokens: mapMaxTokens,
        responseJsonSchema: MAP_RESPONSE_JSON_SCHEMA,
        think: false,
        signal: args.signal,
        systemPrompt: request.systemPrompt,
        user: request.userPrompt,
      }));
  const reduce =
    dependencies.reduce ??
    (async (request: DocumentSummaryReduceRequest) =>
      complete({
        model: args.model,
        apiKeys: args.apiKeys,
        maxTokens: reduceMaxTokens,
        responseJsonSchema: reduceThinking
          ? undefined
          : REDUCE_RESPONSE_JSON_SCHEMA,
        think: reduceThinking,
        signal: args.signal,
        systemPrompt: request.systemPrompt,
        user: request.userPrompt,
      }));

  const batchSummaries = new Array<ValidatedBatchSummary | undefined>(
    batches.length,
  );
  const mapFailures = new Array<unknown | undefined>(batches.length);
  let nextBatchIndex = 0;
  let completedBatches = 0;
  const completedBatchDurationsMs: number[] = [];
  const reportBatchProgress = async (
    batch: DocumentSummaryBatch,
    startedAt: number,
  ): Promise<void> => {
    completedBatchDurationsMs.push(Date.now() - startedAt);
    completedBatches += 1;
    await args.onProgress?.({
      completedBatches,
      totalBatches: batches.length,
      pageRange: batch.pageRange,
      etaMs: estimateDocumentSummaryEtaMs(
        completedBatchDurationsMs,
        batches.length - completedBatches,
      ),
    });
  };
  const mapValidatedBatch = async (
    batch: DocumentSummaryBatch,
  ): Promise<ValidatedBatchSummary> => {
    const userPrompt = buildMapUserPrompt({
      filename: args.filename,
      language,
      focus: args.focus,
      batchId: batch.id,
      chunks: batch.chunks,
    });
    try {
      return await runValidatedStage({
        attempts: stageAttempts,
        basePrompt: userPrompt,
        invoke: (candidatePrompt) => {
          args.signal?.throwIfAborted();
          return map({
            filename: args.filename,
            language,
            focus: args.focus,
            batch,
            systemPrompt: MAP_SYSTEM_PROMPT,
            userPrompt: candidatePrompt,
          });
        },
        validate: (raw) => validateMapResponse(raw, batch),
      });
    } catch (error) {
      if (
        !(error instanceof DocumentSummaryValidationError) ||
        batch.chunks.length < 2
      ) {
        throw error;
      }

      // A local model can occasionally lose the requested JSON shape for one
      // dense interval. Split only that interval and retain the same strict
      // evidence validation instead of accepting or guessing malformed data.
      const midpoint = Math.ceil(batch.chunks.length / 2);
      const child = (
        suffix: string,
        chunks: readonly DocumentSummaryChunk[],
      ): DocumentSummaryBatch => {
        const id = `${batch.id}${suffix}`;
        const childPrompt = buildMapUserPrompt({
          filename: args.filename,
          language,
          focus: args.focus,
          batchId: id,
          chunks,
        });
        return {
          id,
          chunks,
          pageRange: pageRangeForChunks(chunks),
          inputCharacters: MAP_SYSTEM_PROMPT.length + childPrompt.length,
        };
      };
      const left = await mapValidatedBatch(
        child("a", batch.chunks.slice(0, midpoint)),
      );
      const right = await mapValidatedBatch(
        child("b", batch.chunks.slice(midpoint)),
      );
      return {
        batchId: batch.id,
        points: [...left.points, ...right.points],
        evidence: [...left.evidence, ...right.evidence].map((item) => ({
          ...item,
          sourceBatchId: batch.id,
        })),
      };
    }
  };
  const mapBatch = async (batch: DocumentSummaryBatch, batchIndex: number) => {
    const startedAt = Date.now();
    args.signal?.throwIfAborted();
    const batchCacheKey = documentSummaryBatchCacheKey({
      request: args,
      batch,
      language,
      maxBatchCharacters,
      maxBatchPages,
    });
    if (dependencies.batchCache) {
      try {
        const persisted = await dependencies.batchCache.get(batchCacheKey);
        if (persisted) {
          batchSummaries[batchIndex] = structuredClone(persisted);
          await reportBatchProgress(batch, startedAt);
          return;
        }
      } catch (error) {
        console.warn("[document-summary/cache] batch read failed", {
          batchId: batch.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const memoryMapCacheKey = shouldCache ? batchCacheKey : null;
    if (memoryMapCacheKey) {
      const cachedMap = summaryMapCache.get(memoryMapCacheKey);
      if (cachedMap) {
        summaryMapCache.delete(memoryMapCacheKey);
        summaryMapCache.set(memoryMapCacheKey, cachedMap);
        batchSummaries[batchIndex] = structuredClone(cachedMap);
        await reportBatchProgress(batch, startedAt);
        return;
      }
    }
    let summary: ValidatedBatchSummary;
    try {
      summary = await mapValidatedBatch(batch);
    } catch (error) {
      args.signal?.throwIfAborted();
      if (failHard) throw error;
      mapFailures[batchIndex] =
        error ?? new DocumentSummaryValidationError(`${batch.id} map failed`);
      console.warn("[document-summary/map] terminal batch failure", {
        batchId: batch.id,
        pageRange: batch.pageRange,
        error: error instanceof Error ? error.message : String(error),
      });
      await reportBatchProgress(batch, startedAt);
      return;
    }
    batchSummaries[batchIndex] = summary;
    if (memoryMapCacheKey) {
      summaryMapCache.delete(memoryMapCacheKey);
      summaryMapCache.set(memoryMapCacheKey, structuredClone(summary));
      while (summaryMapCache.size > SUMMARY_MAP_CACHE_LIMIT) {
        const oldest = summaryMapCache.keys().next().value;
        if (oldest === undefined) break;
        summaryMapCache.delete(oldest);
      }
    }
    if (dependencies.batchCache) {
      try {
        await dependencies.batchCache.set(
          batchCacheKey,
          structuredClone(summary),
        );
      } catch (error) {
        console.warn("[document-summary/cache] batch write failed", {
          batchId: batch.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await reportBatchProgress(batch, startedAt);
  };
  const concurrency = Math.max(
    1,
    Math.min(
      batches.length,
      6,
      Math.floor(
        args.mapConcurrency ?? defaultDocumentSummaryConcurrency(args.model),
      ),
    ),
  );
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const batchIndex = nextBatchIndex;
        nextBatchIndex += 1;
        if (batchIndex >= batches.length) return;
        await mapBatch(batches[batchIndex], batchIndex);
      }
    }),
  );

  const successfulBatchSummaries = batchSummaries.filter(
    (summary): summary is ValidatedBatchSummary => summary !== undefined,
  );
  const failedBatches = batches.filter(
    (_, batchIndex) => mapFailures[batchIndex] !== undefined,
  );
  if (successfulBatchSummaries.length === 0) {
    const firstFailure = mapFailures.find((error) => error !== undefined);
    if (firstFailure instanceof Error) throw firstFailure;
    throw new DocumentSummaryValidationError(
      "All document summary map batches failed",
    );
  }

  const reduceOnce = async (
    summaries: readonly ValidatedBatchSummary[],
  ): Promise<ValidatedReduceResponse> => {
    args.signal?.throwIfAborted();
    const userPrompt = buildReduceUserPrompt({
      filename: args.filename,
      language,
      focus: args.focus,
      summaries,
    });
    return runValidatedStage({
      attempts: stageAttempts,
      basePrompt: userPrompt,
      invoke: (candidatePrompt) => {
        args.signal?.throwIfAborted();
        return reduce({
          filename: args.filename,
          language,
          focus: args.focus,
          batchSummaries: summaries,
          systemPrompt: REDUCE_SYSTEM_PROMPT,
          userPrompt: candidatePrompt,
        });
      },
      validate: (raw) => validateReduceResponse(raw, summaries),
    });
  };
  const reduceInTiers = async (
    summaries: readonly ValidatedBatchSummary[],
    tier = 1,
  ): Promise<ValidatedReduceResponse> => {
    if (summaries.length <= reduceGroupSize) return reduceOnce(summaries);

    const intermediates: ValidatedBatchSummary[] = [];
    for (
      let groupStart = 0;
      groupStart < summaries.length;
      groupStart += reduceGroupSize
    ) {
      const group = summaries.slice(groupStart, groupStart + reduceGroupSize);
      const reducedGroup = await reduceOnce(group);
      intermediates.push(
        intermediateReduceSummary({
          id: `reduce-tier-${tier}-group-${intermediates.length + 1}`,
          reduced: reducedGroup,
          inputs: group,
        }),
      );
    }
    return reduceInTiers(intermediates, tier + 1);
  };
  const reduced = await reduceInTiers(successfulBatchSummaries);

  const evidenceById = new Map(
    successfulBatchSummaries
      .flatMap((summary) => summary.evidence)
      .map((item) => [item.id, item]),
  );
  const coverage = buildCoverage(args, batches, failedBatches);
  const citations: DocumentSummaryCitation[] = [];
  const markdown: string[] = [
    `> Index coverage: indexed pages ${formatPageRanges(coverage.indexedPageRanges)}; processed ${coverage.processedChunkCount}/${coverage.indexedChunkCount} chunks; ${coverage.batchCount} source intervals; ${coverage.complete ? "complete" : "partial"}.`,
    ...coverage.warnings.map((warning) => `> Warning: ${warning.message}`),
    `# ${reduced.title}`,
  ];
  for (const section of reduced.sections) {
    markdown.push(`## ${section.heading}`);
    for (const point of section.points) {
      const refs = point.evidence_ids.map((evidenceId) => {
        const evidence = evidenceById.get(evidenceId);
        if (!evidence) {
          throw new DocumentSummaryValidationError(
            `reduce response referenced unknown evidence: ${evidenceId}`,
          );
        }
        const ref = citations.length + 1;
        citations.push({
          ref,
          doc_id: args.docId,
          page: citationPage(evidence.chunk),
          quote: evidence.quote,
          chunk_id: evidence.chunk.chunk_id,
          chunk_index: evidence.chunk.chunk_index,
          quote_start: evidence.quoteStart,
          quote_end: evidence.quoteEnd,
          chunk_quote_start: evidence.quoteStart,
          chunk_quote_end: evidence.quoteEnd,
          document_start_char: evidence.chunk.start_char + evidence.quoteStart,
          document_end_char: evidence.chunk.start_char + evidence.quoteEnd,
          document_id: args.documentId,
          version_id: args.versionId,
        });
        return `[${ref}]`;
      });
      markdown.push(`- ${point.text} ${refs.join("")}`);
    }
  }
  const citationsBlock = `<CITATIONS>\n${JSON.stringify(citations)}\n</CITATIONS>`;
  const result = {
    preparedText: `${markdown.join("\n\n")}\n\n${citationsBlock}`,
    citations,
    coverage,
  };
  if (cacheKey && failedBatches.length === 0) {
    cacheDocumentSummary(cacheKey, result);
  }
  return result;
}
