import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDocumentCoverWithLlm,
  classifierModelIsAvailable,
} from "./documentClassification.llm";

test("cover classifier parses a confident JSON-only response", async () => {
  const prior = { role: "other" as const, confidence: "low" as const };
  const priorKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only";
  try {
    let prompt = "";
    const result = await classifyDocumentCoverWithLlm({
      coverText: "Schriftsatz der Antragstellerin zur Begründung des Antrags",
      prior,
      model: "gemini-3.1-flash-lite-preview",
      apiKeys: {},
      complete: async (args) => {
        prompt = args.user;
        return '{"role":"brief","party_role":null,"confident":true}';
      },
    });
    assert.match(prompt, /Schriftsatz/);
    assert.deepEqual(result, {
      role: "brief",
      party_role: null,
      confidence: "high",
    });
  } finally {
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
  }
});

test("cover classifier normalizes English party-role casing", async () => {
  const priorKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only";
  try {
    const result = await classifyDocumentCoverWithLlm({
      coverText: "DEFENDANT'S MEMORANDUM IN OPPOSITION",
      prior: { role: "other", confidence: "low" },
      model: "gemini-3.1-flash-lite-preview",
      apiKeys: {},
      complete: async () =>
        '{"role":"brief","party_role":"Defendant","confident":true}',
    });
    assert.deepEqual(result, {
      role: "brief",
      party_role: "defendant",
      confidence: "high",
    });
  } finally {
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
  }
});

test("cover classifier keeps the prior guess when no provider is available", async () => {
  const prior = { role: "other" as const, confidence: "low" as const };
  const priorKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  let called = false;
  try {
    const result = await classifyDocumentCoverWithLlm({
      coverText: "Unclassified legal cover text that is long enough",
      prior,
      model: "gemini-3.1-flash-lite-preview",
      apiKeys: {},
      complete: async () => {
        called = true;
        return "{}";
      },
    });
    assert.equal(called, false);
    assert.equal(result.role, "other");
    assert.equal(result.confidence, "low");
  } finally {
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
  }
});

test("cover classifier checks credentials for the requested remote provider", () => {
  const names = [
    "OPENROUTER_API_KEY",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_COMPATIBLE_BASE_URL",
  ] as const;
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    assert.equal(
      classifierModelIsAvailable("openrouter:openai/gpt-oss-120b", {
        openai: "unrelated-openai-key",
      }),
      false,
    );
    assert.equal(
      classifierModelIsAvailable("openrouter:openai/gpt-oss-120b", {
        openrouter: "openrouter-key",
      }),
      true,
    );
    assert.equal(
      classifierModelIsAvailable("openai-compatible:local-model", {
        openaiCompatibleBaseUrl: "http://127.0.0.1:9000/v1",
      }),
      true,
    );
  } finally {
    for (const name of names) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

for (const model of [
  "ollama:gemma4:12b-mlx",
  "free-router:free-router/best",
] as const) {
  test(`cover classifier attempts an available local provider: ${model}`, async () => {
    let called = false;
    let maxTokens: number | undefined;
    const result = await classifyDocumentCoverWithLlm({
      coverText: "DEFENDANT'S MEMORANDUM IN OPPOSITION TO PLAINTIFF'S MOTION",
      prior: { role: "other", confidence: "low" },
      model,
      apiKeys: {},
      complete: async (args) => {
        called = true;
        maxTokens = args.maxTokens;
        return '{"role":"brief","party_role":"defendant","confident":true}';
      },
    });

    assert.equal(called, true);
    assert.equal(
      maxTokens,
      model.startsWith("free-router:") ? 640 : 120,
    );
    assert.deepEqual(result, {
      role: "brief",
      party_role: "defendant",
      confidence: "high",
    });
  });
}
