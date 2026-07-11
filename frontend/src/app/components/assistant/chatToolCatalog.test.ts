import test from "node:test";
import assert from "node:assert/strict";
import { availableChatTools } from "./chatToolCatalog";

test("document chat exposes annotation listing and context tools", () => {
  const names = availableChatTools(false).map((tool) => tool.name);
  assert.ok(names.includes("get_user_pdf_annotations"));
  assert.ok(names.includes("read_annotation_context"));
});

test("project-only search tools remain hidden from document chat", () => {
  const names = availableChatTools(false).map((tool) => tool.name);
  assert.ok(!names.includes("search_project_documents"));
  assert.ok(!names.includes("read_index_chunk"));
});
