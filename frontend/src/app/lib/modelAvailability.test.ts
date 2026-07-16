import assert from "node:assert/strict";
import test from "node:test";
import { isGpuBoundModel, isLocalhostUrl } from "./modelAvailability";

test("localhost URL detection accepts loopback hosts with paths and ports", () => {
  for (const url of [
    "localhost:11434/v1",
    "http://127.0.0.1:8080/v1",
    "http://0.0.0.0:8000",
    "::1",
    "[::1]:8000/v1",
    "http://[::1]:8000/v1",
  ]) {
    assert.equal(isLocalhostUrl(url), true, url);
  }
  for (const url of ["https://api.example.com/v1", "", "not a url"] as const) {
    assert.equal(isLocalhostUrl(url), false, url);
  }
});

test("GPU-bound classification separates local and remote providers", () => {
  assert.equal(isGpuBoundModel("ollama:gemma4:31b-it-q4_K_M", {}), true);
  assert.equal(isGpuBoundModel("claude-sonnet-4-6", {}), false);
  assert.equal(isGpuBoundModel("openai:gpt-4o-mini", {}), false);
  assert.equal(isGpuBoundModel("free-router:dynamic", {}), false);
  assert.equal(isGpuBoundModel("openai-compatible:local-model", { openaiCompatibleBaseUrl: "localhost:8080/v1" }), true);
  assert.equal(isGpuBoundModel("openai-compatible:remote-model", { openaiCompatibleBaseUrl: "https://api.example.com/v1" }), false);
});
