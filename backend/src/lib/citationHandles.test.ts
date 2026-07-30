import test from "node:test";
import assert from "node:assert/strict";
import {
  PassageRegistry,
  measurePassageAnnotationByteOverhead,
} from "./citationHandles";

const source = {
  docId: "doc-0",
  documentId: "document-a",
  versionId: "version-a",
  chunkId: "chunk-a",
  page: 7,
  startChar: 100,
  content:
    "The first synthetic sentence contains enough detail to support a legal claim. The second synthetic sentence supplies a distinct and independently useful proposition. The third synthetic sentence closes the example with additional explanatory text.",
} as const;

test("registry assigns stable ids and deduplicates repeated chunks", () => {
  const registry = new PassageRegistry();
  const first = registry.registerChunk(source);
  const second = registry.registerChunk(source);

  assert.deepEqual(
    first.map((item) => item.id),
    ["p1", "p2", "p3"],
  );
  assert.strictEqual(first, second);
  assert.match(registry.annotateChunk(source), /^\[p1\] The first/);
});

test("registry resolves single passages and valid contiguous ranges", () => {
  const registry = new PassageRegistry();
  registry.registerChunk(source);

  const single = registry.resolve("p2");
  assert.equal(single.ok, true);
  if (single.ok) {
    assert.equal(single.citation.docId, "doc-0");
    assert.equal(single.citation.chunkId, "chunk-a");
    assert.equal(single.citation.page, 7);
    assert.equal(
      single.citation.quote,
      "The second synthetic sentence supplies a distinct and independently useful proposition.",
    );
    assert.equal(single.citation.startChar, 100 + single.citation.quoteStart);
  }

  const range = registry.resolve("p1-p3");
  assert.equal(range.ok, true);
  if (range.ok) {
    assert.match(range.citation.quote, /^The first/);
    assert.match(range.citation.quote, /explanatory text\.$/);
  }
});

test("registry rejects malformed, unknown, cross-chunk, and overlong ranges", () => {
  const registry = new PassageRegistry();
  registry.registerChunk(source);
  registry.registerChunk({
    ...source,
    chunkId: "chunk-b",
    content:
      "A fourth synthetic sentence belongs to another indexed chunk and another source interval.",
  });

  assert.deepEqual(registry.resolve("passage-1"), {
    ok: false,
    code: "invalid_passage_range",
  });
  assert.deepEqual(registry.resolve("p99"), {
    ok: false,
    code: "unknown_passage",
  });
  assert.deepEqual(registry.resolve("p1-p4"), {
    ok: false,
    code: "invalid_passage_range",
  });

  const longRegistry = new PassageRegistry();
  longRegistry.registerChunk({
    ...source,
    content: Array.from(
      { length: 4 },
      (_, index) =>
        `Synthetic sentence ${index + 1} contains enough standalone explanatory language for deterministic segmentation.`,
    ).join(" "),
  });
  assert.deepEqual(longRegistry.resolve("p1-p4"), {
    ok: false,
    code: "invalid_passage_range",
  });
});

test("registry derives a page range and inserts the established break sentinel", () => {
  const registry = new PassageRegistry();
  const content =
    "A synthetic cross-page sentence begins with enough supporting detail and continues on the following page without changing its meaning.";
  registry.registerChunk({
    ...source,
    content,
    page: 12,
    pageEnd: 13,
    pageBreakOffsets: [76],
  });

  const resolved = registry.resolve("p1");
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.citation.page, "12-13");
    assert.match(resolved.citation.quote, /\[\[PAGE_BREAK\]\]/);
  }
});

test("excerpt matching survives regex metacharacters in legal text", () => {
  const registry = new PassageRegistry();
  const citeSource = {
    ...source,
    chunkId: "chunk-cite",
    content:
      "See 567 U.S. 718( absent from those few categories where the law allows content-based regulation. A following sentence keeps the chunk multi-passage.",
  };

  const annotated = registry.annotateExcerpt(
    citeSource,
    "718( absent from those few categories where the law allows something reworded",
  );
  assert.equal(typeof annotated, "string");

  const passage = registry.passageForQuote(
    citeSource,
    "718( absent from those few categories where the law allows content-based regulation.",
  );
  assert.equal(passage, "p1");
});

test("passage annotation overhead compares one payload with and without annotations", () => {
  const withoutAnnotations = {
    items: [
      {
        chunk_id: "chunk-a",
        indexed_quote:
          "The first synthetic sentence contains enough detail to support a legal claim.",
      },
    ],
  };
  const withAnnotations = {
    items: [
      {
        chunk_id: "chunk-a",
        indexed_quote:
          "[p1] The first synthetic sentence contains enough detail to support a legal claim.",
        citation_passage: "p1",
      },
    ],
  };

  const measurement = measurePassageAnnotationByteOverhead(withAnnotations);
  const expectedWithoutBytes = Buffer.byteLength(
    JSON.stringify(withoutAnnotations),
    "utf8",
  );
  const expectedWithBytes = Buffer.byteLength(
    JSON.stringify(withAnnotations),
    "utf8",
  );

  assert.equal(
    measurement.serializedBytesWithoutAnnotations,
    expectedWithoutBytes,
  );
  assert.equal(measurement.serializedBytesWithAnnotations, expectedWithBytes);
  assert.equal(measurement.byteDelta, expectedWithBytes - expectedWithoutBytes);
  assert.equal(
    measurement.percentDelta,
    (measurement.byteDelta / expectedWithoutBytes) * 100,
  );
});
