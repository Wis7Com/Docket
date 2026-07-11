import test from "node:test";
import assert from "node:assert/strict";
import {
  DOCUMENT_ANNOTATION_TOOL_PROMPT,
  documentAnnotationTools,
} from "./chat";

function toolNames(): string[] {
  return documentAnnotationTools().flatMap((tool) => {
    if (typeof tool !== "object" || tool === null || !("function" in tool)) {
      return [];
    }
    const name = (tool as { function?: { name?: string } }).function?.name;
    return typeof name === "string" ? [name] : [];
  });
}

test("document chat offers only the two annotation tools from the project catalog", () => {
  assert.deepEqual(toolNames(), [
    "get_user_pdf_annotations",
    "read_annotation_context",
  ]);
});

test("document annotation prompt describes scope, pagination, and grounding", () => {
  assert.match(DOCUMENT_ANNOTATION_TOOL_PROMPT, /attached to this chat/);
  assert.match(DOCUMENT_ANNOTATION_TOOL_PROMPT, /summary/);
  assert.match(DOCUMENT_ANNOTATION_TOOL_PROMPT, /truncated/);
  assert.match(DOCUMENT_ANNOTATION_TOOL_PROMPT, /read_annotation_context/);
  assert.match(DOCUMENT_ANNOTATION_TOOL_PROMPT, /user's notes/);
});
