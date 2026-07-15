import assert from "node:assert/strict";
import test from "node:test";
import {
  briefSequenceNullableSchema,
  inferBriefSequence,
  inferDocRole,
  inferPartyRole,
  normalizeBriefSequences,
  refineDocRoleFromFirstPage,
  type DocRoleGuess,
} from "./documentClassification";

test("inferDocRole recognizes Korean and common-law briefs and evidence", () => {
  const cases = [
    ["원고 준비서면.pdf", "brief", "high"],
    ["피고 답변서.pdf", "brief", "high"],
    ["갑 제1호증.pdf", "evidence", "high"],
    ["Plaintiff's Opening Brief.pdf", "brief", "high"],
    ["Motion to Dismiss.pdf", "brief", "high"],
    ["Memorandum of Law in Support.pdf", "brief", "high"],
    ["Exhibit A.pdf", "evidence", "high"],
    ["Pl. Ex. 12.pdf", "evidence", "high"],
    ["DX-7.pdf", "evidence", "high"],
    ["Smith Deposition Transcript.pdf", "evidence", "high"],
  ] as const;
  for (const [filename, role, confidence] of cases) {
    assert.deepEqual(inferDocRole({ filename }), { role, confidence });
  }
  assert.deepEqual(inferDocRole({ filename: "Document1.pdf" }), {
    role: "other",
    confidence: "low",
  });
  assert.deepEqual(inferDocRole({ filename: "scan.pdf", pageCount: 500 }), {
    role: "evidence",
    confidence: "low",
  });
});

test("refineDocRoleFromFirstPage promotes clear cover text", () => {
  const prior: DocRoleGuess = { role: "other", confidence: "low" };
  assert.deepEqual(
    refineDocRoleFromFirstPage("갑 제1호증\n계약서 원본", prior),
    { role: "evidence", confidence: "high" },
  );
  assert.deepEqual(
    refineDocRoleFromFirstPage("MEMORANDUM OF LAW IN OPPOSITION", prior),
    { role: "brief", confidence: "high" },
  );
  assert.deepEqual(refineDocRoleFromFirstPage("....", prior), prior);
});

test("inferPartyRole preserves actual appellate designations", () => {
  assert.equal(inferPartyRole({ filename: "원고 준비서면.pdf" })?.role, "원고");
  assert.equal(inferPartyRole({ filename: "을 제2호증.pdf" })?.role, "피고");
  assert.equal(
    inferPartyRole({ filename: "항소인 준비서면.pdf" })?.role,
    "항소인",
  );
  assert.equal(
    inferPartyRole({ filename: "Appellant's Brief.pdf" })?.role,
    "appellant",
  );
  assert.equal(
    inferPartyRole({ filename: "Defendant's Exhibit.pdf" })?.role,
    "defendant",
  );
  assert.equal(inferPartyRole({ filename: "PX-3.pdf" })?.role, "plaintiff");
  assert.equal(inferPartyRole({ filename: "unlabelled.pdf" }), null);
});

test("inferBriefSequence recognizes explicit brief ordering and fails closed", () => {
  const cases = [
    ["ECF213 Defendant Brief.pdf", "brief", 213],
    ["ECF-236 Reply.pdf", "brief", 236],
    ["피고 제 2 차 준비서면.pdf", "brief", 2],
    ["3rd Reply Brief.pdf", "brief", 3],
    ["Opposition 4th.pdf", "brief", 4],
    ["ECF245 Exhibit.pdf", "evidence", null],
    ["2nd Circuit opinion.pdf", "brief", null],
    ["Reply Brief.pdf", "brief", null],
    ["제2차 및 제3차 준비서면.pdf", "brief", null],
    ["ECF213_ECF236_Brief.pdf", "brief", null],
  ] as const;
  for (const [filename, docRole, expected] of cases) {
    assert.equal(inferBriefSequence({ filename, docRole }), expected);
  }
  assert.equal(
    inferBriefSequence({
      filename: "ECF245 - 3rd Reply Brief.pdf",
      docRole: "brief",
    }),
    3,
  );
});

test("normalizeBriefSequences ranks unique hints only within a party-side group", () => {
  const input = [
    { id: "a-late", partySide: "A", docRole: "brief", sequenceHint: 245 },
    { id: "a-early", partySide: "A", docRole: "brief", sequenceHint: 213 },
    { id: "b-only", partySide: "B", docRole: "brief", sequenceHint: 240 },
    { id: "unknown-party", partySide: null, docRole: "brief", sequenceHint: 1 },
    { id: "evidence", partySide: "A", docRole: "evidence", sequenceHint: 1 },
    { id: "duplicate-1", partySide: "B", docRole: "brief", sequenceHint: 300 },
    { id: "duplicate-2", partySide: "B", docRole: "brief", sequenceHint: 300 },
  ] as const;

  assert.deepEqual(normalizeBriefSequences(input), [
    { id: "a-late", briefSequence: 2 },
    { id: "a-early", briefSequence: 1 },
    { id: "b-only", briefSequence: 1 },
    { id: "unknown-party", briefSequence: null },
    { id: "evidence", briefSequence: null },
    { id: "duplicate-1", briefSequence: null },
    { id: "duplicate-2", briefSequence: null },
  ]);
  assert.equal(input[0].sequenceHint, 245);
});

test("brief sequence override schema accepts only positive integers or null", () => {
  for (const value of [1, 42, null]) {
    assert.equal(briefSequenceNullableSchema.safeParse(value).success, true);
  }
  for (const value of [0, -1, 1.5, "2", undefined]) {
    assert.equal(briefSequenceNullableSchema.safeParse(value).success, false);
  }
});
