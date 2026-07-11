import test from "node:test";
import assert from "node:assert/strict";
import { createLocalOcrEngine } from ".";
import type { OcrMode, OcrSettings } from "./types";

function settings(mode: OcrMode): OcrSettings {
  return {
    enabled: true,
    mode,
    engine: "paddle",
    languages: "auto",
    maxPagesPerDocument: 50,
    gpuEndpoint: "http://localhost:8000",
    externalProvider: "must-not-be-called",
  };
}

test("Tier 2/3 settings still resolve only to the Tier 1 local engine", () => {
  assert.equal(createLocalOcrEngine(settings("local_cpu")).name, "paddle-ppocrv5");
  assert.equal(createLocalOcrEngine(settings("local_gpu")).name, "paddle-ppocrv5");
  assert.equal(createLocalOcrEngine(settings("external_api")).name, "paddle-ppocrv5");
});
