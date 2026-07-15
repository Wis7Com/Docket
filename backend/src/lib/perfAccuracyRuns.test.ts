import assert from "node:assert/strict";
import test from "node:test";
import type { EvaluationRunResult } from "./perfAccuracyEval";
import {
  aggregateRound3Runs,
  median,
  renderRound3AggregateMarkdown,
} from "./perfAccuracyRuns";

test("median is immutable and handles odd and even samples", () => {
  const values = [9, 1, 5];
  assert.equal(median(values), 5);
  assert.deepEqual(values, [9, 1, 5]);
  assert.equal(median([4, 2]), 3);
  assert.throws(() => median([]));
});

test("Round 3 aggregation preserves run values and reports medians", () => {
  const runs = [
    makeRun("run-1", 11, 1, 3),
    makeRun("run-2", 13, 0, 5),
    makeRun("run-3", 12, 0, 4),
  ];
  const aggregate = aggregateRound3Runs(runs);

  assert.deepEqual(aggregate.qa.verified_citation_answers, {
    values: [11, 13, 12],
    median: 12,
  });
  assert.deepEqual(aggregate.qa.empty_answers, {
    values: [1, 0, 0],
    median: 0,
  });
  assert.deepEqual(aggregate.scenarios["as-3"].checklist_passed, {
    values: [3, 5, 4],
    median: 4,
  });
  assert.equal(aggregate.scenarios["as-3"].checklist_review_pending, false);
  assert.match(renderRound3AggregateMarkdown(aggregate), /as-3 \| 4/);
});

function makeRun(
  runId: string,
  verifiedAnswers: number,
  emptyAnswers: number,
  checklistPassed: number,
): EvaluationRunResult {
  return {
    schema_version: 1,
    run_id: runId,
    model: "ollama:test",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:01:00.000Z",
    top_k: 8,
    qa_results: Array.from({ length: 15 }, (_, index) => ({
      id: `qa-${index + 1}`,
      question: "Question",
      expected_answer_gist: "Answer",
      gold_doc: "source.pdf",
      gold_page: 1,
      retrieval: {
        k: 8,
        candidate_count: 1,
        hit: true,
        rank: 1,
        document_hit: true,
        document_rank: 1,
        matched_document_id: "doc-1",
        matched_filename: "source.pdf",
        matched_page: 1,
      },
      answer: index < emptyAnswers ? undefined : "Answer",
      answer_review: { status: "pending" },
      wall_time_ms: 10,
      emitted_citations: index < verifiedAnswers ? 1 : 0,
      valid_citations: index < verifiedAnswers ? 1 : 0,
    })),
    scenario_results: [
      {
        id: "as-3",
        prompt: "Review annotations",
        tool_chain_status: "completed",
        tool_iterations: 1,
        tool_calls: 1,
        checklist: Array.from({ length: 6 }, (_, index) => ({
          id: `criterion-${index + 1}`,
          criterion: `Criterion ${index + 1}`,
          status: index < checklistPassed ? ("pass" as const) : ("fail" as const),
        })),
        human_review: { status: "pending" },
        wall_time_ms: 100,
        emitted_citations: 1,
        valid_citations: 1,
        failure_mode: null,
      },
    ],
  };
}
