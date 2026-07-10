import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import {
  completeOpenAICompatibleText,
  streamOpenAICompatible,
} from "./openaiCompatible";
import { completeOllamaText, streamOllama } from "./ollama";
import { providerForModel } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";

export async function streamChatWithTools(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const provider = providerForModel(params.model);
  if (provider === "claude") return streamClaude(params);
  if (provider === "gemini") return streamGemini(params);
  if (provider === "ollama") return streamOllama(params);
  return streamOpenAICompatible(params);
}

export async function completeText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
}): Promise<string> {
  const provider = providerForModel(params.model);
  if (provider === "claude") return completeClaudeText(params);
  if (provider === "gemini") return completeGeminiText(params);
  if (provider === "ollama") return completeOllamaText(params);
  return completeOpenAICompatibleText(params);
}
