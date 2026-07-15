import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMessages,
  SYSTEM_PROMPT_MAX_DOC_LIST,
} from "./chatTools";

test("available document prompt is capped without changing document handles", () => {
  const documents = Array.from({ length: 250 }, (_, index) => ({
    doc_id: `doc-${index + 1}`,
    filename: `file-${index + 1}.pdf`,
  }));
  const messages = buildMessages([], documents) as {
    role: string;
    content: string;
  }[];
  const system = messages[0].content;
  assert.equal(SYSTEM_PROMPT_MAX_DOC_LIST, 200);
  assert.match(system, /doc-200: file-200\.pdf/);
  assert.match(system, /…외 50개 문서/);
  assert.doesNotMatch(system, /doc-201: file-201\.pdf/);
});

test("available document prompt exposes brief sequence metadata", () => {
  const messages = buildMessages([], [
    {
      doc_id: "doc-1",
      filename: "reply.pdf",
      doc_role: "brief",
      party_side: "A",
      brief_sequence: 3,
    },
  ]) as { role: string; content: string }[];

  assert.match(
    messages[0].content,
    /doc-1: reply\.pdf  \[role=brief, side=A, brief_sequence=3\]/,
  );
});
