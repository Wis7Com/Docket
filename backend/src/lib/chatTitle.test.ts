import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeGeneratedChatTitle } from "./chatTitle";

const fallback = "What does the indemnity clause say about termination?";

test("generated chat titles keep concise answers and reject model reasoning", () => {
  assert.equal(
    sanitizeGeneratedChatTitle("Indemnity Survival After Termination", fallback),
    "Indemnity Survival After Termination",
  );
  assert.equal(
    sanitizeGeneratedChatTitle(
      "<think>I need a short title.</think>Indemnity Survival",
      fallback,
    ),
    "Indemnity Survival",
  );
  assert.equal(
    sanitizeGeneratedChatTitle("We need to generate a concise title", fallback),
    fallback.slice(0, 60),
  );
  assert.equal(
    sanitizeGeneratedChatTitle("Reasoning only without an answer</think>", fallback),
    fallback.slice(0, 60),
  );
});
