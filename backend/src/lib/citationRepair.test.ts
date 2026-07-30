import test from "node:test";
import assert from "node:assert/strict";
import {
  CITATION_REPAIR_MAX_CANDIDATES,
  claimContextBeforeMarker,
  CITATION_REPAIR_MAX_CALLS,
  CITATION_REPAIR_MAX_POOL_CANDIDATES,
  applyCitationRepairPlan,
  boundCitationRepairEvidence,
  buildCitationRepairBatches,
  buildCitationRepairRequest,
  buildQuoteCandidateMenu,
  buildQuoteCandidatePool,
  citationRepairBody,
  citationRepairEnabled,
  insertCitationMarker,
  parseCitationRepairResponse,
  reattachOrphanCitationEntries,
  shouldContinueCitationRepairRounds,
  shouldAttemptCitationRepair,
  type CitationRepairCitation,
  type CitationRepairPlan,
  type QuoteCandidate,
} from "./citationRepair";

test("citation repair defaults on for short answers and requires document evidence", () => {
  const eligible = {
    answerText: "short answer",
    calledToolNames: ["search_project_documents"],
    orphanMarkerCount: 1,
    discardedCitationCount: 0,
    verifiedCitationCount: 1,
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
    shouldAttemptCitationRepair({ ...eligible, orphanMarkerCount: 0 }),
    false,
  );
  assert.equal(
    shouldAttemptCitationRepair({ ...eligible, repairAttempted: true }),
    false,
  );
});

test("citation repair gate accepts the union of deficiency signals", () => {
  const clean = {
    answerText: "grounded answer",
    calledToolNames: ["search_project_documents"],
    orphanMarkerCount: 0,
    discardedCitationCount: 0,
    verifiedCitationCount: 1,
  };
  assert.equal(shouldAttemptCitationRepair(clean), false);
  assert.equal(
    shouldAttemptCitationRepair({ ...clean, orphanMarkerCount: 1 }),
    true,
  );
  assert.equal(
    shouldAttemptCitationRepair({ ...clean, discardedCitationCount: 1 }),
    true,
  );
  assert.equal(
    shouldAttemptCitationRepair({ ...clean, verifiedCitationCount: 0 }),
    true,
  );
});

test("deterministic repair reattaches verified marker-less citation entries", () => {
  const filename = "summary-judgment-motion.pdf";
  const citations: CitationRepairCitation[] = Array.from(
    { length: 16 },
    (_, index) => ({
      ref: index + 1,
      doc_id: "doc-0",
      page: index === 0 ? 99 : index + 1,
      quote: `Exact source quote ${index + 1} contains enough words.`,
      chunk_id: `chunk-${index + 1}`,
    }),
  );
  const pseudoCitations = Array.from(
    { length: 18 },
    (_, index) =>
      `| Issue ${index + 1} | Supported claim [${filename}, p. ${index + 1}] |`,
  ).join("\n");
  const answer = `| Issue | Analysis |\n| --- | --- |\n${pseudoCitations}\n\n<CITATIONS>\n${JSON.stringify(citations)}\n</CITATIONS>`;

  const result = reattachOrphanCitationEntries(
    answer,
    citations,
    {
      "doc-0": filename,
    },
    Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [index + 1, index + 1]),
    ),
  );

  assert.equal(result.citations.length, 16);
  assert.deepEqual(
    Array.from((result.text ?? "").matchAll(/\[(\d+)\]/g), (match) =>
      Number.parseInt(match[1], 10),
    ),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  assert.equal(
    Array.from(
      (result.text ?? "").matchAll(
        new RegExp(`\\[${filename.replace(/\./g, "\\.")}, p\\. \\d+\\]`, "g"),
      ),
    ).length,
    2,
  );
});

test("deterministic repair survives regex metacharacters in filenames", () => {
  const result = reattachOrphanCitationEntries(
    "Supported claim [synthetic(appeal)+.pdf, p. 7].",
    [
      {
        ref: 3,
        doc_id: "doc-0",
        page: 7,
        quote: "Supported claim",
      },
    ],
    { "doc-0": "synthetic(appeal)+.pdf" },
  );

  assert.match(result.text ?? "", /Supported claim \[3\]\./);
  assert.equal(result.citations.length, 1);
});

test("deterministic repair falls back to the sentence containing the quote", () => {
  const citation: CitationRepairCitation = {
    ref: 4,
    doc_id: "doc-0",
    page: 9,
    quote: "The exact quoted clause controls this dispute",
  };
  const result = reattachOrphanCitationEntries(
    "The exact quoted clause controls this dispute and resolves the issue. A second sentence follows.",
    [citation],
    { "doc-0": "source.pdf" },
  );

  assert.match(
    result.text ?? "",
    /resolves the issue\. \[4\] A second sentence/,
  );
  assert.deepEqual(result.citations, [citation]);
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

test("multi-batch candidate pool reaches beyond the former first-60 cutoff", () => {
  const results = Array.from({ length: 90 }, (_, index) => ({
    doc_id: `doc-${index % 3}`,
    page: (index % 5) + 1,
    content: `Unique registration evidence number ${index} supports voter ${index}.`,
  }));
  const evidence = [
    {
      toolName: "search_project_documents",
      content: JSON.stringify({ results }),
    },
  ];
  const menu = buildQuoteCandidateMenu(evidence);
  const pool = buildQuoteCandidatePool(evidence);
  assert.equal(menu.length, CITATION_REPAIR_MAX_CANDIDATES);
  assert.equal(pool.length, 90);
  assert.ok(pool.length <= CITATION_REPAIR_MAX_POOL_CANDIDATES);
  const batches = buildCitationRepairBatches(
    "Unique registration evidence number 89 supports voter 89.",
    pool,
  );
  assert.equal(
    batches.some((batch) =>
      batch.candidates.some((candidate) =>
        candidate.quote.includes("number 89"),
      ),
    ),
    true,
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
  assert.match(
    request.systemPrompt,
    /Filename\/page pseudo-citations .* are invalid output but useful location hints/,
  );
  assert.match(
    request.systemPrompt,
    /never include the pseudo-citation itself/,
  );
  assert.match(
    request.systemPrompt,
    /must include the closing delimiter and any immediately trailing sentence punctuation/,
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
  const longButBoundedAnchor = "x".repeat(200);
  assert.deepEqual(
    parseCitationRepairResponse(
      JSON.stringify({
        mappings: [{ anchor_text: longButBoundedAnchor, candidate_index: 1 }],
      }),
      candidates,
    ),
    {
      mappings: [{ anchor_text: longButBoundedAnchor, candidate_index: 1 }],
    },
  );
  assert.equal(
    parseCitationRepairResponse(
      JSON.stringify({
        mappings: [{ anchor_text: "x".repeat(501), candidate_index: 1 }],
      }),
      candidates,
    ),
    null,
  );
  assert.equal(
    parseCitationRepairResponse(`preface ${valid}`, candidates),
    null,
  );
});

test("handle repair asks for and assembles passage mappings without copied quotes", () => {
  const answer = "The indexed deadline applies to every synthetic request.";
  const candidates: QuoteCandidate[] = [
    {
      index: 1,
      passage: "p12",
      doc_id: "doc-0",
      page: 6,
      quote:
        "The indexed deadline applies to every synthetic request submitted after notice.",
      chunk_id: "chunk-12",
    },
  ];
  const request = buildCitationRepairRequest({
    answerText: answer,
    evidence: [],
    candidates,
  });
  assert.match(request.userPrompt, /passage_candidate_menu/);
  assert.match(request.systemPrompt, /"passage":"p12"/);
  assert.doesNotMatch(request.systemPrompt, /candidate_index values/);

  const response = JSON.stringify({
    mappings: [{ anchor_text: answer, passage: "p12" }],
  });
  const plan = parseCitationRepairResponse(response, candidates);
  assert.ok(plan);
  const result = applyCitationRepairPlan(answer, plan, candidates);
  assert.match(result.text ?? "", /"ref": 1,\s+"passage": "p12"/);
  assert.doesNotMatch(result.text ?? "", /chunk-12/);
  assert.equal(result.citations[0]?.quote, candidates[0].quote);
});

test("server assembly inserts mapped menu citations and preserves answer text", () => {
  const answer =
    "First supported claim appears only once.\n\n| Issue | Result |\n|---|---|\n| Scope | Second supported claim appears only once. |";
  const candidates: QuoteCandidate[] = [
    {
      index: 1,
      doc_id: "doc-0",
      page: 2,
      quote: "First supported claim appears only once in the source.",
    },
    {
      index: 2,
      doc_id: "doc-1",
      page: "4-5",
      quote: "Second supported claim appears only once in the source.",
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
    mappingsRejected: 0,
    mappingsUnsafeAnchor: 0,
    mappingsUnsupported: 0,
    mappingsDuplicateEvidence: 0,
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
      quote: "The unique supported claim appears exactly once.",
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
    mappingsRejected: 1,
    mappingsUnsafeAnchor: 0,
    mappingsUnsupported: 0,
    mappingsDuplicateEvidence: 0,
  });
});

test("deterministic and mapper repair never insert inside closing quotes", () => {
  const first = reattachOrphanCitationEntries(
    'The record confirms no demographic tags on these phone lists". Next.',
    [
      {
        ref: 15,
        doc_id: "doc-0",
        page: 2,
        quote: "no demographic tags on these phone lists",
      },
    ],
    {},
  );
  assert.match(first.text ?? "", /phone lists"\. \[15\] Next/);

  const second = reattachOrphanCitationEntries(
    'The testimony shows the call did not deter or suppress his ability to vote." Next.',
    [
      {
        ref: 16,
        doc_id: "doc-1",
        page: 9,
        quote: "did not deter or suppress his ability to vote",
      },
    ],
    {},
  );
  assert.match(second.text ?? "", /ability to vote\." \[16\] Next/);

  const rejected = applyCitationRepairPlan(
    'The testimony says "the call did not deter or suppress his ability to vote."',
    {
      mappings: [
        {
          anchor_text:
            "the call did not deter or suppress his ability to vote.",
          candidate_index: 1,
        },
      ],
    },
    [
      {
        index: 1,
        doc_id: "doc-1",
        page: 9,
        quote: "The call did not deter or suppress his ability to vote.",
      },
    ],
  );
  assert.equal(rejected.text, null);
  assert.equal(rejected.diagnostics.mappingsUnsafeAnchor, 1);
});

test("citation insertion advances past an enclosing quote with nested single quotes", () => {
  const body =
    "| Defendant says Plaintiffs conflate \"dissuasion or deterrence from mail-in voting with 'threatening,' 'intimidating,' or 'coercing'\". |";
  const result = insertCitationMarker(body, body.indexOf("threatening"), 16);

  assert.match(
    result,
    /mail-in voting with 'threatening,' 'intimidating,' or 'coercing'"\. \[16\] \|$/,
  );
  assert.doesNotMatch(result, /'\s*\[16\]threatening/);
});

test("word-internal apostrophes do not create a false quoted span", () => {
  const body =
    "NCBCP's position supports the cited passage before Defendant's response.";
  const insertionIndex = body.indexOf(" before");

  assert.equal(
    insertCitationMarker(body, insertionIndex, 17),
    "NCBCP's position supports the cited passage [17] before Defendant's response.",
  );
});

test("mapper rejects unsupported and already-verified evidence", () => {
  const answer =
    "Defendant testified that he voted and the robocall did not suppress his vote.";
  const unsupported = applyCitationRepairPlan(
    answer,
    {
      mappings: [
        {
          anchor_text: answer,
          candidate_index: 1,
        },
      ],
    },
    [
      {
        index: 1,
        doc_id: "doc-0",
        page: 3,
        quote:
          "Plaintiff received a different message concerning registration deadlines.",
      },
    ],
  );
  assert.equal(unsupported.text, null);
  assert.equal(unsupported.diagnostics.mappingsUnsupported, 1);
  assert.equal(unsupported.diagnostics.mappingsRejected, 1);

  const candidate: QuoteCandidate = {
    index: 1,
    doc_id: "doc-1",
    page: 8,
    quote:
      "Defendant testified that he voted and the robocall did not suppress his vote.",
  };
  const duplicate = applyCitationRepairPlan(
    answer,
    {
      mappings: [{ anchor_text: answer, candidate_index: 1 }],
    },
    [candidate],
    {
      existingCitations: [
        {
          ref: 2,
          doc_id: candidate.doc_id,
          page: candidate.page,
          quote: candidate.quote,
        },
      ],
    },
  );
  assert.equal(duplicate.text, null);
  assert.equal(duplicate.diagnostics.mappingsDuplicateEvidence, 1);
});

test("long mapper anchors require a sentence or table-cell boundary", () => {
  const anchor =
    "This unusually long supported claim repeats registration robocall evidence and voter suppression details without ending at a claim boundary";
  const answer = `${anchor} before the sentence continues.`;
  const result = applyCitationRepairPlan(
    answer,
    { mappings: [{ anchor_text: anchor, candidate_index: 1 }] },
    [
      {
        index: 1,
        doc_id: "doc-0",
        page: 1,
        quote:
          "Registration robocall evidence described voter suppression details.",
      },
    ],
  );
  assert.equal(result.text, null);
  assert.equal(result.diagnostics.mappingsUnsafeAnchor, 1);
});

test("deterministic repair advances markers past emphasis and backticks", () => {
  const emphasized = reattachOrphanCitationEntries(
    "The record **contains exact supported language**.",
    [
      {
        ref: 4,
        doc_id: "doc-0",
        page: 1,
        quote: "contains exact supported language",
      },
    ],
    {},
  );
  assert.match(emphasized.text ?? "", /\*\*\. \[4\]/);

  const code = reattachOrphanCitationEntries(
    "The command `contains exact supported language`.",
    [
      {
        ref: 5,
        doc_id: "doc-0",
        page: 1,
        quote: "contains exact supported language",
      },
    ],
    {},
  );
  assert.match(code.text ?? "", /`\. \[5\]/);
});

test("repair batches are claim-sized, plausible, and bounded", () => {
  const answer = Array.from(
    { length: 12 },
    (_, index) =>
      `- Claim ${index + 1} says the registration robocall affected voter ${index + 1}.`,
  ).join("\n");
  const candidates: QuoteCandidate[] = Array.from(
    { length: 70 },
    (_, index) => ({
      index: index + 1,
      doc_id: `doc-${index % 2}`,
      page: (index % 10) + 1,
      quote: `The registration robocall affected voter ${index + 1}.`,
    }),
  );
  const batches = buildCitationRepairBatches(answer, candidates);
  assert.ok(batches.length > 1);
  assert.ok(batches.length <= 4);
  assert.ok(
    batches.every(
      (batch) => batch.candidates.length > 0 && batch.candidates.length <= 60,
    ),
  );

  const remaining = buildCitationRepairBatches(
    `${answer}\nAlready repaired registration claim [91].`,
    candidates,
    {},
    new Set([91]),
  );
  assert.equal(
    remaining.some((batch) => batch.answerText.includes("Already repaired")),
    false,
  );
});

test("repair round controller stops on zero additions and hard call caps", () => {
  assert.equal(
    shouldContinueCitationRepairRounds({
      round: 1,
      calls: 4,
      acceptedInRound: 1,
      batchingEnabled: true,
    }),
    true,
  );
  assert.equal(
    shouldContinueCitationRepairRounds({
      round: 1,
      calls: 4,
      acceptedInRound: 0,
      batchingEnabled: true,
    }),
    false,
  );
  assert.equal(
    shouldContinueCitationRepairRounds({
      round: 1,
      calls: CITATION_REPAIR_MAX_CALLS,
      acceptedInRound: 2,
      batchingEnabled: true,
    }),
    false,
  );
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

test("claim context stops at table cell and line boundaries", () => {
  const row =
    "| Defendants targeted black neighborhoods with the black robo. [14] | The Defendant states that providing evidence of distribution is of no moment [15] because it misses the forest for the trees. |";
  const secondMarker = row.indexOf("[15]");
  const context = claimContextBeforeMarker(row, secondMarker);
  assert.ok(
    context.includes("providing evidence of distribution"),
    "context should cover the current cell",
  );
  assert.ok(
    !context.includes("black neighborhoods"),
    "context must not leak the previous cell across the pipe",
  );

  const bullets =
    "* The chapter used the call center to safeguard voters. [7]\n* Steinberg decided not to re-register to vote. [8]";
  const bulletMarker = bullets.indexOf("[8]");
  const bulletContext = claimContextBeforeMarker(bullets, bulletMarker);
  assert.ok(bulletContext.includes("re-register"));
  assert.ok(
    !bulletContext.includes("call center"),
    "context must not leak the previous bullet across the newline",
  );
  assert.ok(
    !bulletContext.trimStart().startsWith("*"),
    "list markup is stripped from the claim",
  );
});
