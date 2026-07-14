import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ISSUES,
  buildIssueMatrixSseEvents,
  cellsToProcess,
  clampIssues,
  validateIssueMatrixScope,
} from "./issueMatrix";

test("validateIssueMatrixScope rejects malformed sides", () => {
  assert.throws(
    () => validateIssueMatrixScope(null),
    /scope must be an object/,
  );
  assert.throws(
    () =>
      validateIssueMatrixScope({
        sides: [
          { label: "원고", doc_ids: ["doc-a"] },
          { label: " 원고 ", doc_ids: ["doc-b"] },
        ],
      }),
    /Duplicate side label/,
  );
  assert.throws(
    () =>
      validateIssueMatrixScope({
        sides: [
          { label: "원고", doc_ids: [] },
          { label: "피고", doc_ids: ["doc-b"] },
        ],
      }),
    /must not be empty/,
  );
  assert.throws(
    () =>
      validateIssueMatrixScope({
        sides: [
          { label: "원고", doc_ids: "doc-a" },
          { label: "피고", doc_ids: ["doc-b"] },
        ],
      }),
    /must be an array/,
  );
});

test("validateIssueMatrixScope normalizes labels and document IDs", () => {
  assert.deepEqual(
    validateIssueMatrixScope({
      sides: [
        { label: " 원고 ", doc_ids: ["doc-a", "doc-a"] },
        { label: "피고", doc_ids: ["doc-b"] },
      ],
      excluded_doc_ids: ["evidence-1", "evidence-1"],
    }),
    {
      sides: [
        { label: "원고", doc_ids: ["doc-a"] },
        { label: "피고", doc_ids: ["doc-b"] },
      ],
      excluded_doc_ids: ["evidence-1"],
    },
  );
});

test("clampIssues limits and reindexes issue discovery output", () => {
  const issues = clampIssues(
    Array.from({ length: 42 }, (_, index) => ({
      index: 99,
      title: `Issue ${index + 1}`,
      summary: `Summary ${index + 1}`,
    })),
  );
  assert.equal(issues.length, MAX_ISSUES);
  assert.equal(issues[0].index, 0);
  assert.equal(issues[MAX_ISSUES - 1].index, MAX_ISSUES - 1);
});

test("cellsToProcess skips only completed cells with content", () => {
  const tasks = [
    { issue_index: 0, side_label: "A" },
    { issue_index: 0, side_label: "B" },
    { issue_index: 1, side_label: "A" },
    { issue_index: 1, side_label: "B" },
  ];
  assert.deepEqual(
    cellsToProcess(tasks, [
      { ...tasks[0], status: "done", content: "complete" },
      { ...tasks[1], status: "done", content: "" },
      { ...tasks[2], status: "pending", content: null },
      { ...tasks[3], status: "error", content: null },
    ]),
    tasks.slice(1),
  );
});

test("buildIssueMatrixSseEvents orders issue, cell, and completion events", () => {
  const events = buildIssueMatrixSseEvents(
    [{ index: 0, title: "Jurisdiction", summary: "Disputed forum" }],
    [
      {
        issue_index: 0,
        side_label: "A",
        content: "Position",
        status: "done",
      },
    ],
  );
  assert.match(events[0], /"type":"issue_update"/);
  assert.match(events[1], /"type":"cell_update"/);
  assert.equal(events[2], "data: [DONE]\n\n");
});
