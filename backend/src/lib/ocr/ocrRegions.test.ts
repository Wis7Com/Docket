import test from "node:test";
import assert from "node:assert/strict";
import { findMatchingOcrRegions } from "./ocrRegions";

const rows = [
  {
    region_index: 0,
    text: "The Supplier shall",
    bbox_x: 0.1,
    bbox_y: 0.2,
    bbox_width: 0.35,
    bbox_height: 0.06,
  },
  {
    region_index: 1,
    text: "indemnify the Customer",
    bbox_x: 0.1,
    bbox_y: 0.28,
    bbox_width: 0.42,
    bbox_height: 0.06,
  },
  {
    region_index: 2,
    text: "against all losses.",
    bbox_x: 0.1,
    bbox_y: 0.36,
    bbox_width: 0.3,
    bbox_height: 0.06,
  },
];

test("OCR region lookup returns the contiguous regions covering a citation", () => {
  const matched = findMatchingOcrRegions(
    rows,
    "Supplier shall indemnify the Customer against all losses",
  );
  assert.deepEqual(
    matched.map((row) => row.region_index),
    [0, 1, 2],
  );
});

test("OCR region lookup fails closed for unrelated citation text", () => {
  assert.deepEqual(findMatchingOcrRegions(rows, "governing law is Korea"), []);
});
