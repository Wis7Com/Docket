import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("PDF page re-renders restore OCR citation overlays when text matching fails", () => {
  const source = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );
  const applyToPage = source.match(
    /async function applyHighlightsToPage\([\s\S]*?\n    }\n\n    function clearOcrCitationLayers/,
  )?.[0];

  assert.ok(applyToPage, "applyHighlightsToPage should remain available");
  assert.match(
    applyToPage,
    /if \(!found && resolvedPage === pageNum\)[\s\S]*paintOcrCitationFallback\(/,
    "zoom and resize page renders must repaint the OCR citation fallback",
  );
});
