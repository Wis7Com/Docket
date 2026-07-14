import assert from "node:assert/strict";
import test from "node:test";
import {
  inferDocRole,
  inferPartyRole,
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
