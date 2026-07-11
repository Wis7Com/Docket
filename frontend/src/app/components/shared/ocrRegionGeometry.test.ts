import test from "node:test";
import assert from "node:assert/strict";
import { normalizedOcrRegionToPdfRect } from "./ocrRegionGeometry";

test("top-left normalized OCR boxes convert to bottom-left PDF rectangles", () => {
  assert.deepEqual(
    normalizedOcrRegionToPdfRect(
      { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
      3,
      { width: 600, height: 800 },
    ),
    { page: 3, x: 60, y: 560, width: 240, height: 80 },
  );
});

test("OCR boxes are clamped before conversion", () => {
  assert.deepEqual(
    normalizedOcrRegionToPdfRect(
      { x: -0.2, y: 0.9, width: 1.5, height: 0.5 },
      1,
      { width: 100, height: 200 },
    ),
    { page: 1, x: 0, y: 0, width: 100, height: 20 },
  );
});
