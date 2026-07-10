import { createServerSupabase } from "./supabase";
import { getAppDb } from "../db/sqlite";
import {
  resolveModel,
  DEFAULT_TITLE_MODEL,
  DEFAULT_TABULAR_MODEL,
  type UserApiKeys,
} from "./llm";

export type UserModelSettings = {
  title_model: string;
  tabular_model: string;
  api_keys: UserApiKeys;
};

export type UserRetrievalSettings = {
  chat_full_read_max_docs: number;
  chat_full_read_max_text_bytes: number;
  chat_fetch_max_docs: number;
  chat_fetch_max_text_bytes: number;
};

type UserProfileSettingsRow = {
  tabular_model?: string | null;
  claude_api_key?: string | null;
  gemini_api_key?: string | null;
  openai_api_key?: string | null;
  openrouter_api_key?: string | null;
  nvidia_api_key?: string | null;
  openai_compatible_api_key?: string | null;
  openai_compatible_base_url?: string | null;
  chat_full_read_max_docs?: number | null;
  chat_full_read_max_text_bytes?: number | null;
  chat_fetch_max_docs?: number | null;
  chat_fetch_max_text_bytes?: number | null;
};

// Title generation is a lightweight task. Prefer Gemini's free-tier friendly
// Flash Lite when configured, then free-router/API options, then local fallback.
function resolveTitleModel(apiKeys: UserApiKeys): string {
  if (apiKeys.gemini?.trim() || process.env.GEMINI_API_KEY)
    return DEFAULT_TITLE_MODEL;
  if (process.env.FREE_ROUTER_TITLE_MODEL || process.env.FREE_ROUTER_MODEL) {
    return (
      process.env.FREE_ROUTER_TITLE_MODEL || process.env.FREE_ROUTER_MODEL!
    );
  }
  if (apiKeys.openrouter?.trim() || process.env.OPENROUTER_API_KEY) {
    return "free-router:auto";
  }
  if (apiKeys.nvidia?.trim() || process.env.NVIDIA_API_KEY) {
    return "free-router:auto";
  }
  if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
  if (process.env.OLLAMA_BASE_URL || process.env.LOCAL_OLLAMA_BASE_URL) {
    return "ollama:gemma4:26b-a4b-it-q4_K_M";
  }
  return DEFAULT_TITLE_MODEL;
}

function envFallback(
  value: string | null | undefined,
  envName: string,
): string | null {
  return value?.trim() || process.env[envName] || null;
}

function readAppProfile(userId: string): UserProfileSettingsRow | null {
  return (
    (getAppDb()
      .prepare(
        `
        SELECT tabular_model, claude_api_key, gemini_api_key, openai_api_key,
               openrouter_api_key, nvidia_api_key, openai_compatible_api_key,
               openai_compatible_base_url, chat_full_read_max_docs,
               chat_full_read_max_text_bytes, chat_fetch_max_docs,
               chat_fetch_max_text_bytes
        FROM user_profiles
        WHERE user_id = ?
      `,
      )
      .get(userId) as UserProfileSettingsRow | undefined) ?? null
  );
}

export async function getUserModelSettings(
  userId: string,
  _db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
  const data = readAppProfile(userId);

  const api_keys: UserApiKeys = {
    claude: envFallback(data?.claude_api_key, "ANTHROPIC_API_KEY"),
    gemini: envFallback(data?.gemini_api_key, "GEMINI_API_KEY"),
    openai: envFallback(data?.openai_api_key, "OPENAI_API_KEY"),
    openrouter: envFallback(data?.openrouter_api_key, "OPENROUTER_API_KEY"),
    nvidia: envFallback(data?.nvidia_api_key, "NVIDIA_API_KEY"),
    openaiCompatible: envFallback(
      data?.openai_compatible_api_key,
      "OPENAI_COMPATIBLE_API_KEY",
    ),
    openaiCompatibleBaseUrl:
      data?.openai_compatible_base_url ??
      process.env.OPENAI_COMPATIBLE_BASE_URL ??
      null,
  };

  return {
    title_model: resolveTitleModel(api_keys),
    tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
    api_keys,
  };
}

export async function getUserApiKeys(
  userId: string,
  _db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
  const data = readAppProfile(userId);
  return {
    claude: envFallback(data?.claude_api_key, "ANTHROPIC_API_KEY"),
    gemini: envFallback(data?.gemini_api_key, "GEMINI_API_KEY"),
    openai: envFallback(data?.openai_api_key, "OPENAI_API_KEY"),
    openrouter: envFallback(data?.openrouter_api_key, "OPENROUTER_API_KEY"),
    nvidia: envFallback(data?.nvidia_api_key, "NVIDIA_API_KEY"),
    openaiCompatible: envFallback(
      data?.openai_compatible_api_key,
      "OPENAI_COMPATIBLE_API_KEY",
    ),
    openaiCompatibleBaseUrl:
      data?.openai_compatible_base_url ??
      process.env.OPENAI_COMPATIBLE_BASE_URL ??
      null,
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function getUserRetrievalSettings(
  userId: string,
  _db?: ReturnType<typeof createServerSupabase>,
): Promise<UserRetrievalSettings> {
  const data = readAppProfile(userId);
  return {
    chat_full_read_max_docs: positiveInt(data?.chat_full_read_max_docs, 20),
    chat_full_read_max_text_bytes: positiveInt(
      data?.chat_full_read_max_text_bytes,
      300_000,
    ),
    chat_fetch_max_docs: positiveInt(data?.chat_fetch_max_docs, 3),
    chat_fetch_max_text_bytes: positiveInt(
      data?.chat_fetch_max_text_bytes,
      300_000,
    ),
  };
}
