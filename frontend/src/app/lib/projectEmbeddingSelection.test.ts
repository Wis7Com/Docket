import assert from "node:assert/strict";
import test from "node:test";
import {
  projectEmbeddingSelections,
  shouldShowProjectEmbeddingWarning,
} from "./projectEmbeddingSelection";

test("project embedding selector includes presets, preserved models, and readiness", () => {
  const selections = projectEmbeddingSelections([
    { model: "batiai/qwen3-embedding:4b", dimensions: 256, ready: 205, total: 205 },
    { model: "custom-embed", dimensions: 256, ready: 7, total: 205 },
  ]);
  assert.deepEqual(selections[0], {
    value: null,
    label: "Default — global model",
    readiness: null,
  });
  assert.equal(selections[1].readiness, "not embedded");
  assert.equal(selections[2].readiness, "205/205");
  assert.deepEqual(selections[3], {
    value: "custom-embed",
    label: "custom-embed",
    readiness: "7/205",
  });
});

test("project embedding warning requires enabled explicit override and incomplete vectors", () => {
  assert.equal(
    shouldShowProjectEmbeddingWarning({
      enabled: true,
      override: "batiai/qwen3-embedding:4b",
      ready_vectors: 7,
      total_vectors: 205,
    }),
    true,
  );
  assert.equal(
    shouldShowProjectEmbeddingWarning({
      enabled: false,
      override: "batiai/qwen3-embedding:4b",
      ready_vectors: 0,
      total_vectors: 205,
    }),
    false,
  );
  assert.equal(
    shouldShowProjectEmbeddingWarning({
      enabled: true,
      override: null,
      ready_vectors: 0,
      total_vectors: 205,
    }),
    false,
  );
  assert.equal(
    shouldShowProjectEmbeddingWarning({
      enabled: true,
      override: "batiai/qwen3-embedding:4b",
      ready_vectors: 205,
      total_vectors: 205,
    }),
    false,
  );
});
