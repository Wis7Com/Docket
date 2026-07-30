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

const annotationSource = {
  annotationId: "annotation-1",
  docId: "doc-3",
  documentId: "document-c",
  versionId: "version-c",
  page: 14,
  quote: "The highlighted sentence the reader marked as dispositive.",
} as const;

test("annotation handles mint in order and deduplicate by annotation id", () => {
  const registry = new PassageRegistry();

  assert.equal(registry.registerAnnotation(annotationSource), "a1");
  assert.equal(
    registry.registerAnnotation({
      ...annotationSource,
      annotationId: "annotation-2",
      quote: "A second highlight covering an unrelated proposition.",
    }),
    "a2",
  );
  assert.equal(registry.registerAnnotation(annotationSource), "a1");
  assert.equal(
    registry.registerAnnotation({
      ...annotationSource,
      quote: "Re-registration under the same id keeps the original handle.",
    }),
    "a1",
  );
});

test("registry resolves an annotation handle to its stored highlight", () => {
  const registry = new PassageRegistry();
  registry.registerChunk(source);
  const handle = registry.registerAnnotation(annotationSource);

  const resolved = registry.resolve(handle);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.citation.passage, "a1");
    assert.equal(resolved.citation.docId, "doc-3");
    assert.equal(resolved.citation.documentId, "document-c");
    assert.equal(resolved.citation.versionId, "version-c");
    assert.equal(resolved.citation.chunkId, undefined);
    assert.equal(resolved.citation.page, 14);
    assert.equal(resolved.citation.quote, annotationSource.quote);
    assert.equal(resolved.citation.quoteStart, 0);
    assert.equal(resolved.citation.quoteEnd, annotationSource.quote.length);
    assert.equal(resolved.citation.startChar, 0);
    assert.equal(resolved.citation.endChar, annotationSource.quote.length);
  }

  // Passage resolution on the same registry is untouched by annotations.
  const passage = registry.resolve("p1");
  assert.equal(passage.ok, true);
  if (passage.ok) {
    assert.equal(passage.citation.chunkId, "chunk-a");
    assert.match(passage.citation.quote, /^The first synthetic sentence/);
  }

  // Annotations are claim sources, not searchable sentence evidence.
  assert.deepEqual(
    registry.repairCandidates().map((candidate) => candidate.passage),
    ["p1", "p2", "p3"],
  );
});

test("registry rejects annotation ranges and unknown annotation handles", () => {
  const registry = new PassageRegistry();
  registry.registerAnnotation(annotationSource);
  registry.registerAnnotation({
    ...annotationSource,
    annotationId: "annotation-2",
    quote: "A second highlight covering an unrelated proposition.",
  });

  assert.deepEqual(registry.resolve("a1-a2"), {
    ok: false,
    code: "invalid_passage_range",
  });
  assert.deepEqual(registry.resolve("a9"), {
    ok: false,
    code: "unknown_passage",
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
