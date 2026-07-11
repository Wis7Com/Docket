import test from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_DOCUMENT_TYPES,
  isAllowedDocumentType,
  mimeTypeForDocumentType,
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
