import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRetrievalResultCoversEvaluationSet,
  evaluationRunResultSchema,
  evaluationSetSchema,
  renderEvaluationResultJson,
  renderEvaluationResultMarkdown,
  scoreRetrievalHit,
  summarizeChecklist,
  summarizeHumanReviews,
  summarizeRetrieval,
  type EvaluationRunResult,
} from "./perfAccuracyEval";

test("evaluation set schema accepts the planned minimal QA shape", () => {
  const parsed = evaluationSetSchema.parse({
    qa: [
      {
        question: "Which date controls?",
        expected_answer_gist: "The date stated in the order.",
        gold_doc: "order.pdf",
        gold_page: 3,
      },
    ],
    scenarios: [
      {
        id: "scenario-1",
        prompt: "Compare the two positions.",
        checklist: ["Both positions are supported by citations."],
      },
    ],
  });

  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.qa[0]?.id, undefined);
  assert.deepEqual(parsed.scenarios[0]?.checklist, [
    "Both positions are supported by citations.",
  ]);
});

test("evaluation set schema rejects invalid pages and duplicate ids", () => {
  assert.throws(() =>
    evaluationSetSchema.parse({
      qa: [
        {
          id: "qa-1",
          question: "First question",
          expected_answer_gist: "First answer",
          gold_doc: "first.pdf",
          gold_page: 0,
        },
        {
          id: "qa-1",
          question: "Second question",
          expected_answer_gist: "Second answer",
          gold_doc: "second.pdf",
          gold_page: 1,
        },
      ],
    }),
  );
});

test("retrieval scoring requires an exact document and page in the top k", () => {
  const candidates = [
    {
      document_id: "doc-a",
      filename: "record.pdf",
      page_number: 4,
      score: 0.9,
    },
    { document_id: "doc-b", filename: "record.pdf", page_number: 5 },
    { document_id: "doc-c", filename: "other.pdf", page_number: 5 },
  ];

  assert.deepEqual(
    scoreRetrievalHit({
      goldDoc: "doc-b",
      goldPage: 5,
      candidates,
      k: 2,
    }),
    {
      k: 2,
      candidate_count: 3,
      hit: true,
      rank: 2,
      document_hit: true,
      document_rank: 2,
      matched_document_id: "doc-b",
      matched_filename: "record.pdf",
      matched_page: 5,
    },
  );

  const wrongPage = scoreRetrievalHit({
    goldDoc: "doc-a",
    goldPage: 5,
    candidates,
    k: 2,
  });
  assert.equal(wrongPage.hit, false);
  assert.equal(wrongPage.document_hit, true);
  assert.equal(wrongPage.document_rank, 1);
  assert.equal(wrongPage.matched_page, 4);

  const outsideTopK = scoreRetrievalHit({
    goldDoc: "doc-c",
    goldPage: 5,
    candidates,
    k: 2,
  });
  assert.equal(outsideTopK.hit, false);
  assert.equal(outsideTopK.document_hit, false);

  const nonExactName = scoreRetrievalHit({
    goldDoc: "Record.pdf",
    goldPage: 4,
    candidates,
    k: 3,
  });
  assert.equal(nonExactName.hit, false);
});

test("retrieval join rejects missing QA ids instead of reporting false misses", () => {
  const result = makeResult();
  const evaluationSet = evaluationSetSchema.parse({
    name: "baseline",
    qa: [
      {
        id: "qa-1",
        question: "First",
        expected_answer_gist: "First answer",
        gold_doc: "source-one.pdf",
        gold_page: 2,
      },
      {
        id: "qa-2",
        question: "Second",
        expected_answer_gist: "Second answer",
        gold_doc: "source-two.pdf",
        gold_page: 3,
      },
    ],
  });

  assert.throws(
    () => assertRetrievalResultCoversEvaluationSet(evaluationSet, result),
    /missing QA ids: qa-2/,
  );
  assert.doesNotThrow(() =>
    assertRetrievalResultCoversEvaluationSet(evaluationSet, {
      ...result,
      qa_results: [
        ...result.qa_results,
        { ...result.qa_results[0]!, id: "qa-2" },
      ],
    }),
  );
});

test("checklist summary excludes not-applicable items from the denominator", () => {
  const items = [
    { id: "a", criterion: "First", status: "pass" as const },
    { id: "b", criterion: "Second", status: "fail" as const },
    { id: "c", criterion: "Third", status: "pending" as const },
    {
      id: "d",
      criterion: "Fourth",
      status: "not_applicable" as const,
    },
  ];
  const snapshot = structuredClone(items);

  assert.deepEqual(summarizeChecklist(items), {
    total: 4,
    applicable: 3,
    passed: 1,
    failed: 1,
    pending: 1,
    not_applicable: 1,
    pass_rate: 1 / 3,
  });
  assert.deepEqual(items, snapshot);
  assert.equal(
    summarizeChecklist([
      { id: "a", criterion: "Only", status: "not_applicable" },
    ]).pass_rate,
    null,
  );
});

test("human-review summary reports reviewed accuracy separately from pending", () => {
  assert.deepEqual(
    summarizeHumanReviews([
      { status: "pass" },
      { status: "fail" },
      { status: "pending" },
    ]),
    {
      total: 3,
      reviewed: 2,
      passed: 1,
      failed: 1,
      pending: 1,
      pass_rate: 0.5,
    },
  );
  assert.equal(summarizeHumanReviews([{ status: "pending" }]).pass_rate, null);
});

test("run result schema enforces citation and top-k consistency", () => {
  const result = makeResult();
  assert.equal(evaluationRunResultSchema.parse(result).run_id, "run-1");

  assert.throws(() =>
    evaluationRunResultSchema.parse({
      ...result,
      qa_results: [
        {
          ...result.qa_results[0],
          retrieval: { ...result.qa_results[0]!.retrieval, k: 4 },
          valid_citations: 2,
          emitted_citations: 1,
        },
      ],
    }),
  );
});

test("JSON and Markdown renderers produce deterministic machine and human output", () => {
  const result = makeResult();
  const json = renderEvaluationResultJson(result);
  const markdown = renderEvaluationResultMarkdown(result);

  assert.ok(json.endsWith("\n"));
  assert.deepEqual(JSON.parse(json), evaluationRunResultSchema.parse(result));
  assert.equal(renderEvaluationResultJson(result), json);

  assert.match(markdown, /1\/1 \(100\.0%\) hit@8/);
  assert.match(markdown, /Answer accuracy: 1\/1 \(100\.0%\); 0 pending review/);
  assert.match(
    markdown,
    /\| qa-1 \| hit \| 1 \| source\\\|one\.pdf \| 2 \| pass/,
  );
  assert.match(markdown, /\| scenario-1 \| completed \| 1\/2 \(50\.0%\)/);
  assert.match(markdown, /- \[pending\] Second criterion/);
  assert.equal(renderEvaluationResultMarkdown(result), markdown);

  assert.deepEqual(summarizeRetrieval(result.qa_results), {
    total: 1,
    hits: 1,
    hit_rate: 1,
  });
});

function makeResult(): EvaluationRunResult {
  return {
    schema_version: 1,
    run_id: "run-1",
    evalset_name: "baseline",
    model: "provider:model",
    started_at: "2026-01-02T03:04:05.000Z",
    finished_at: "2026-01-02T03:05:05.000Z",
    top_k: 8,
    qa_results: [
      {
        id: "qa-1",
        question: "What happened?",
        expected_answer_gist: "A supported event occurred.",
        gold_doc: "source|one.pdf",
        gold_page: 2,
        retrieval: {
          k: 8,
          candidate_count: 2,
          hit: true,
          rank: 1,
          document_hit: true,
          document_rank: 1,
          matched_document_id: "doc-1",
          matched_filename: "source|one.pdf",
          matched_page: 2,
        },
        answer: "The supported event occurred.",
        answer_review: {
          status: "pass",
          reviewer: "reviewer",
          reviewed_at: "2026-01-02T03:05:00.000Z",
        },
        wall_time_ms: 1_234.4,
        emitted_citations: 2,
        valid_citations: 2,
      },
    ],
    scenario_results: [
      {
        id: "scenario-1",
        title: "Comparison",
        prompt: "Compare the positions.",
        tool_chain_status: "completed",
        tool_iterations: 2,
        tool_calls: 3,
        checklist: [
          { id: "first", criterion: "First criterion", status: "pass" },
          {
            id: "second",
            criterion: "Second criterion",
            status: "pending",
          },
        ],
        human_review: { status: "pending" },
        wall_time_ms: 2_500,
        emitted_citations: 3,
        valid_citations: 2,
        failure_mode: null,
      },
    ],
  };
}
