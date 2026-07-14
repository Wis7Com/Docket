import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";
import { classifyDocumentCoverWithLlm } from "../documentClassification.llm";
import { streamChatWithTools } from "./index";
import type { OpenAIToolSchema, UserApiKeys } from "./types";

const enabled = process.env.RUN_LIVE_LLM_SMOKE === "1";

type ProfileKeys = {
  gemini_api_key: string | null;
  openrouter_api_key: string | null;
};

function readProfileKeys(): UserApiKeys {
  const dbPath = process.env.DOCKET_LIVE_PROFILE_DB?.trim();
  assert.ok(dbPath, "DOCKET_LIVE_PROFILE_DB must point to the desktop app.db");
  assert.ok(fs.existsSync(dbPath), `profile database does not exist: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT gemini_api_key, openrouter_api_key
         FROM user_profiles
         WHERE user_id = ?
         LIMIT 1`,
      )
      .get(process.env.DOCKET_LIVE_USER_ID?.trim() || "local-user") as
      | ProfileKeys
      | undefined;
    assert.ok(row, "local user profile was not found");
    return {
      gemini: row.gemini_api_key,
      openrouter: row.openrouter_api_key,
    };
  } finally {
    db.close();
  }
}

function liveProviders() {
  return [
    {
      label: "local Gemma 4 12B",
      model: process.env.DOCKET_LIVE_OLLAMA_MODEL || "ollama:gemma4:12b-mlx",
    },
    {
      label: "Gemini Flash",
      model: process.env.DOCKET_LIVE_GEMINI_MODEL || "gemini-3-flash-preview",
    },
    {
      label: "FreeRouter",
      model:
        process.env.DOCKET_LIVE_FREE_ROUTER_MODEL ||
        "free-router:free-router/best",
    },
    {
      label: "OpenRouter",
      model:
        process.env.DOCKET_LIVE_OPENROUTER_MODEL ||
        "openrouter:openai/gpt-oss-120b",
    },
  ];
}

test(
  "live legal-cover classification works across configured LLM providers",
  { skip: !enabled, timeout: 900_000 },
  async (t) => {
    const apiKeys = readProfileKeys();
    assert.ok(apiKeys.gemini?.trim(), "Gemini credential is not configured");
    assert.ok(apiKeys.openrouter?.trim(), "OpenRouter credential is not configured");

    for (const provider of liveProviders()) {
      await t.test(provider.label, { timeout: 180_000 }, async (providerTest) => {
        const started = Date.now();
        const result = await classifyDocumentCoverWithLlm({
          coverText:
            "DEFENDANT'S MEMORANDUM IN OPPOSITION TO PLAINTIFF'S MOTION FOR SUMMARY JUDGMENT",
          prior: { role: "other", confidence: "low" },
          model: provider.model,
          apiKeys,
        });
        providerTest.diagnostic(
          `${Date.now() - started}ms, ${result.role}/${result.party_role ?? "none"}/${result.confidence}`,
        );
        assert.deepEqual(
          result,
          { role: "brief", party_role: "defendant", confidence: "high" },
          `${provider.label} did not return the expected confident classification`,
        );
      });
    }
  },
);

test(
  "live chat completes a legal tool-call round trip across configured providers",
  { skip: !enabled, timeout: 1_100_000 },
  async (t) => {
    const apiKeys = readProfileKeys();
    const tools: OpenAIToolSchema[] = [
      {
        type: "function",
        function: {
          name: "lookup_contract_term",
          description: "Look up an exact term in the indexed case documents.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ];

    for (const provider of liveProviders()) {
      await t.test(provider.label, { timeout: 240_000 }, async (providerTest) => {
        const started = Date.now();
        let callCount = 0;
        const result = await streamChatWithTools({
          model: provider.model,
          apiKeys,
          systemPrompt:
            "You are a legal case assistant. You must call lookup_contract_term before answering. After receiving its result, answer with the liability cap and no unsupported facts.",
          messages: [
            { role: "user", content: "What is the contractual liability cap?" },
          ],
          tools,
          maxIterations: 3,
          enableThinking: false,
          runTools: async (calls) => {
            callCount += calls.length;
            for (const call of calls) {
              assert.equal(call.name, "lookup_contract_term");
            }
            return calls.map((call) => ({
              tool_use_id: call.id,
              content:
                'Indexed contract clause: "Aggregate liability is capped at USD 100,000."',
            }));
          },
        });
        providerTest.diagnostic(
          `${Date.now() - started}ms, calls=${callCount}, answer=${result.fullText.slice(0, 120)}`,
        );
        assert.ok(callCount > 0, `${provider.label} did not call the required tool`);
        assert.match(
          result.fullText,
          /100[,.\s]?000/,
          `${provider.label} did not use the tool result in its final answer`,
        );
      });
    }
  },
);
