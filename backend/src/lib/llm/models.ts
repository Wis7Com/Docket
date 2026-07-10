import type { Provider } from "./types";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
] as const;
export const GEMINI_MAIN_MODELS = [
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
] as const;

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = ["claude-sonnet-4-6"] as const;
export const GEMINI_MID_MODELS = ["gemini-3-flash-preview"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;
export const OLLAMA_MAIN_MODELS = [
  "ollama:gemma4:31b-it-q4_K_M",
  "ollama:gemma4:12b-mlx",
  "ollama:gemma4:26b-a4b-it-q4_K_M",
  "ollama:gemma4:26b-claude-32k",
  "ollama:gemma4:26b-claude-64k",
] as const;
export const OPENAI_COMPATIBLE_MAIN_MODELS = [
  "openai:gpt-4o-mini",
  "mlx:mlx-community/gemma-4-26b-a4b-it-4bit",
  "mlx:mlx-community/Qwen3.6-35B-A3B-4bit",
  "free-router:free-router/best",
  "free-router:auto",
  "openrouter:openai/gpt-oss-120b",
  "nvidia:deepseek-ai/deepseek-v4-pro",
] as const;

export const DEFAULT_MAIN_MODEL = "gemini-3-flash-preview";
export const DEFAULT_TITLE_MODEL = "gemini-3.1-flash-lite-preview";
export const DEFAULT_TABULAR_MODEL = "gemini-3-flash-preview";

const ALL_MODELS = new Set<string>([
  ...CLAUDE_MAIN_MODELS,
  ...GEMINI_MAIN_MODELS,
  ...CLAUDE_MID_MODELS,
  ...GEMINI_MID_MODELS,
  ...CLAUDE_LOW_MODELS,
  ...GEMINI_LOW_MODELS,
  ...OLLAMA_MAIN_MODELS,
  ...OPENAI_COMPATIBLE_MAIN_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
  if (model.startsWith("claude")) return "claude";
  if (model.startsWith("gemini")) return "gemini";
  if (model.startsWith("ollama:") || model.startsWith("ollama/"))
    return "ollama";
  if (
    model.startsWith("openai:") ||
    model.startsWith("openai/") ||
    model.startsWith("openrouter:") ||
    model.startsWith("openrouter/") ||
    model.startsWith("nvidia:") ||
    model.startsWith("nvidia/") ||
    model.startsWith("free-router:") ||
    model.startsWith("free-router/") ||
    model.startsWith("openai-compatible:") ||
    model.startsWith("mlx:") ||
    model.startsWith("mlx/") ||
    model === "free-router:auto"
  ) {
    return "openai-compatible";
  }
  throw new Error(`Unknown model id: ${model}`);
}

export function resolveModel(
  id: string | null | undefined,
  fallback: string,
): string {
  if (id && ALL_MODELS.has(id)) return id;
  if (id) {
    try {
      providerForModel(id);
      return id;
    } catch {
      // fall through to fallback
    }
  }
  return fallback;
}
