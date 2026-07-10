import crypto from "crypto";
import { getAppDb } from "../../db/sqlite";

export const DEFAULT_EMBEDDING_PROVIDER = "ollama";
export const DEFAULT_EMBEDDING_MODEL = "batiai/qwen3-embedding:0.6b";
export const DEFAULT_EMBEDDING_DIMENSIONS_POLICY = "truncate-to-256";
export const DEFAULT_EMBEDDING_MEMORY_PROFILE = "lightweight";

export type EmbeddingProviderId = "ollama" | "openai-compatible";
export type EmbeddingDimensionsPolicy =
  | "native"
  | "truncate-to-256"
  | "truncate-to-512"
  | "provider";
export type EmbeddingMemoryProfile = "lightweight" | "balanced" | "performance";

export type EmbeddingSettings = {
  enabled: boolean;
  provider: EmbeddingProviderId;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  dimensionsPolicy: EmbeddingDimensionsPolicy;
  memoryProfile: EmbeddingMemoryProfile;
};

export type EmbeddingResult = {
  vector: number[];
  dimensions: number;
  normalized: boolean;
};

type ProfileRow = {
  embedding_provider?: string | null;
  embedding_model?: string | null;
  embedding_base_url?: string | null;
  embedding_api_key?: string | null;
  embedding_dimensions_policy?: string | null;
  embedding_enabled?: number | null;
  embedding_memory_profile?: string | null;
};

type EmbedAdapter = {
  embedDocument(text: string, settings: EmbeddingSettings): Promise<number[]>;
  embedQuery(query: string, settings: EmbeddingSettings): Promise<number[]>;
  embedDocumentsBatch?(
    texts: string[],
    settings: EmbeddingSettings,
  ): Promise<number[][]>;
};

let adapterOverride: EmbedAdapter | null = null;

export function setEmbeddingAdapterOverrideForTests(
  adapter: EmbedAdapter | null,
): void {
  adapterOverride = adapter;
}

function providerFrom(value: string | null | undefined): EmbeddingProviderId {
  return value === "openai-compatible" ? "openai-compatible" : "ollama";
}

function dimensionsPolicyFrom(
  value: string | null | undefined,
): EmbeddingDimensionsPolicy {
  if (
    value === "native" ||
    value === "truncate-to-256" ||
    value === "truncate-to-512" ||
    value === "provider"
  ) {
    return value;
  }
  return DEFAULT_EMBEDDING_DIMENSIONS_POLICY;
}

function memoryProfileFrom(
  value: string | null | undefined,
): EmbeddingMemoryProfile {
  if (value === "balanced" || value === "performance") return value;
  return DEFAULT_EMBEDDING_MEMORY_PROFILE;
}

export function readUserEmbeddingSettings(userId?: string | null): EmbeddingSettings {
  let row: ProfileRow | null = null;
  if (userId) {
    try {
      row =
        (getAppDb()
          .prepare(
            `
            SELECT embedding_provider, embedding_model, embedding_base_url,
                   embedding_api_key, embedding_dimensions_policy,
                   embedding_enabled, embedding_memory_profile
            FROM user_profiles
            WHERE user_id = ?
          `,
          )
          .get(userId) as ProfileRow | undefined) ?? null;
    } catch {
      row = null;
    }
  }

  const provider = providerFrom(
    process.env.DOCKET_EMBEDDING_PROVIDER ?? row?.embedding_provider,
  );
  const baseUrl =
    row?.embedding_base_url?.trim() ||
    process.env.DOCKET_EMBEDDING_BASE_URL ||
    (provider === "ollama"
      ? process.env.OLLAMA_BASE_URL || process.env.LOCAL_OLLAMA_BASE_URL || null
      : process.env.OPENAI_COMPATIBLE_BASE_URL || null);

  return {
    enabled:
      (process.env.DOCKET_EMBEDDING_ENABLED ?? String(row?.embedding_enabled ?? 1)) !==
      "0",
    provider,
    model:
      process.env.DOCKET_EMBEDDING_MODEL ||
      row?.embedding_model?.trim() ||
      DEFAULT_EMBEDDING_MODEL,
    baseUrl,
    apiKey:
      row?.embedding_api_key?.trim() ||
      process.env.DOCKET_EMBEDDING_API_KEY ||
      process.env.OPENAI_COMPATIBLE_API_KEY ||
      null,
    dimensionsPolicy: dimensionsPolicyFrom(
      process.env.DOCKET_EMBEDDING_DIMENSIONS_POLICY ??
        row?.embedding_dimensions_policy,
    ),
    memoryProfile: memoryProfileFrom(
      process.env.DOCKET_EMBEDDING_MEMORY_PROFILE ?? row?.embedding_memory_profile,
    ),
  };
}

export function expectedDimensionsForSettings(
  settings: EmbeddingSettings,
): number {
  if (settings.dimensionsPolicy === "truncate-to-256") return 256;
  if (settings.dimensionsPolicy === "truncate-to-512") return 512;
  return 0;
}

export function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function shouldPrefixQuery(settings: EmbeddingSettings): boolean {
  const lower = settings.model.toLowerCase();
  return lower.includes("qwen") && lower.includes("embedding");
}

function queryInput(query: string, settings: EmbeddingSettings): string {
  if (!shouldPrefixQuery(settings)) return query;
  return `Instruct: Retrieve relevant legal document passages.\nQuery: ${query}`;
}

function ollamaBaseUrl(settings: EmbeddingSettings): string {
  return (settings.baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function openAiCompatibleBaseUrl(settings: EmbeddingSettings): string {
  const base = settings.baseUrl || "http://127.0.0.1:8080/v1";
  return base.replace(/\/+$/, "");
}

function keepAliveForProfile(profile: EmbeddingMemoryProfile): string {
  if (profile === "performance") return "10m";
  if (profile === "balanced") return "2m";
  return "30s";
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Embedding request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function ollamaEmbed(input: string, settings: EmbeddingSettings): Promise<number[]> {
  const payload = await postJson<{
    embedding?: number[];
    embeddings?: number[][];
  }>(`${ollamaBaseUrl(settings)}/api/embed`, {
    model: settings.model,
    input,
    keep_alive: keepAliveForProfile(settings.memoryProfile),
  });
  const vector = payload.embedding ?? payload.embeddings?.[0];
  if (!Array.isArray(vector)) {
    throw new Error("Ollama embedding response did not include a vector");
  }
  return vector;
}

async function ollamaEmbedBatch(
  inputs: string[],
  settings: EmbeddingSettings,
): Promise<number[][]> {
  const payload = await postJson<{ embeddings?: number[][] }>(
    `${ollamaBaseUrl(settings)}/api/embed`,
    {
      model: settings.model,
      input: inputs,
      keep_alive: keepAliveForProfile(settings.memoryProfile),
    },
  );
  const vectors = payload.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== inputs.length) {
    throw new Error(
      `Ollama batch embedding returned ${vectors?.length ?? 0} vectors for ${inputs.length} inputs`,
    );
  }
  return vectors;
}

async function openAiCompatibleEmbed(
  input: string,
  settings: EmbeddingSettings,
): Promise<number[]> {
  const headers: Record<string, string> = {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const payload = await postJson<{
    data?: { embedding?: number[] }[];
  }>(
    `${openAiCompatibleBaseUrl(settings)}/embeddings`,
    {
      model: settings.model,
      input,
      ...(settings.dimensionsPolicy === "provider"
        ? { dimensions: expectedDimensionsForSettings(settings) || undefined }
        : {}),
    },
    headers,
  );
  const vector = payload.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error("OpenAI-compatible embedding response did not include a vector");
  }
  return vector;
}

async function openAiCompatibleEmbedBatch(
  inputs: string[],
  settings: EmbeddingSettings,
): Promise<number[][]> {
  const headers: Record<string, string> = {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const payload = await postJson<{
    data?: { embedding?: number[]; index?: number }[];
  }>(
    `${openAiCompatibleBaseUrl(settings)}/embeddings`,
    {
      model: settings.model,
      input: inputs,
      ...(settings.dimensionsPolicy === "provider"
        ? { dimensions: expectedDimensionsForSettings(settings) || undefined }
        : {}),
    },
    headers,
  );
  const data = payload.data ?? [];
  if (data.length !== inputs.length) {
    throw new Error(
      `OpenAI-compatible batch embedding returned ${data.length} vectors for ${inputs.length} inputs`,
    );
  }
  const vectors: number[][] = new Array(inputs.length);
  for (let i = 0; i < data.length; i += 1) {
    const entry = data[i];
    const position =
      typeof entry.index === "number" && entry.index >= 0 && entry.index < inputs.length
        ? entry.index
        : i;
    if (!Array.isArray(entry.embedding)) {
      throw new Error("OpenAI-compatible batch embedding entry did not include a vector");
    }
    vectors[position] = entry.embedding;
  }
  return vectors;
}

function adapterFor(settings: EmbeddingSettings): EmbedAdapter {
  if (adapterOverride) return adapterOverride;
  if (settings.provider === "openai-compatible") {
    return {
      embedDocument: (text) => openAiCompatibleEmbed(text, settings),
      embedQuery: (query) => openAiCompatibleEmbed(queryInput(query, settings), settings),
      embedDocumentsBatch: (texts) => openAiCompatibleEmbedBatch(texts, settings),
    };
  }
  return {
    embedDocument: (text) => ollamaEmbed(text, settings),
    embedQuery: (query) => ollamaEmbed(queryInput(query, settings), settings),
    embedDocumentsBatch: (texts) => ollamaEmbedBatch(texts, settings),
  };
}

function truncateByPolicy(
  vector: number[],
  settings: EmbeddingSettings,
): number[] {
  const target = expectedDimensionsForSettings(settings);
  if (target > 0 && vector.length > target) return vector.slice(0, target);
  return vector;
}

export function normalizeVector(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (!Number.isFinite(length) || length <= 0) return vector.map(() => 0);
  return vector.map((value) => value / length);
}

async function embed(
  input: string,
  settings: EmbeddingSettings,
  kind: "query" | "document",
): Promise<EmbeddingResult> {
  const raw =
    kind === "query"
      ? await adapterFor(settings).embedQuery(input, settings)
      : await adapterFor(settings).embedDocument(input, settings);
  const vector = normalizeVector(truncateByPolicy(raw, settings));
  return { vector, dimensions: vector.length, normalized: true };
}

export function embedDocumentText(
  text: string,
  settings: EmbeddingSettings,
): Promise<EmbeddingResult> {
  return embed(text, settings, "document");
}

export async function embedDocumentTexts(
  texts: string[],
  settings: EmbeddingSettings,
): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];
  const adapter = adapterFor(settings);
  if (!adapter.embedDocumentsBatch) {
    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      results.push(await embed(text, settings, "document"));
    }
    return results;
  }
  const rawVectors = await adapter.embedDocumentsBatch(texts, settings);
  return rawVectors.map((raw) => {
    const vector = normalizeVector(truncateByPolicy(raw, settings));
    return { vector, dimensions: vector.length, normalized: true };
  });
}

export function embedQueryText(
  query: string,
  settings: EmbeddingSettings,
): Promise<EmbeddingResult> {
  return embed(query, settings, "query");
}

export function vectorToBlob(vector: number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

export function blobToVector(blob: Buffer): number[] {
  const vector: number[] = [];
  for (let offset = 0; offset + 3 < blob.length; offset += 4) {
    vector.push(blob.readFloatLE(offset));
  }
  return vector;
}

// Embedding blobs are little-endian Float32 by schema; every supported
// platform (win x64, mac arm64/x64, linux x64/arm64) is little-endian, so a
// Float32Array view decodes them directly and is much faster than per-float
// Buffer reads. Unaligned buffers get copied into an aligned array first.
const PLATFORM_IS_LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function dotProductFromBlob(
  queryVector: ArrayLike<number>,
  blob: Buffer,
): number {
  const length = Math.min(queryVector.length, Math.floor(blob.length / 4));
  let score = 0;
  if (!PLATFORM_IS_LITTLE_ENDIAN) {
    for (let i = 0; i < length; i += 1) {
      score += queryVector[i] * blob.readFloatLE(i * 4);
    }
    return score;
  }
  const view =
    blob.byteOffset % 4 === 0
      ? new Float32Array(blob.buffer, blob.byteOffset, length)
      : new Float32Array(
          blob.buffer.slice(blob.byteOffset, blob.byteOffset + length * 4),
        );
  for (let i = 0; i < length; i += 1) {
    score += queryVector[i] * view[i];
  }
  return score;
}
