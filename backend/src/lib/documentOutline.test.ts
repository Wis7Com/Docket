import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDeterministicDocumentOutline,
  generateDocumentOutlineFallback,
} from "./documentOutline";
import type { StructuredIndexText, StructuredTextLine } from "./indexing/types";

function line(
  text: string,
  page: number,
  lineIndex: number,
): StructuredTextLine {
  return {
    page_number: page,
    line_index: lineIndex,
    text,
    start_char: lineIndex * 100,
    end_char: lineIndex * 100 + text.length,
    font_size: 10,
    bold: false,
  };
}

test("deterministic fallback matches printed TOC titles to physical pages", () => {
  const structured: StructuredIndexText = {
    text: "",
    lines: [
      line("Table of Contents", 1, 0),
      line("1. Background ........ 1", 1, 1),
      line("2. Scope and Purpose ........ 2", 1, 2),
      line("CHAPTER 1 — BACKGROUND", 3, 0),
      line("2 Scope & Purpose", 4, 0),
    ],
    sections: [],
  };

  const result = buildDeterministicDocumentOutline(structured);
  assert.equal(result.source, "toc-match");
  assert.deepEqual(
    result.items.map(({ title, page }) => ({ title, page })),
    [
      { title: "1. Background", page: 3 },
      { title: "2. Scope and Purpose", page: 4 },
    ],
  );
});

test("unmatched printed page labels do not masquerade as physical pages", () => {
  const structured: StructuredIndexText = {
    text: "",
    lines: [
      line("Table of Contents", 1, 0),
      line("1. Background ........ 1", 1, 1),
      line("2. Scope ........ 2", 1, 2),
      line("Unrelated body prose", 3, 0),
      line("More unrelated body prose", 4, 0),
    ],
    sections: [],
  };

  assert.deepEqual(buildDeterministicDocumentOutline(structured).items, []);
});

test("CPU-only fallback reports the stop and never invokes the LLM", async () => {
  let completionCalls = 0;
  const result = await generateDocumentOutlineFallback({
    structured: {
      text: "Ordinary prose without detectable headings.",
      lines: [line("Ordinary prose without detectable headings.", 1, 0)],
      sections: [],
    },
    fileType: "pdf",
    model: "ollama:test-model",
    apiKeys: {},
    detectGpu: async () => ({ available: false, name: null }),
    complete: async () => {
      completionCalls += 1;
      return "[]";
    },
  });

  assert.equal(completionCalls, 0);
  assert.equal(result.source, "gpu-unavailable");
  assert.deepEqual(result.items, []);
  assert.match(result.message ?? "", /CPU/i);
  assert.match(result.message ?? "", /not attempted/i);
});

test("GPU fallback reads every chunk and keeps only headings found in the document", async () => {
  const lines = [
    line("Existing First Heading", 1, 0),
    line("Body text for the first section.", 1, 1),
    line("Existing Second Heading", 2, 0),
    line("Body text for the second section.", 2, 1),
  ];
  const seenPrompts: string[] = [];
  const result = await generateDocumentOutlineFallback({
    structured: {
      text: lines.map((item) => item.text).join("\n"),
      lines,
      sections: [],
    },
    fileType: "pdf",
    model: "ollama:test-model",
    apiKeys: {},
    maxChunkChars: 60,
    detectGpu: async () => ({ available: true, name: "Test GPU" }),
    complete: async ({ user }) => {
      seenPrompts.push(user);
      if (user.includes("Candidate headings from the full document")) {
        return JSON.stringify([
          { index: 0, level: 1 },
          { index: 1, level: 2 },
        ]);
      }
      if (user.includes("Existing First Heading")) {
        return JSON.stringify([
          { title: "Existing First Heading", level: 1, page: 99 },
          { title: "Invented Heading", level: 2, page: 1 },
        ]);
      }
      return JSON.stringify([
        { title: "Existing Second Heading", level: 1, page: 99 },
      ]);
    },
  });

  assert.ok(seenPrompts.length >= 2);
  assert.ok(
    seenPrompts.some((prompt) => prompt.includes("Existing First Heading")),
  );
  assert.ok(
    seenPrompts.some((prompt) => prompt.includes("Existing Second Heading")),
  );
  assert.ok(
    seenPrompts.some((prompt) =>
      prompt.includes("Candidate headings from the full document"),
    ),
  );
  assert.deepEqual(
    result.items.map(({ title, level, page }) => ({ title, level, page })),
    [
      { title: "Existing First Heading", level: 1, page: 1 },
      { title: "Existing Second Heading", level: 2, page: 2 },
    ],
  );
});

test("oversized full-document passes stop before making partial LLM calls", async () => {
  const lines = Array.from({ length: 65 }, (_, index) =>
    line(`Ordinary line ${index} with enough text to fill its own chunk.`, index + 1, 0),
  );
  let completionCalls = 0;
  const result = await generateDocumentOutlineFallback({
    structured: {
      text: lines.map((item) => item.text).join("\n"),
      lines,
      sections: [],
    },
    fileType: "pdf",
    model: "ollama:test-model",
    apiKeys: {},
    maxChunkChars: 10,
    detectGpu: async () => ({ available: true, name: "Test GPU" }),
    complete: async () => {
      completionCalls += 1;
      return "[]";
    },
  });

  assert.equal(result.source, "too-large");
  assert.equal(completionCalls, 0);
  assert.match(result.message ?? "", /complete LLM outline pass/i);
});
