import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { UPLOAD_ACCEPT } from "../../lib/documentTypes";

const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.tiff,.bmp,.webp";

test("every document upload input accepts OCR image formats", () => {
  const files = [
    "./AddProjectDocsModal.tsx",
    "./AddDocumentsModal.tsx",
    "../assistant/AddDocButton.tsx",
    "../tabular/AddNewTRModal.tsx",
    "../../(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx",
  ];
  // The pickers share one accept list, so a format added there reaches all
  // of them; a picker that hard-codes its own list would drift from it.
  assert.ok(UPLOAD_ACCEPT.includes(IMAGE_ACCEPT));
  assert.ok(UPLOAD_ACCEPT.split(",").includes(".hwpx"));
  for (const relative of files) {
    const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.match(source, /accept=\{UPLOAD_ACCEPT\}/);
    assert.doesNotMatch(source, /accept="\.pdf/);
  }
});

test("the document viewer dispatches image responses to ImageDocView", () => {
  const hook = fs.readFileSync(
    new URL("../../hooks/useFetchSingleDoc.ts", import.meta.url),
    "utf8",
  );
  const view = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(hook, /type: "image"/);
  assert.match(hook, /contentType\.startsWith\("image\/"\)/);
  assert.match(view, /<ImageDocView/);
});
