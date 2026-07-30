import test from "node:test";
import assert from "node:assert/strict";
import { segmentLegalPassages } from "./passageSegmentation";

test("segments synthetic legal prose without splitting legal abbreviations", () => {
  const text =
    "In Alpha v. Beta, No. 24-101, the U.S. Court of Appeals cited 12 F.3d 718 and held for Example Inc. on the first issue. Id. at 720 explains the separate remedy available under § 1983. The final disposition followed.";
  const passages = segmentLegalPassages(text);

  assert.equal(passages.length, 2);
  assert.equal(passages.map((item) => item.text).join(" "), text);
  assert.match(passages[0].text, /v\. Beta, No\. 24-101/);
  assert.match(passages[0].text, /U\.S\./);
  assert.match(passages[0].text, /F\.3d/);
  assert.match(passages[1].text, /^Id\. at 720/);
  assert.match(passages[1].text, /final disposition followed\.$/);
});

test("keeps quoted sentences and numbered-list text in useful passages", () => {
  const text =
    "The notice stated, “The response is due tomorrow.” The court treated that quotation as part of the surrounding sentence and addressed it. 1. First factor. 2. Second factor supplies enough explanatory text to stand with the list.";
  const passages = segmentLegalPassages(text);

  assert.equal(
    passages[0].text,
    "The notice stated, “The response is due tomorrow.”",
  );
  assert.ok(passages.every((item) => item.text.length >= 40));
  assert.match(passages.at(-1)?.text ?? "", /1\. First factor\. 2\. Second/);
});

test("merges short headings and fragments deterministically", () => {
  const text =
    "I. Background\n\nThe parties entered a synthetic agreement after several rounds of negotiation. Short. The remaining explanation is long enough to provide meaningful citation context.";
  const first = segmentLegalPassages(text);
  const second = segmentLegalPassages(text);

  assert.deepEqual(first, second);
  assert.equal(first[0].start, 0);
  assert.match(first[0].text, /^I\. Background/);
  assert.ok(first.every((item) => item.text.length >= 40));
});
