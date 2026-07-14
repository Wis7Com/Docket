import { z } from "zod";
import { completeText, providerForModel, type UserApiKeys } from "./llm";
import {
  PARTY_ROLES,
  docRoleSchema,
  type DocRoleGuess,
  type PartyRole,
} from "./documentClassification";

const responseSchema = z.object({
  role: docRoleSchema,
  party_role: z.string().nullable().optional().default(null),
  confident: z.boolean(),
});

type Complete = typeof completeText;

function normalizePartyRole(value: string | null): PartyRole | null {
  if (!value?.trim()) return null;
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return (
    PARTY_ROLES.find(
      (role) => role.toLocaleLowerCase("en-US") === normalized,
    ) ?? null
  );
}

export type CoverClassification = {
  role: DocRoleGuess["role"];
  party_role: PartyRole | null;
  confidence: "high" | "low";
};

export function classifierModelIsAvailable(
  model: string,
  apiKeys: UserApiKeys,
): boolean {
  const provider = providerForModel(model);
  if (provider === "ollama") {
    // The adapter has a localhost default and the request path already falls
    // back safely when Ollama is not running. Requiring an explicit override
    // here incorrectly disabled installed local models in the normal setup.
    return true;
  }
  if (provider === "gemini") {
    return Boolean(apiKeys.gemini || process.env.GEMINI_API_KEY);
  }
  if (provider === "claude") {
    return Boolean(apiKeys.claude || process.env.ANTHROPIC_API_KEY);
  }
  if (
    model.startsWith("free-router:") ||
    model.startsWith("free-router/") ||
    model === "free-router:auto" ||
    model.startsWith("mlx:") ||
    model.startsWith("mlx/")
  ) {
    // Both adapters use a local endpoint with a non-secret local token.
    return true;
  }
  if (model.startsWith("openrouter:") || model.startsWith("openrouter/")) {
    return Boolean(apiKeys.openrouter || process.env.OPENROUTER_API_KEY);
  }
  if (model.startsWith("nvidia:") || model.startsWith("nvidia/")) {
    return Boolean(apiKeys.nvidia || process.env.NVIDIA_API_KEY);
  }
  if (model.startsWith("openai:") || model.startsWith("openai/")) {
    return Boolean(apiKeys.openai || process.env.OPENAI_API_KEY);
  }
  if (model.startsWith("openai-compatible:")) {
    return Boolean(
      apiKeys.openaiCompatibleBaseUrl ||
        apiKeys.openaiCompatible ||
        process.env.OPENAI_COMPATIBLE_BASE_URL ||
        process.env.OPENAI_COMPATIBLE_API_KEY,
    );
  }
  return false;
}

export async function classifyDocumentCoverWithLlm(args: {
  coverText: string;
  prior: DocRoleGuess;
  model: string;
  apiKeys: UserApiKeys;
  complete?: Complete;
}): Promise<CoverClassification> {
  const coverText = args.coverText.trim().slice(0, 1_500);
  if (
    coverText.length < 10 ||
    !classifierModelIsAvailable(args.model, args.apiKeys)
  ) {
    return {
      role: args.prior.role,
      party_role: null,
      confidence: args.prior.confidence,
    };
  }

  try {
    const raw = await (args.complete ?? completeText)({
      model: args.model,
      apiKeys: args.apiKeys,
      // OpenAI-compatible reasoning models count hidden reasoning against the
      // completion budget. A 120-token cap can end before they emit any JSON.
      maxTokens:
        providerForModel(args.model) === "openai-compatible" ? 640 : 120,
      systemPrompt:
        "Classify the first page of a legal document across any language or jurisdiction. Return JSON only.",
      user:
        'Return {"role":"brief|evidence|other","party_role":null|string,"confident":boolean}. ' +
        "A brief is a substantive pleading or written argument; evidence is an exhibit or discovery material. " +
        "Use only an allowed actual party designation when clear.\n\n" +
        coverText,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("classification response did not contain JSON");
    const parsed = responseSchema.parse(JSON.parse(match[0]));
    if (!parsed.confident) {
      return {
        role: args.prior.role,
        party_role: null,
        confidence: args.prior.confidence,
      };
    }
    return {
      role: parsed.role,
      party_role: normalizePartyRole(parsed.party_role),
      confidence: "high",
    };
  } catch {
    return {
      role: args.prior.role,
      party_role: null,
      confidence: args.prior.confidence,
    };
  }
}
