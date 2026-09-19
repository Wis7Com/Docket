import test from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_DOCUMENT_TYPES,
  isAllowedDocumentType,
  mimeTypeForDocumentType,
  usesPdfRendition,
} from "./documentTypes";

test("upload types include the Phase 3 image formats", () => {
  assert.deepEqual(IMAGE_DOCUMENT_TYPES, [
    "png",
    "jpg",
    "jpeg",
    "tiff",
    "bmp",
    "webp",
  ]);
  for (const type of IMAGE_DOCUMENT_TYPES) {
    assert.equal(isAllowedDocumentType(type), true);
    assert.match(mimeTypeForDocumentType(type), /^image\//);
  }
});

test("HWPX is an accepted upload type that displays through a PDF rendition", () => {
  assert.equal(isAllowedDocumentType("hwpx"), true);
  assert.equal(isAllowedDocumentType("HWPX"), true);
  assert.equal(mimeTypeForDocumentType("hwpx"), "application/hwp+zip");
  for (const type of ["docx", "doc", "hwpx", "HWPX"]) {
    assert.equal(usesPdfRendition(type), true);
  }
  for (const type of ["pdf", "txt", "md", "png"]) {
    assert.equal(usesPdfRendition(type), false);
  }
  // Legacy binary .hwp is a different format and is not handled.
  assert.equal(isAllowedDocumentType("hwp"), false);
});
