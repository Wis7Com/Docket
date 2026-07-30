import test from "node:test";
import assert from "node:assert/strict";
import {
  cosineSimilarity,
  isCrossScriptClaim,
  rebindUnconfirmedCitation,
  type RebindCandidate,
} from "./citationRebinding";

const OFF_BY_ONE_CLAIM =
  "Defendants produced, paid for, and sent the robocalls";

/** The passage the mapper actually named: the neighboring table row. */
const NEIGHBORING_ROW_PASSAGE =
  "Plaintiffs allege the messages were misleading about mail-in ballots.";

const OFF_BY_ONE_CANDIDATES: readonly RebindCandidate[] = [
  {
    passage: "p9",
    chunkId: "chunk-9",
    docId: "doc-1",
    text: NEIGHBORING_ROW_PASSAGE,
  },
  {
    passage: "p12",
    chunkId: "chunk-12",
    docId: "doc-1",
    text: "Records provided by Message Communications confirm that JMBA's check paid for the call and that Defendants sent it.",
  },
  {
    passage: "p13",
    chunkId: "chunk-13",
    docId: "doc-1",
    text: "Defendants sent notices to the county.",
  },
  {
    passage: "p14",
    chunkId: "chunk-14",
    docId: "doc-1",
    text: "Defendants deny each allegation.",
  },
];

test("off-by-one citation rebinds to the passage that supports the claim", () => {
  const result = rebindUnconfirmedCitation({
    claimContext: OFF_BY_ONE_CLAIM,
    currentPassageText: NEIGHBORING_ROW_PASSAGE,
    candidates: OFF_BY_ONE_CANDIDATES,
  });
  assert.deepEqual(result, {
    passage: "p12",
    score: 0.6,
    sharedWords: 3,
    nearVerbatim: false,
  });
});

test("candidates below the support gate never win a rebind", () => {
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: OFF_BY_ONE_CLAIM,
      currentPassageText: NEIGHBORING_ROW_PASSAGE,
      candidates: [
        {
          passage: "p20",
          chunkId: "chunk-20",
          docId: "doc-1",
          text: "The hearing was continued to April.",
        },
        {
          passage: "p21",
          chunkId: "chunk-21",
          docId: "doc-1",
          // One shared content word only: the gate demands at least two.
          text: "Defendants deny each allegation.",
        },
        {
          passage: "p22",
          chunkId: "chunk-22",
          docId: "doc-1",
          text: "Exhibit B lists the county clerk's address.",
        },
      ],
    }),
    null,
  );
});

test("a tie without margin abstains instead of guessing", () => {
  const duplicated = "Defendants sent notices to the county.";
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: OFF_BY_ONE_CLAIM,
      currentPassageText: NEIGHBORING_ROW_PASSAGE,
      candidates: [
        {
          passage: "p30",
          chunkId: "chunk-30",
          docId: "doc-1",
          text: duplicated,
        },
        {
          passage: "p31",
          chunkId: "chunk-31",
          docId: "doc-1",
          text: duplicated,
        },
      ],
    }),
    null,
  );
});

test("a near-verbatim winner outranks an equally scored runner-up", () => {
  const claim = "Defendants produced and sent the robocalls in Ohio.";
  const candidates: readonly RebindCandidate[] = [
    {
      passage: "p40",
      chunkId: "chunk-40",
      docId: "doc-1",
      text: claim,
    },
    {
      // Full overlap of its own (shorter) word set, so it also scores 1.
      passage: "p41",
      chunkId: "chunk-41",
      docId: "doc-1",
      text: "Robocalls were produced.",
    },
  ];
  const result = rebindUnconfirmedCitation({
    claimContext: claim,
    currentPassageText: NEIGHBORING_ROW_PASSAGE,
    candidates,
  });
  assert.equal(result?.passage, "p40");
  assert.equal(result?.nearVerbatim, true);

  // Without the near-verbatim exception the same 1.0/1.0 pair is a tie.
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: claim,
      currentPassageText: NEIGHBORING_ROW_PASSAGE,
      candidates: [
        candidates[1],
        {
          passage: "p42",
          chunkId: "chunk-42",
          docId: "doc-1",
          text: "The robocalls were produced.",
        },
      ],
    }),
    null,
  );
});

test("semantic prior rejects a winner outside the top-K chunks", () => {
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: OFF_BY_ONE_CLAIM,
      currentPassageText: NEIGHBORING_ROW_PASSAGE,
      candidates: OFF_BY_ONE_CANDIDATES,
      semanticScoreByChunk: new Map([
        ["chunk-9", 0.91],
        ["chunk-13", 0.88],
        ["chunk-14", 0.84],
        ["chunk-12", 0.12],
      ]),
    }),
    null,
  );

  // A chunk absent from the map is out of range, not unconstrained.
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: OFF_BY_ONE_CLAIM,
      currentPassageText: NEIGHBORING_ROW_PASSAGE,
      candidates: OFF_BY_ONE_CANDIDATES,
      semanticScoreByChunk: new Map([
        ["chunk-9", 0.91],
        ["chunk-13", 0.88],
        ["chunk-14", 0.84],
      ]),
    }),
    null,
  );
});

test("semantic prior admits a winner inside the top-K chunks", () => {
  const semanticScoreByChunk = new Map([
    ["chunk-9", 0.42],
    ["chunk-12", 0.93],
    ["chunk-13", 0.55],
    ["chunk-14", 0.11],
  ]);
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: OFF_BY_ONE_CLAIM,
      currentPassageText: NEIGHBORING_ROW_PASSAGE,
      candidates: OFF_BY_ONE_CANDIDATES,
      semanticScoreByChunk,
    })?.passage,
    "p12",
  );

  // Ranked second overall, so a stricter K of 1 excludes it.
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: OFF_BY_ONE_CLAIM,
      currentPassageText: NEIGHBORING_ROW_PASSAGE,
      candidates: OFF_BY_ONE_CANDIDATES,
      semanticScoreByChunk: new Map([
        ["chunk-9", 0.99],
        ["chunk-12", 0.93],
      ]),
      semanticTopK: 1,
    }),
    null,
  );
});

test("an absent semantic map skips the chunk filter entirely", () => {
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: OFF_BY_ONE_CLAIM,
      currentPassageText: NEIGHBORING_ROW_PASSAGE,
      candidates: OFF_BY_ONE_CANDIDATES,
      semanticTopK: 1,
    })?.passage,
    "p12",
  );
});

test("the winner must strictly improve on the current passage", () => {
  const stronger = "Defendants produced and paid for the robocalls.";
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: OFF_BY_ONE_CLAIM,
      currentPassageText: stronger,
      candidates: OFF_BY_ONE_CANDIDATES,
    }),
    null,
  );

  // Equal support is not an improvement either.
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: OFF_BY_ONE_CLAIM,
      currentPassageText: OFF_BY_ONE_CANDIDATES[1].text,
      candidates: OFF_BY_ONE_CANDIDATES,
    }),
    null,
  );

  // An unknown current passage cannot block the rebind.
  assert.equal(
    rebindUnconfirmedCitation({
      claimContext: OFF_BY_ONE_CLAIM,
      currentPassageText: null,
      candidates: OFF_BY_ONE_CANDIDATES,
    })?.passage,
    "p12",
  );
});

test("cross-script detection targets exactly the lexical gate's blind spot", () => {
  assert.equal(
    isCrossScriptClaim(
      "피고는 가정하더라도 요건을 충족하지 못한다고 반박합니다",
      "Even assuming, arguendo, the evidence establishes responsibility.",
    ),
    true,
  );
  assert.equal(
    isCrossScriptClaim(
      "The defendant argues the evidence is insufficient.",
      "Even assuming, arguendo, the evidence establishes responsibility.",
    ),
    false,
    "same-script pairs stay with the lexical gate",
  );
  assert.equal(
    isCrossScriptClaim(
      "피고는 'black robo' 관련 85,000건의 발신을 인정합니다",
      "Defendants broadcast the robocall to approximately 85,000 numbers.",
    ),
    true,
    "loanwords and figures do not make a Korean claim a Latin one",
  );
  assert.equal(isCrossScriptClaim("", "anything"), false);
});

test("cosine similarity is bounded and guards degenerate inputs", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});
