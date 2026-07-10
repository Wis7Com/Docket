import test from "node:test";
import assert from "node:assert/strict";
import {
  findWorkflowMention,
  removeWorkflowMention,
} from "./workflowMentions";

test("findWorkflowMention recognizes @ at the start or after whitespace", () => {
  assert.deepEqual(findWorkflowMention("@sum", 4), {
    start: 0,
    end: 4,
    query: "sum",
  });
  assert.deepEqual(findWorkflowMention("Please @issue", 13), {
    start: 7,
    end: 13,
    query: "issue",
  });
});

test("findWorkflowMention ignores email-like and completed mention text", () => {
  assert.equal(findWorkflowMention("name@example.com", 16), null);
  assert.equal(findWorkflowMention("@summary please", 15), null);
});

test("removeWorkflowMention preserves text on either side and returns cursor", () => {
  assert.deepEqual(
    removeWorkflowMention("Please @sum this", { start: 7, end: 11, query: "sum" }),
    { value: "Please  this", cursor: 7 },
  );
});
