import assert from "node:assert/strict";
import test from "node:test";
import { resolveTitleModel } from "./userSettings";

test("title model uses local Gemma only when local title routing is configured", () => {
  const envNames = [
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "NVIDIA_API_KEY",
    "FREE_ROUTER_TITLE_MODEL",
    "FREE_ROUTER_MODEL",
    "OLLAMA_TITLE_MODEL",
  ] as const;
  const prior = Object.fromEntries(
    envNames.map((name) => [name, process.env[name]]),
  );
  for (const name of envNames) delete process.env[name];

  try {
    assert.equal(resolveTitleModel({}), "gemini-3.1-flash-lite-preview");
    process.env.OLLAMA_TITLE_MODEL = "ollama:gemma4:12b-mlx";
    assert.equal(resolveTitleModel({}), "ollama:gemma4:12b-mlx");
  } finally {
    for (const name of envNames) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
