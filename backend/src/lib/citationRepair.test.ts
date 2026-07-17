import test from "node:test";
import assert from "node:assert/strict";
import {
  CITATION_REPAIR_MAX_CANDIDATES,
  applyCitationRepairPlan,
  boundCitationRepairEvidence,
  buildCitationRepairRequest,
  buildQuoteCandidateMenu,
  citationRepairBody,
  citationRepairEnabled,
  parseCitationRepairResponse,
  shouldAttemptCitationRepair,
  type CitationRepairPlan,
  type QuoteCandidate,
} from "./citationRepair";

test("citation repair defaults on for short answers and requires document evidence", () => {
  const eligible = {
    answerText: "short answer",
    calledToolNames: ["search_project_documents"],
    discardedCitationCount: 1,
  };
  assert.equal(shouldAttemptCitationRepair(eligible), true);
  assert.equal(citationRepairEnabled(undefined), true);
  assert.equal(citationRepairEnabled(""), true);
  assert.equal(citationRepairEnabled(" 0 "), false);
  assert.equal(citationRepairEnabled("false"), false);
  assert.equal(citationRepairEnabled("no"), false);
  assert.equal(citationRepairEnabled("off"), false);
  assert.equal(citationRepairEnabled("unexpected"), true);
  for (const enabled of ["1", " true ", "TRUE", "yes", "ON"]) {
    assert.equal(citationRepairEnabled(enabled), true);
    assert.equal(
      shouldAttemptCitationRepair({ ...eligible, envValue: enabled }),
      true,
    );
  }
  assert.equal(
    shouldAttemptCitationRepair({ ...eligible, envValue: "0" }),
    false,
  );
  assert.equal(
    shouldAttemptCitationRepair({
      ...eligible,
      calledToolNames: ["list_documents"],
    }),
    false,
  );
  assert.equal(
    shouldAttemptCitationRepair({ ...eligible, discardedCitationCount: 0 }),
    false,
  );
  assert.equal(
    shouldAttemptCitationRepair({ ...eligible, repairAttempted: true }),
    false,
  );
});

test("candidate menu extracts exact structured and raw-page sentences", () => {
  const menu = buildQuoteCandidateMenu([
    {
      toolName: "search_project_documents",
      content: JSON.stringify({
        results: [
          {
            doc_id: "doc-1",
            page: 7,
            chunk_id: "chunk-1",
            content:
              "First exact source sentence has enough words. Second exact source sentence also has enough words.",
          },
        ],
      }),
    },
    {
      toolName: "read_document",
      docId: "doc-2",
      content:
        "[Page 3]\nThird exact source sentence contains several useful words.",
    },
  ]);

  assert.deepEqual(
    menu.map(({ doc_id, page, quote, chunk_id }) => ({
      doc_id,
      page,
      quote,
      chunk_id,
    })),
    [
      {
        doc_id: "doc-1",
        page: 7,
        quote: "First exact source sentence has enough words.",
        chunk_id: "chunk-1",
      },
      {
        doc_id: "doc-2",
        page: 3,
        quote: "Third exact source sentence contains several useful words.",
        chunk_id: undefined,
      },
      {
        doc_id: "doc-1",
        page: 7,
        quote: "Second exact source sentence also has enough words.",
        chunk_id: "chunk-1",
      },
    ],
  );
});

test("candidate menu deduplicates, rejects unsafe metadata, and caps with page diversity", () => {
  const results = Array.from({ length: 90 }, (_, index) => ({
    doc_id: `doc-${index % 3}`,
    page: (index % 5) + 1,
    chunk_id: `chunk-${index}`,
    content: `Unique exact source sentence number ${index} contains enough words.`,
  }));
  results.push({
    doc_id: "not-a-chat-label",
    page: 2,
    chunk_id: "unsafe",
    content: "This sentence must never become a candidate item.",
  });
  const menu = buildQuoteCandidateMenu([
    {
      toolName: "search_project_documents",
      content: JSON.stringify({ results }),
    },
  ]);
  assert.equal(menu.length, CITATION_REPAIR_MAX_CANDIDATES);
  assert.deepEqual(
    menu.map((item) => item.index),
    Array.from({ length: 60 }, (_, i) => i + 1),
  );
  assert.equal(
    menu.some((item) => item.doc_id === "not-a-chat-label"),
    false,
  );
  assert.ok(
    new Set(menu.map((item) => `${item.doc_id}:${item.page}`)).size > 3,
  );
});

test("candidate menu reads embedded prepared-summary citations verbatim", () => {
  const prepared = `Summary text.\n<CITATIONS>\n[{"ref":1,"doc_id":"doc-4","page":9,"quote":"Embedded exact quote contains enough source words.","chunk_id":"chunk-4"}]\n</CITATIONS>`;
  const menu = buildQuoteCandidateMenu([
    {
      toolName: "summarize_document",
      content: JSON.stringify({ prepared_summary: prepared }),
    },
  ]);
  assert.deepEqual(menu, [
    {
      index: 1,
      doc_id: "doc-4",
      page: 9,
      quote: "Embedded exact quote contains enough source words.",
      chunk_id: "chunk-4",
    },
  ]);
});

test("candidate extraction parses complete tool JSON before bounding the serialized menu", () => {
  const content = JSON.stringify({
    padding: "x".repeat(13_000),
    results: [
      {
        doc_id: "doc-5",
        page: 11,
        chunk_id: "chunk-late",
        content:
          "Late exact source sentence remains available after large padding.",
      },
    ],
  });
  const menu = buildQuoteCandidateMenu([
    { toolName: "search_project_documents", content },
  ]);
  assert.equal(menu[0]?.doc_id, "doc-5");
  assert.equal(menu[0]?.chunk_id, "chunk-late");
});

test("repair request exposes only answer body and numbered menu", () => {
  const answer = `Original answer body long enough for a unique anchor.\n<CITATIONS>\n[{"ref":9,"doc_id":"bad","page":1,"quote":"bad"}]\n</CITATIONS>`;
  const candidates: QuoteCandidate[] = [
    {
      index: 1,
      doc_id: "doc-0",
      page: 2,
      quote: "Exact source sentence contains enough useful words.",
      chunk_id: "chunk-1",
    },
  ];
  const request = buildCitationRepairRequest({
    answerText: answer,
    evidence: [],
    candidates,
  });
  assert.equal(
    citationRepairBody(answer),
    "Original answer body long enough for a unique anchor.",
  );
  assert.match(
    request.systemPrompt,
    /do not write, alter, or paraphrase any quote/i,
  );
  assert.match(request.userPrompt, /quote_candidate_menu/);
  assert.doesNotMatch(request.userPrompt, /"doc_id":"bad"/);
  assert.deepEqual(request.candidates, candidates);
});

test("mapping parser enforces schema, anchor bounds, and candidate range", () => {
  const candidates: QuoteCandidate[] = [
    { index: 1, doc_id: "doc-0", page: 1, quote: "Three exact source words" },
  ];
  const valid = JSON.stringify({
    mappings: [
      {
        anchor_text: "This is an exact unique answer anchor.",
        candidate_index: 1,
      },
    ],
  });
  assert.deepEqual(
    parseCitationRepairResponse(valid, candidates),
    JSON.parse(valid),
  );
  assert.equal(
    parseCitationRepairResponse(
      valid.replace('"candidate_index":1', '"candidate_index":2'),
      candidates,
    ),
    null,
  );
  assert.equal(
    parseCitationRepairResponse(
      '{"mappings":[{"anchor_text":"short","candidate_index":1}]}',
      candidates,
    ),
    null,
  );
  assert.equal(
    parseCitationRepairResponse(`preface ${valid}`, candidates),
    null,
  );
});

test("server assembly inserts mapped menu citations and preserves answer text", () => {
  const answer =
    "First supported claim appears only once.\n\n| Issue | Result |\n|---|---|\n| Scope | Second supported claim appears only once. |";
  const candidates: QuoteCandidate[] = [
    {
      index: 1,
      doc_id: "doc-0",
      page: 2,
      quote: "Exact first source text has five words",
    },
    {
      index: 2,
      doc_id: "doc-1",
      page: "4-5",
      quote: "Exact second source text has five words",
      chunk_id: "chunk-2",
    },
  ];
  const plan: CitationRepairPlan = {
    mappings: [
      {
        anchor_text: "First supported claim appears only once.",
        candidate_index: 1,
      },
      {
        anchor_text: "Second supported claim appears only once.",
        candidate_index: 2,
      },
    ],
  };
  const result = applyCitationRepairPlan(answer, plan, candidates);
  assert.match(
    result.text ?? "",
    /^First supported claim appears only once\. \[1\]/,
  );
  assert.match(
    result.text ?? "",
    /Second supported claim appears only once\. \[2\] \|/,
  );
  assert.deepEqual(
    result.citations.map((item) => item.doc_id),
    ["doc-0", "doc-1"],
  );
  assert.deepEqual(result.diagnostics, {
    menuCandidates: 2,
    mappingsProposed: 2,
    mappingsAccepted: 2,
    mappingsAmbiguous: 0,
  });
  assert.equal(
    (result.text ?? "").replace(/ \[\d+\]/g, "").split("\n\n<CITATIONS>")[0],
    answer,
  );
});

test("assembly skips ambiguous anchors and allocates after invalid existing refs", () => {
  const answer = `Repeated supported claim appears here. Repeated supported claim appears here. Unique supported claim appears exactly once. [7]\n<CITATIONS>\n[{"ref":9,"doc_id":"doc-0","page":1,"quote":"invalid"}]\n</CITATIONS>`;
  const candidates: QuoteCandidate[] = [
    {
      index: 1,
      doc_id: "doc-0",
      page: 1,
      quote: "First exact source quote has enough words",
    },
    {
      index: 2,
      doc_id: "doc-1",
      page: 2,
      quote: "Second exact source quote has enough words",
    },
  ];
  const result = applyCitationRepairPlan(
    answer,
    {
      mappings: [
        {
          anchor_text: "Repeated supported claim appears here.",
          candidate_index: 1,
        },
        {
          anchor_text: "Unique supported claim appears exactly once.",
          candidate_index: 2,
        },
      ],
    },
    candidates,
  );
  assert.match(result.text ?? "", /once\. \[10\] \[7\]/);
  assert.deepEqual(
    result.citations.map((item) => item.ref),
    [10],
  );
  assert.deepEqual(result.diagnostics, {
    menuCandidates: 2,
    mappingsProposed: 2,
    mappingsAccepted: 1,
    mappingsAmbiguous: 1,
  });
});

test("evidence bounding is immutable and retains raw-read document metadata", () => {
  const evidence = Array.from({ length: 6 }, (_, index) => ({
    toolName: "read_document",
    docId: `doc-${index}`,
    content: String(index).repeat(12_001),
  }));
  const bounded = boundCitationRepairEvidence(evidence);
  assert.equal(bounded.length, 5);
  assert.equal(
    bounded.reduce((total, item) => total + item.content.length, 0),
    60_000,
  );
  assert.equal(bounded[0].docId, "doc-0");
  assert.equal(evidence[0].content.length, 12_001);
});
