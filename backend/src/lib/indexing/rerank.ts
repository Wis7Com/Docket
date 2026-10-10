/**
 * Cross-encoder reranking of hybrid search candidates.
 *
 * The first retrieval stage (FTS5 + trigram + embeddings, fused with RRF) is
 * recall-oriented: it is good at getting the right passage somewhere into the
 * top few dozen, less good at putting it first. A small cross-encoder that
 * reads query and passage together is far better at that final ordering, so
 * the fused head is re-scored with Qwen3-Reranker before results are cut to
 * the caller's limit. The cost grows with the number of candidates scored,
 * which is why the depth is a user setting.
 *
 * Contract for callers: `rerankResults` never throws and never drops a row.
 * On any failure (no server, timeout, bad response) the input order is
 * returned unchanged with `reranked: false`, so search quality can only fall
 * back to the hybrid ranking, never below it.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { getAppDb } from "../../db/sqlite";
import {
  DEFAULT_RERANK_IDLE_SECONDS,
  findLlamaServerBinary,
  rerankServerManager,
  resolveRerankModelPath,
  type RerankServerManager,
  type RerankServerStatus,
} from "./rerankServer";

export const DEFAULT_RERANK_DEPTH = 30;
export const RERANK_DEPTH_CHOICES = [20, 30, 50] as const;
export const DEFAULT_RERANK_TIMEOUT_MS = 60_000;
const MIN_RERANK_DEPTH = 5;
const MAX_RERANK_DEPTH = 200;
const SCORE_CACHE_MAX_ENTRIES = 20_000;

export type RerankSettings = {
  /** True only when a user has not turned it off AND a scorer is reachable. */
  enabled: boolean;
  /** The user's preference before availability is considered. */
  preference: boolean | null;
  depth: number;
  /** External `/v1/rerank` server. When set, no sidecar is spawned. */
  baseUrl: string | null;
  modelPath: string | null;
  binaryPath: string | null;
  timeoutMs: number;
  idleSeconds: number;
};

export type RerankStatus = {
  enabled: boolean;
  preference: boolean | null;
  depth: number;
  binary: "found" | "missing" | "not_needed";
  model: "found" | "missing" | "not_needed";
  server: RerankServerStatus | "external";
  base_url: string | null;
  model_path: string | null;
  binary_path: string | null;
  idle_seconds: number;
  last_error: string | null;
};

export type RerankOutcome<T> = {
  rows: T[];
  reranked: boolean;
  /** Wall time of the whole call, including a cold sidecar start. */
  ms: number;
  /** Number of candidates sent to the scorer (cache hits excluded). */
  scored: number;
};

type RerankableRow = {
  chunk_id: string;
  content: string;
  match_reasons?: string[];
  rerank_score?: number | null;
};

type ProfileRow = {
  reranker_enabled: number | boolean | null;
  reranker_depth: number | null;
  reranker_base_url: string | null;
  reranker_model_path: string | null;
};

type RerankApiResponse = {
  results?: { index?: unknown; relevance_score?: unknown }[];
};

function parseBooleanFlag(value: string | undefined): boolean | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseDepth(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isInteger(parsed)) return null;
  if (parsed < MIN_RERANK_DEPTH || parsed > MAX_RERANK_DEPTH) return null;
  return parsed;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readProfileRow(userId?: string | null): ProfileRow | null {
  if (!userId) return null;
  try {
    return (
      (getAppDb()
        .prepare(
          `
          SELECT reranker_enabled, reranker_depth, reranker_base_url, reranker_model_path
          FROM user_profiles
          WHERE user_id = ?
        `,
        )
        .get(userId) as ProfileRow | undefined) ?? null
    );
  } catch {
    // Columns arrive with migration 025; an older database simply has no
    // preference yet.
    return null;
  }
}

/**
 * Precedence: environment → user profile → defaults. The default is "on when
 * usable": a user who has not installed llama.cpp or the model file sees the
 * exact pre-reranker behaviour, with no warnings per search.
 */
export function resolveRerankSettings(
  userId?: string | null,
  manager: RerankServerManager = rerankServerManager,
): RerankSettings {
  const row = readProfileRow(userId);
  const preference =
    parseBooleanFlag(process.env.DOCKET_RERANK_ENABLED) ??
    (row?.reranker_enabled == null ? null : Boolean(row.reranker_enabled));
  const depth =
    parseDepth(process.env.DOCKET_RERANK_DEPTH) ??
    parseDepth(row?.reranker_depth) ??
    DEFAULT_RERANK_DEPTH;
  const baseUrl =
    process.env.DOCKET_RERANK_BASE_URL?.trim() ||
    row?.reranker_base_url?.trim() ||
    null;
  const modelPath = baseUrl
    ? null
    : resolveRerankModelPath(
        process.env.DOCKET_RERANK_MODEL?.trim() ||
          row?.reranker_model_path?.trim() ||
          null,
      );
  const binaryPath = baseUrl
    ? null
    : findLlamaServerBinary(process.env.DOCKET_RERANK_BINARY);
  const timeoutMs =
    parsePositiveInt(process.env.DOCKET_RERANK_TIMEOUT_MS) ??
    DEFAULT_RERANK_TIMEOUT_MS;
  const idleSeconds =
    parsePositiveInt(process.env.DOCKET_RERANK_IDLE_SECONDS) ??
    DEFAULT_RERANK_IDLE_SECONDS;

  const reachable = baseUrl
    ? true
    : Boolean(modelPath && binaryPath) && !manager.isDisabled();
  const enabled = preference !== false && reachable;

  return {
    enabled,
    preference,
    depth,
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/, "") : null,
    modelPath,
    binaryPath,
    timeoutMs,
    idleSeconds,
  };
}

export function getRerankStatus(
  userId?: string | null,
  manager: RerankServerManager = rerankServerManager,
): RerankStatus {
  const settings = resolveRerankSettings(userId, manager);
  const state = manager.getState();
  return {
    enabled: settings.enabled,
    preference: settings.preference,
    depth: settings.depth,
    binary: settings.baseUrl
      ? "not_needed"
      : settings.binaryPath
        ? "found"
        : "missing",
    model: settings.baseUrl
      ? "not_needed"
      : settings.modelPath
        ? "found"
        : "missing",
    server: settings.baseUrl ? "external" : state.status,
    base_url: settings.baseUrl,
    model_path: settings.modelPath,
    binary_path: settings.binaryPath,
    idle_seconds: settings.idleSeconds,
    last_error: state.lastError,
  };
}

// ---------------------------------------------------------------------------
// Score cache
// ---------------------------------------------------------------------------

class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxEntries: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

const scoreCache = new LruCache<string, number>(SCORE_CACHE_MAX_ENTRIES);

export function clearRerankScoreCache(): void {
  scoreCache.clear();
}

export function rerankScoreCacheSize(): number {
  return scoreCache.size;
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

/**
 * The instruction is baked into the GGUF, so the model file identity (path +
 * mtime) doubles as the instruction version. An external server is identified
 * by its URL.
 */
function modelIdentity(settings: RerankSettings): string {
  if (settings.baseUrl) return `url:${settings.baseUrl}`;
  if (!settings.modelPath) return "none";
  try {
    const stat = fs.statSync(settings.modelPath);
    return `file:${settings.modelPath}:${Math.round(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return `file:${settings.modelPath}`;
  }
}

function cacheKey(
  model: string,
  queryHash: string,
  row: RerankableRow,
): string {
  return `${model}|${queryHash}|${row.chunk_id}|${sha1(row.content)}`;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

async function fetchScores(args: {
  baseUrl: string;
  query: string;
  documents: string[];
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await args.fetchImpl(`${args.baseUrl}/v1/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: args.query,
        documents: args.documents,
        top_n: args.documents.length,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`rerank server returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as RerankApiResponse;
    if (!Array.isArray(payload.results)) {
      throw new Error("rerank server response has no results array");
    }
    const scores = new Array<number>(args.documents.length).fill(
      Number.NEGATIVE_INFINITY,
    );
    let filled = 0;
    for (const item of payload.results) {
      const index = typeof item.index === "number" ? item.index : -1;
      const score =
        typeof item.relevance_score === "number" ? item.relevance_score : null;
      if (index < 0 || index >= scores.length || score === null) continue;
      scores[index] = score;
      filled += 1;
    }
    if (filled !== args.documents.length) {
      throw new Error(
        `rerank server scored ${filled} of ${args.documents.length} documents`,
      );
    }
    return scores;
  } finally {
    clearTimeout(timer);
  }
}

export type RerankOptions = {
  depth?: number;
  settings?: RerankSettings;
  userId?: string | null;
  manager?: RerankServerManager;
  fetchImpl?: typeof fetch;
  warn?: (message: string) => void;
};

/**
 * Re-scores the first `depth` rows with the cross-encoder and reorders them by
 * descending relevance (stable for ties). Rows beyond `depth` keep their
 * original relative order behind the reranked head.
 */
export async function rerankResults<T extends RerankableRow>(
  query: string,
  rows: readonly T[],
  options: RerankOptions = {},
): Promise<RerankOutcome<T>> {
  const started = performance.now();
  const warn =
    options.warn ?? ((message: string) => console.warn(`[rerank] ${message}`));
  const manager = options.manager ?? rerankServerManager;
  const unchanged = (scored = 0): RerankOutcome<T> => ({
    rows: [...rows],
    reranked: false,
    ms: performance.now() - started,
    scored,
  });

  try {
    const settings =
      options.settings ?? resolveRerankSettings(options.userId, manager);
    if (!settings.enabled) return unchanged();
    const depth = Math.max(1, options.depth ?? settings.depth);
    const trimmedQuery = query.trim();
    if (!trimmedQuery || rows.length === 0) return unchanged();

    const head = rows.slice(0, depth);
    const tail = rows.slice(depth);
    const model = modelIdentity(settings);
    const queryHash = sha1(trimmedQuery);
    const keys = head.map((row) => cacheKey(model, queryHash, row));
    const scores: (number | undefined)[] = keys.map((key) =>
      scoreCache.get(key),
    );
    const missing = scores
      .map((score, index) => (score === undefined ? index : -1))
      .filter((index) => index >= 0);

    if (missing.length > 0) {
      let baseUrl = settings.baseUrl;
      if (!baseUrl) {
        if (!settings.modelPath || !settings.binaryPath) return unchanged();
        const handle = await manager.ensure({
          binaryPath: settings.binaryPath,
          modelPath: settings.modelPath,
          idleSeconds: settings.idleSeconds,
        });
        if (!handle) return unchanged();
        baseUrl = handle.baseUrl;
      }
      const usingSidecar = !settings.baseUrl;
      if (usingSidecar) manager.beginRequest();
      let fetched: number[];
      try {
        fetched = await fetchScores({
          baseUrl,
          query: trimmedQuery,
          documents: missing.map((index) => head[index].content),
          timeoutMs: settings.timeoutMs,
          fetchImpl: options.fetchImpl ?? fetch,
        });
      } finally {
        if (usingSidecar) manager.endRequest();
      }
      if (usingSidecar) manager.markUsed();
      missing.forEach((headIndex, position) => {
        scores[headIndex] = fetched[position];
        scoreCache.set(keys[headIndex], fetched[position]);
      });
    }

    const rerankedHead = head
      .map((row, index) => ({ row, index, score: scores[index] as number }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ row, score }) => ({
        ...row,
        rerank_score: score,
        match_reasons: appendReason(row.match_reasons, "rerank"),
      }));

    return {
      rows: [...rerankedHead, ...tail],
      reranked: true,
      ms: performance.now() - started,
      scored: missing.length,
    };
  } catch (err) {
    warn(
      `falling back to hybrid order: ${err instanceof Error ? err.message : String(err)}`,
    );
    return unchanged();
  }
}

function appendReason<R extends string[] | undefined>(
  reasons: R,
  reason: string,
): R {
  if (!Array.isArray(reasons)) return reasons;
  if (reasons.includes(reason)) return reasons;
  return [...reasons, reason] as unknown as R;
}
