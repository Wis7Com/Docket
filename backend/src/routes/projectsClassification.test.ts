import assert from "node:assert/strict";
import test from "node:test";
import { parseBriefSequenceClassificationOverride } from "./projects";

test("classification PATCH brief sequence override accepts positive integers or null", () => {
  assert.equal(parseBriefSequenceClassificationOverride(1), 1);
  assert.equal(parseBriefSequenceClassificationOverride(245), 245);
  assert.equal(parseBriefSequenceClassificationOverride(null), null);

  for (const value of [0, -1, 1.5, "2", undefined]) {
    assert.equal(parseBriefSequenceClassificationOverride(value), undefined);
  }
});
