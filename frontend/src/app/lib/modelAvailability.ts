import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider =
  | "local"
  | "router"
  | "openai"
  | "openai-compatible"
  | "claude"
  | "gemini";

export function getModelProvider(modelId: string): ModelProvider | null {
  if (modelId.startsWith("openai-compatible:")) return "openai-compatible";
  const model = MODELS.find((m) => m.id === modelId);
  if (!model) return null;
  if (model.group === "Local") return "local";
  if (model.group === "Router") return "router";
  if (model.group === "OpenAI") return "openai";
  if (model.group === "OpenAI-compatible") return "openai-compatible";
  return model.group === "Anthropic" ? "claude" : "gemini";
}

export function isLocalhostUrl(url: string | null | undefined): boolean {
  const value = url?.trim();
  if (!value) return false;
  try {
    const hasProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    const candidate = hasProtocol
      ? value
      : value.startsWith("::1")
        ? `http://[::1]${value.slice("::1".length)}`
        : `http://${value}`;
    const parsed = new URL(candidate);
    return ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function isGpuBoundModel(
  modelId: string,
  opts: { openaiCompatibleBaseUrl?: string | null },
): boolean {
  const provider = getModelProvider(modelId);
  if (provider === "local") return true;
  return provider === "openai-compatible" && isLocalhostUrl(opts.openaiCompatibleBaseUrl);
}

export function isModelAvailable(
  modelId: string,
  apiKeys: {
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiApiKey?: string | null;
    openrouterApiKey?: string | null;
    nvidiaApiKey?: string | null;
    openaiCompatibleApiKey?: string | null;
    openaiCompatibleBaseUrl?: string | null;
  },
): boolean {
  if (
    modelId !== "free-router:auto" &&
    (modelId.startsWith("free-router:") || modelId.startsWith("free-router/"))
  )
    return true;
  const provider = getModelProvider(modelId);
  if (!provider) return false;
  if (provider === "local") return true;
  if (provider === "router") {
    return !!apiKeys.openrouterApiKey?.trim() || !!apiKeys.nvidiaApiKey?.trim();
  }
  if (provider === "openai") return !!apiKeys.openaiApiKey?.trim();
  if (provider === "openai-compatible") {
    return !!apiKeys.openaiCompatibleBaseUrl?.trim();
  }
  return provider === "claude"
    ? !!apiKeys.claudeApiKey?.trim()
    : !!apiKeys.geminiApiKey?.trim();
}

export function isProviderAvailable(
  provider: ModelProvider,
  apiKeys: {
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiApiKey?: string | null;
    openrouterApiKey?: string | null;
    nvidiaApiKey?: string | null;
    openaiCompatibleApiKey?: string | null;
    openaiCompatibleBaseUrl?: string | null;
  },
): boolean {
  if (provider === "local") return true;
  if (provider === "router") {
    return !!apiKeys.openrouterApiKey?.trim() || !!apiKeys.nvidiaApiKey?.trim();
  }
  if (provider === "openai") return !!apiKeys.openaiApiKey?.trim();
  if (provider === "openai-compatible") {
    return !!apiKeys.openaiCompatibleBaseUrl?.trim();
  }
  return provider === "claude"
    ? !!apiKeys.claudeApiKey?.trim()
    : !!apiKeys.geminiApiKey?.trim();
}

export function providerLabel(provider: ModelProvider): string {
  if (provider === "local") return "Local model";
  if (provider === "router") return "Free Router / API router";
  if (provider === "openai") return "OpenAI";
  if (provider === "openai-compatible") return "OpenAI-compatible endpoint";
  return provider === "claude" ? "Anthropic (Claude)" : "Google (Gemini)";
}

export function modelGroupToProvider(
  group: ModelOption["group"],
): ModelProvider {
  if (group === "Local") return "local";
  if (group === "Router") return "router";
  if (group === "OpenAI") return "openai";
  if (group === "OpenAI-compatible") return "openai-compatible";
  return group === "Anthropic" ? "claude" : "gemini";
}
