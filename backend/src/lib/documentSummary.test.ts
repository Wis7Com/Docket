import assert from "node:assert/strict";
import test from "node:test";
import {
  DocumentSummaryValidationError,
  clearDocumentSummaryResultCache,
  defaultDocumentSummaryBatchBounds,
  estimateDocumentSummaryEtaMs,
  packDocumentSummaryBatches,
  summarizeDocumentWithCoverage,
  type DocumentSummaryChunk,
} from "./documentSummary";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test("summary batch bounds derive Ollama capacity without changing other providers", () => {
  const oldNumCtx = process.env.OLLAMA_NUM_CTX;
  const oldMaxNumCtx = process.env.OLLAMA_MAX_NUM_CTX;
  const oldCharsPerToken = process.env.OLLAMA_CHARS_PER_TOKEN;

  try {
    delete process.env.OLLAMA_NUM_CTX;
    delete process.env.OLLAMA_MAX_NUM_CTX;
    delete process.env.OLLAMA_CHARS_PER_TOKEN;
    assert.deepEqual(
      defaultDocumentSummaryBatchBounds("ollama:gemma4:12b-mlx"),
      { maxBatchCharacters: 24_806, maxBatchPages: 15 },
    );
    assert.deepEqual(
      defaultDocumentSummaryBatchBounds("ollama:gemma4:26b-claude-32k"),
      { maxBatchCharacters: 24_806, maxBatchPages: 15 },
    );
    assert.deepEqual(defaultDocumentSummaryBatchBounds("mlx:local-model"), {
      maxBatchCharacters: 26_000,
      maxBatchPages: 16,
    });

    process.env.OLLAMA_MAX_NUM_CTX = "32768";
    assert.deepEqual(
      defaultDocumentSummaryBatchBounds("ollama:gemma4:12b-mlx"),
      { maxBatchCharacters: 55_936, maxBatchPages: 34 },
    );
    assert.deepEqual(defaultDocumentSummaryBatchBounds("mlx:local-model"), {
      maxBatchCharacters: 26_000,
      maxBatchPages: 16,
    });

    process.env.OLLAMA_MAX_NUM_CTX = "65536";
    assert.deepEqual(
      defaultDocumentSummaryBatchBounds("ollama:gemma4:12b-mlx"),
      { maxBatchCharacters: 55_936, maxBatchPages: 34 },
    );

    process.env.OLLAMA_NUM_CTX = "8192";
    assert.deepEqual(
      defaultDocumentSummaryBatchBounds("ollama:gemma4:12b-mlx"),
      { maxBatchCharacters: 9_241, maxBatchPages: 5 },
    );
    assert.deepEqual(
      defaultDocumentSummaryBatchBounds("free-router:free-router/best"),
      { maxBatchCharacters: 52_000, maxBatchPages: 32 },
    );
    assert.deepEqual(
      defaultDocumentSummaryBatchBounds("gemini-3-flash-preview"),
      { maxBatchCharacters: 80_000, maxBatchPages: 48 },
    );
  } finally {
    restoreEnv("OLLAMA_NUM_CTX", oldNumCtx);
    restoreEnv("OLLAMA_MAX_NUM_CTX", oldMaxNumCtx);
    restoreEnv("OLLAMA_CHARS_PER_TOKEN", oldCharsPerToken);
  }
});

test("summary ETA uses average completed batch time and remaining work", () => {
  assert.equal(estimateDocumentSummaryEtaMs([], 4), undefined);
  assert.equal(estimateDocumentSummaryEtaMs([100, 300], 3), 600);
  assert.equal(estimateDocumentSummaryEtaMs([99.4], 2), 199);
  assert.equal(estimateDocumentSummaryEtaMs([100], 0), 0);
});

test("a pre-aborted summary rejects before invoking map or reduce", async () => {
  const reason = new Error("summary cancelled");
  const signal = AbortSignal.abort(reason);
  let mapCalls = 0;
  let reduceCalls = 0;

  await assert.rejects(
    summarizeDocumentWithCoverage(
      { ...baseArgs, chunks: chunksForPages(1), pageCount: 1, signal },
      {
        map: async () => {
          mapCalls += 1;
          return "";
        },
        reduce: async () => {
          reduceCalls += 1;
          return "";
        },
      },
    ),
    reason,
  );
  assert.equal(mapCalls, 0);
  assert.equal(reduceCalls, 0);
});

function chunksForPages(pageCount: number): DocumentSummaryChunk[] {
  let offset = 0;
  return Array.from({ length: pageCount }, (_, index) => {
    const page = index + 1;
    const content = `Page ${page} source text with material term ${page}.`;
    const chunk = {
      chunk_id: `chunk-${page}`,
      chunk_index: index,
      page_number: page,
      page_end: page,
      content,
      start_char: offset,
      end_char: offset + content.length,
    };
    offset += content.length + 1;
    return chunk;
  });
}

const baseArgs = {
  model: "test-model",
  apiKeys: {},
  filename: "record.pdf",
  docId: "doc-0",
  documentId: "document-uuid",
  versionId: "version-uuid",
};

test("default bounds keep a 314-page 453k-character document to ten map batches", () => {
  const charactersPerPage = Math.floor(453_000 / 314);
  let offset = 0;
  const chunks = Array.from({ length: 314 }, (_, index) => {
    const content = `Page ${index + 1} `.padEnd(charactersPerPage, "x");
    const chunk: DocumentSummaryChunk = {
      chunk_id: `large-chunk-${index + 1}`,
      chunk_index: index,
      page_number: index + 1,
      content,
      start_char: offset,
      end_char: offset + content.length,
    };
    offset += content.length;
    return chunk;
  });

  const batches = packDocumentSummaryBatches({
    filename: "453k-record.pdf",
    chunks,
  });

  assert.equal(batches.length, 10);
  assert.ok(batches.every((batch) => batch.inputCharacters <= 52_000));
  assert.ok(
    batches.every(
      (batch) =>
        batch.pageRange &&
        batch.pageRange.end - batch.pageRange.start + 1 <= 32,
    ),
  );
});

test("map prompts send compact source records without server-side offsets", async () => {
  const chunks = chunksForPages(1);
  await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks, pageCount: 1 },
    {
      map: async ({ userPrompt }) => {
        assert.match(
          userPrompt,
          /Ordered source chunks \(one JSON object per line\):/,
        );
        assert.match(userPrompt, /"chunk_id":"chunk-1"/);
        assert.match(userPrompt, /"page_start":1/);
        assert.match(userPrompt, /"page_end":1/);
        assert.match(userPrompt, /"content":"Page 1 source text/);
        assert.doesNotMatch(userPrompt, /"chunk_index"/);
        assert.doesNotMatch(userPrompt, /"start_char"/);
        assert.doesNotMatch(userPrompt, /"end_char"/);
        return JSON.stringify({
          points: [
            {
              text: "Compact prompt point",
              evidence: [
                {
                  chunk_id: chunks[0].chunk_id,
                  quote: chunks[0].content.slice(0, 6),
                },
              ],
            },
          ],
        });
      },
      reduce: async ({ batchSummaries }) =>
        JSON.stringify({
          title: "Compact prompt summary",
          sections: [
            {
              heading: "Point",
              points: [
                {
                  text: batchSummaries[0].points[0].text,
                  evidence_ids: batchSummaries[0].points[0].evidenceIds,
                },
              ],
            },
          ],
        }),
    },
  );
});

test("map prompts de-overlap adjacent chunks without changing citation offsets", async () => {
  const overlap = "DUPLICATED OVERLAP.";
  const firstContent = `Opening text ${overlap}`;
  const secondContent = `${overlap} Closing text.`;
  const chunks: DocumentSummaryChunk[] = [
    {
      chunk_id: "chunk-first",
      chunk_index: 0,
      page_number: 1,
      content: firstContent,
      start_char: 0,
      end_char: firstContent.length,
    },
    {
      chunk_id: "chunk-second",
      chunk_index: 1,
      page_number: 2,
      content: secondContent,
      start_char: firstContent.length - overlap.length,
      end_char: firstContent.length - overlap.length + secondContent.length,
    },
  ];
  let prompt = "";
  const result = await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks, pageCount: 2 },
    {
      map: async ({ userPrompt }) => {
        prompt = userPrompt;
        return JSON.stringify({
          points: [
            {
              text: "The repeated boundary is supported by the second chunk.",
              evidence: [{ chunk_id: "chunk-second", quote: overlap }],
            },
          ],
        });
      },
      reduce: async ({ batchSummaries }) =>
        JSON.stringify({
          title: "De-overlapped summary",
          sections: [
            {
              heading: "Boundary",
              points: [
                {
                  text: batchSummaries[0].points[0].text,
                  evidence_ids: batchSummaries[0].points[0].evidenceIds,
                },
              ],
            },
          ],
        }),
    },
  );

  assert.equal(prompt.split(overlap).length - 1, 1);
  assert.match(prompt, /"content":" Closing text\."/);
  assert.equal(result.citations[0].chunk_id, "chunk-second");
  assert.equal(result.citations[0].quote_start, 0);
  assert.equal(result.citations[0].document_start_char, chunks[1].start_char);

  const nonOverlapping = chunksForPages(2);
  await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks: nonOverlapping, pageCount: 2 },
    {
      map: async ({ userPrompt }) => {
        assert.match(
          userPrompt,
          new RegExp(`"content":"${nonOverlapping[0].content}`),
        );
        assert.match(
          userPrompt,
          new RegExp(`"content":"${nonOverlapping[1].content}`),
        );
        return JSON.stringify({
          points: [
            {
              text: "Non-overlapping source remains whole.",
              evidence: [
                {
                  chunk_id: nonOverlapping[0].chunk_id,
                  quote: nonOverlapping[0].content.slice(0, 6),
                },
              ],
            },
          ],
        });
      },
      reduce: async ({ batchSummaries }) =>
        JSON.stringify({
          title: "Unchanged source",
          sections: [
            {
              heading: "Source",
              points: [
                {
                  text: batchSummaries[0].points[0].text,
                  evidence_ids: batchSummaries[0].points[0].evidenceIds,
                },
              ],
            },
          ],
        }),
    },
  );
});

test("a small local document uses one single-pass call with source-exact citations", async () => {
  const oldBudget = process.env.DOCKET_SUMMARY_SINGLE_PASS_CHARS;
  const quote = "requires notice before any assignment";
  const firstContent = `The agreement ${quote}.`;
  const secondContent = `${quote}. Assignment remains restricted.`;
  const chunks: DocumentSummaryChunk[] = [
    {
      chunk_id: "single-pass-first",
      chunk_index: 0,
      page_number: 1,
      content: firstContent,
      start_char: 400,
      end_char: 400 + firstContent.length,
    },
    {
      chunk_id: "single-pass-second",
      chunk_index: 1,
      page_number: 2,
      content: secondContent,
      start_char: 400 + firstContent.length - quote.length,
      end_char: 400 + firstContent.length - quote.length + secondContent.length,
    },
  ];
  let calls = 0;
  try {
    process.env.DOCKET_SUMMARY_SINGLE_PASS_CHARS = "35000";
    const result = await summarizeDocumentWithCoverage(
      {
        ...baseArgs,
        model: "ollama:test-model",
        chunks,
        pageCount: 2,
      },
      {
        singlePass: async ({ userPrompt, systemPrompt }) => {
          calls += 1;
          assert.match(userPrompt, /single-pass-first/);
          assert.equal(userPrompt.split(quote).length - 1, 1);
          assert.match(systemPrompt, /exhaustive/i);
          return JSON.stringify({
            title: "Assignment notice",
            sections: [
              {
                heading: "Consent",
                points: [
                  {
                    text: "Assignment requires advance notice.",
                    evidence: [{ chunk_id: "single-pass-second", quote }],
                  },
                ],
              },
            ],
          });
        },
        map: async () =>
          assert.fail("map must not run on the single-pass path"),
        reduce: async () =>
          assert.fail("reduce must not run on the single-pass path"),
      },
    );

    assert.equal(calls, 1);
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.processedChunkCount, 2);
    assert.equal(result.coverage.batchCount, 1);
    assert.equal(result.citations[0].quote, quote);
    assert.equal(result.citations[0].quote_start, 0);
    assert.equal(result.citations[0].document_start_char, chunks[1].start_char);
    assert.match(result.preparedText, /# Assignment notice/);
    assert.match(
      result.preparedText,
      /- Assignment requires advance notice\. \[1\]/,
    );
    assert.match(result.preparedText, /<CITATIONS>\n\[.*\]\n<\/CITATIONS>$/s);
  } finally {
    restoreEnv("DOCKET_SUMMARY_SINGLE_PASS_CHARS", oldBudget);
  }
});

test("single-pass threshold and zero budget retain map-reduce", async () => {
  const oldBudget = process.env.DOCKET_SUMMARY_SINGLE_PASS_CHARS;
  const chunks = ["one", "two"].map((label, index) => {
    const content = `${label} source `.padEnd(18_000, label);
    const start_char = index * 20_000;
    return {
      chunk_id: `threshold-${label}`,
      chunk_index: index,
      page_number: index + 1,
      content,
      start_char,
      end_char: start_char + content.length,
    } satisfies DocumentSummaryChunk;
  });
  let mapCalls = 0;
  let reduceCalls = 0;
  let singlePassCalls = 0;
  const dependencies = {
    singlePass: async () => {
      singlePassCalls += 1;
      return "";
    },
    map: async ({
      batch,
    }: {
      batch: { chunks: readonly DocumentSummaryChunk[] };
    }) => {
      mapCalls += 1;
      return JSON.stringify({
        points: batch.chunks.map((chunk) => ({
          text: `${chunk.chunk_id} mapped`,
          evidence: [
            { chunk_id: chunk.chunk_id, quote: chunk.content.slice(0, 10) },
          ],
        })),
      });
    },
    reduce: async ({
      batchSummaries,
    }: {
      batchSummaries: readonly {
        points: readonly { text: string; evidenceIds: string[] }[];
      }[];
    }) => {
      reduceCalls += 1;
      return JSON.stringify({
        title: "Map reduce summary",
        sections: [
          {
            heading: "All sources",
            points: batchSummaries.flatMap((summary) =>
              summary.points.map((point) => ({
                text: point.text,
                evidence_ids: point.evidenceIds,
              })),
            ),
          },
        ],
      });
    },
  };
  try {
    process.env.DOCKET_SUMMARY_SINGLE_PASS_CHARS = "35000";
    await summarizeDocumentWithCoverage(
      {
        ...baseArgs,
        model: "ollama:test-model",
        chunks,
        pageCount: 2,
        maxBatchCharacters: 100_000,
        maxBatchPages: 2,
      },
      dependencies,
    );
    assert.equal(singlePassCalls, 0);
    assert.equal(mapCalls, 1);
    assert.equal(reduceCalls, 1);

    process.env.DOCKET_SUMMARY_SINGLE_PASS_CHARS = "0";
    await summarizeDocumentWithCoverage(
      {
        ...baseArgs,
        model: "ollama:test-model",
        chunks: chunks.slice(0, 1),
        pageCount: 1,
        maxBatchCharacters: 100_000,
      },
      dependencies,
    );
    assert.equal(singlePassCalls, 0);
    assert.equal(mapCalls, 2);
    assert.equal(reduceCalls, 2);
  } finally {
    restoreEnv("DOCKET_SUMMARY_SINGLE_PASS_CHARS", oldBudget);
  }
});

test("invalid single-pass output retries then falls back to map-reduce", async () => {
  const oldBudget = process.env.DOCKET_SUMMARY_SINGLE_PASS_CHARS;
  const chunks = chunksForPages(1);
  let singlePassCalls = 0;
  let mapCalls = 0;
  let reduceCalls = 0;
  try {
    process.env.DOCKET_SUMMARY_SINGLE_PASS_CHARS = "35000";
    const result = await summarizeDocumentWithCoverage(
      {
        ...baseArgs,
        model: "ollama:test-model",
        chunks,
        pageCount: 1,
      },
      {
        singlePass: async () => {
          singlePassCalls += 1;
          return JSON.stringify({ invalid: true });
        },
        map: async ({ batch }) => {
          mapCalls += 1;
          return JSON.stringify({
            points: [
              {
                text: "Fallback map point",
                evidence: [
                  {
                    chunk_id: batch.chunks[0].chunk_id,
                    quote: batch.chunks[0].content.slice(0, 6),
                  },
                ],
              },
            ],
          });
        },
        reduce: async ({ batchSummaries }) => {
          reduceCalls += 1;
          return JSON.stringify({
            title: "Fallback summary",
            sections: [
              {
                heading: "Recovered",
                points: [
                  {
                    text: "Fallback map point",
                    evidence_ids: batchSummaries[0].points[0].evidenceIds,
                  },
                ],
              },
            ],
          });
        },
      },
    );

    assert.equal(singlePassCalls, 3);
    assert.equal(mapCalls, 1);
    assert.equal(reduceCalls, 1);
    assert.match(result.preparedText, /# Fallback summary/);
    assert.equal(result.coverage.complete, true);
  } finally {
    restoreEnv("DOCKET_SUMMARY_SINGLE_PASS_CHARS", oldBudget);
  }
});

test("314-page summaries map every ordered chunk exactly once within batch bounds", async () => {
  const chunks = chunksForPages(314);
  const seenChunkIds: string[] = [];
  const progress: { completedBatches: number; totalBatches: number }[] = [];
  const maxBatchCharacters = 2_400;
  const maxBatchPages = 7;

  const result = await summarizeDocumentWithCoverage(
    {
      ...baseArgs,
      chunks,
      pageCount: 314,
      maxBatchCharacters,
      maxBatchPages,
      onProgress: ({ completedBatches, totalBatches }) => {
        progress.push({ completedBatches, totalBatches });
      },
    },
    {
      map: async ({ batch }) => {
        assert.ok(batch.inputCharacters <= maxBatchCharacters);
        assert.ok(batch.pageRange);
        assert.ok(
          batch.pageRange.end - batch.pageRange.start + 1 <= maxBatchPages,
        );
        seenChunkIds.push(...batch.chunks.map((chunk) => chunk.chunk_id));
        const source = batch.chunks[0];
        const quote = source.content.slice(
          0,
          source.content.indexOf(" source") + " source".length,
        );
        return JSON.stringify({
          points: [
            {
              text: `${source.page_number}페이지 배치 요약`,
              evidence: [
                {
                  chunk_id: source.chunk_id,
                  quote,
                },
              ],
            },
          ],
        });
      },
      reduce: async ({ batchSummaries }) =>
        JSON.stringify({
          title: "전체 문서 요약",
          sections: [
            {
              heading: "핵심 내용",
              points: batchSummaries.flatMap((summary) =>
                summary.points.map((point) => ({
                  text: point.text,
                  evidence_ids: point.evidenceIds,
                })),
              ),
            },
          ],
        }),
    },
  );

  assert.deepEqual(
    seenChunkIds,
    chunks.map((chunk) => chunk.chunk_id),
  );
  assert.equal(new Set(seenChunkIds).size, 314);
  assert.equal(result.coverage.indexedChunkCount, 314);
  assert.equal(result.coverage.processedChunkCount, 314);
  assert.equal(result.coverage.indexedPages.length, 314);
  assert.deepEqual(result.coverage.indexedPageRanges, [{ start: 1, end: 314 }]);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.warnings.length, 0);
  assert.deepEqual(progress.at(-1), {
    completedBatches: result.coverage.batchCount,
    totalBatches: result.coverage.batchCount,
  });
  assert.match(
    result.preparedText,
    /^> Index coverage: indexed pages 1–314; processed 314\/314 chunks;/,
  );
  assert.match(result.preparedText, /# 전체 문서 요약/);
  assert.match(result.preparedText, /<CITATIONS>/);
});

test("hierarchical reduce preserves every original batch citation across recursive tiers", async () => {
  const chunks = chunksForPages(65);
  const reduceInputSizes: number[] = [];
  const result = await summarizeDocumentWithCoverage(
    {
      ...baseArgs,
      chunks,
      pageCount: chunks.length,
      maxBatchPages: 1,
      maxBatchCharacters: 2_000,
    },
    {
      map: async ({ batch }) =>
        JSON.stringify({
          points: [
            {
              text: `${batch.id} supported point`,
              evidence: [
                {
                  chunk_id: batch.chunks[0].chunk_id,
                  quote: batch.chunks[0].content.slice(0, 6),
                },
              ],
            },
          ],
        }),
      reduce: async ({ batchSummaries }) => {
        reduceInputSizes.push(batchSummaries.length);
        return JSON.stringify({
          title: "Hierarchical summary",
          sections: [
            {
              heading: "All source intervals",
              points: batchSummaries.flatMap((summary) =>
                summary.points.map((point) => ({
                  text: point.text,
                  evidence_ids: point.evidenceIds,
                })),
              ),
            },
          ],
        });
      },
    },
  );

  assert.deepEqual(reduceInputSizes, [8, 8, 8, 8, 8, 8, 8, 8, 1, 8, 1, 2]);
  assert.equal(result.citations.length, chunks.length);
  assert.deepEqual(
    new Set(result.citations.map((citation) => citation.chunk_id)),
    new Set(chunks.map((chunk) => chunk.chunk_id)),
  );
  assert.ok(
    result.citations.every((citation) =>
      chunks.some(
        (chunk) =>
          chunk.chunk_id === citation.chunk_id &&
          chunk.content.includes(citation.quote),
      ),
    ),
  );
  assert.match(
    result.preparedText,
    /^> Index coverage:.*\n\n# Hierarchical summary\n\n## All source intervals/,
  );
  assert.match(result.preparedText, /<CITATIONS>\n.*\n<\/CITATIONS>$/s);
});

test("DOCKET_SUMMARY_REDUCE_GROUP_SIZE controls tier width", async () => {
  const oldGroupSize = process.env.DOCKET_SUMMARY_REDUCE_GROUP_SIZE;
  const chunks = chunksForPages(7);
  const reduceInputSizes: number[] = [];
  try {
    process.env.DOCKET_SUMMARY_REDUCE_GROUP_SIZE = "3";
    await summarizeDocumentWithCoverage(
      {
        ...baseArgs,
        chunks,
        pageCount: chunks.length,
        maxBatchPages: 1,
        maxBatchCharacters: 2_000,
      },
      {
        map: async ({ batch }) =>
          JSON.stringify({
            points: [
              {
                text: batch.id,
                evidence: [
                  {
                    chunk_id: batch.chunks[0].chunk_id,
                    quote: batch.chunks[0].content.slice(0, 6),
                  },
                ],
              },
            ],
          }),
        reduce: async ({ batchSummaries }) => {
          reduceInputSizes.push(batchSummaries.length);
          return JSON.stringify({
            title: "Configured tiers",
            sections: [
              {
                heading: "All points",
                points: batchSummaries.flatMap((summary) =>
                  summary.points.map((point) => ({
                    text: point.text,
                    evidence_ids: point.evidenceIds,
                  })),
                ),
              },
            ],
          });
        },
      },
    );
    assert.deepEqual(reduceInputSizes, [3, 3, 1, 3]);
  } finally {
    restoreEnv("DOCKET_SUMMARY_REDUCE_GROUP_SIZE", oldGroupSize);
  }
});

test("prepared citations use source-exact quotes and derived page/chunk offsets", async () => {
  const content = "Intro. The facility amount is KRW 100 billion. Tail.";
  const quote = "The facility amount is KRW 100 billion.";
  const quoteStart = content.indexOf(quote);
  const chunks: DocumentSummaryChunk[] = [
    {
      chunk_id: "chunk-exact",
      chunk_index: 0,
      page_number: 41,
      page_end: 42,
      content,
      start_char: 1_000,
      end_char: 1_000 + content.length,
    },
  ];

  const result = await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks, pageCount: 42, language: "Korean" },
    {
      map: async () =>
        JSON.stringify({
          points: [
            {
              text: "대출 한도는 1,000억원이다.",
              evidence: [
                {
                  chunk_id: "chunk-exact",
                  quote,
                },
              ],
            },
          ],
        }),
      reduce: async ({ batchSummaries }) =>
        JSON.stringify({
          title: "문서 요약",
          sections: [
            {
              heading: "금액",
              points: [
                {
                  text: "대출 한도는 1,000억원이다.",
                  evidence_ids: [batchSummaries[0].points[0].evidenceIds[0]],
                },
              ],
            },
          ],
        }),
    },
  );

  assert.equal(result.citations.length, 1);
  assert.deepEqual(result.citations[0], {
    ref: 1,
    doc_id: "doc-0",
    page: "41-42",
    quote,
    chunk_id: "chunk-exact",
    chunk_index: 0,
    quote_start: quoteStart,
    quote_end: quoteStart + quote.length,
    chunk_quote_start: quoteStart,
    chunk_quote_end: quoteStart + quote.length,
    document_start_char: 1_000 + quoteStart,
    document_end_char: 1_000 + quoteStart + quote.length,
    document_id: "document-uuid",
    version_id: "version-uuid",
  });
  assert.match(result.preparedText, /대출 한도는 1,000억원이다\. \[1\]/);
  assert.ok(result.preparedText.endsWith("</CITATIONS>"));
  assert.equal(
    content.slice(
      result.citations[0].chunk_quote_start,
      result.citations[0].chunk_quote_end,
    ),
    result.citations[0].quote,
  );
});

test("malformed map evidence fails closed instead of emitting a summary", async () => {
  const chunks = chunksForPages(1);
  await assert.rejects(
    summarizeDocumentWithCoverage(
      { ...baseArgs, chunks, pageCount: 1 },
      {
        map: async () =>
          JSON.stringify({
            points: [
              {
                text: "Unsupported point",
                evidence: [
                  {
                    chunk_id: chunks[0].chunk_id,
                    quote: "This quote does not occur in the source chunk.",
                  },
                ],
              },
            ],
          }),
        reduce: async () => {
          assert.fail("reduce must not run after invalid map evidence");
        },
      },
    ),
    (error: unknown) =>
      error instanceof DocumentSummaryValidationError &&
      /quote was not found/.test(error.message),
  );
});

test("unsupported evidence and claims are dropped while supported claims remain", async () => {
  const chunks = chunksForPages(1);
  const result = await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks, pageCount: 1 },
    {
      map: async () =>
        JSON.stringify({
          points: [
            {
              text: "지원되는 주장",
              evidence: [
                {
                  chunk_id: chunks[0].chunk_id,
                  quote: chunks[0].content.slice(0, 13),
                },
                {
                  chunk_id: chunks[0].chunk_id,
                  quote: "invented secondary quote",
                },
              ],
            },
            {
              text: "삭제되어야 할 주장",
              evidence: [
                {
                  chunk_id: chunks[0].chunk_id,
                  quote: "wholly unsupported quote",
                },
              ],
            },
          ],
        }),
      reduce: async ({ batchSummaries }) => {
        assert.equal(batchSummaries[0].points.length, 1);
        assert.equal(batchSummaries[0].evidence.length, 1);
        return JSON.stringify({
          title: "검증 요약",
          sections: [
            {
              heading: "근거 있음",
              points: [
                {
                  text: batchSummaries[0].points[0].text,
                  evidence_ids: [batchSummaries[0].points[0].evidenceIds[0]],
                },
              ],
            },
          ],
        });
      },
    },
  );

  assert.match(result.preparedText, /지원되는 주장/);
  assert.doesNotMatch(result.preparedText, /삭제되어야 할 주장/);
  assert.equal(result.citations.length, 1);
});

test("ambiguous verbatim evidence fails closed", async () => {
  const chunks: DocumentSummaryChunk[] = [
    {
      chunk_id: "chunk-repeated",
      chunk_index: 0,
      page_number: 1,
      content: "same exact quote; same exact quote",
      start_char: 0,
      end_char: 33,
    },
  ];
  await assert.rejects(
    summarizeDocumentWithCoverage(
      { ...baseArgs, chunks, pageCount: 1 },
      {
        map: async () =>
          JSON.stringify({
            points: [
              {
                text: "Ambiguous point",
                evidence: [
                  {
                    chunk_id: "chunk-repeated",
                    quote: "same exact quote",
                  },
                ],
              },
            ],
          }),
        reduce: async () => {
          assert.fail("reduce must not run after ambiguous map evidence");
        },
      },
    ),
    (error: unknown) =>
      error instanceof DocumentSummaryValidationError &&
      /quote was ambiguous/.test(error.message),
  );
});

test("evidence whitespace is normalized but citations retain the exact source slice", async () => {
  const content =
    "The court held that the licence was FRAND.  No injunction issued.";
  const chunks: DocumentSummaryChunk[] = [
    {
      chunk_id: "chunk-spacing",
      chunk_index: 0,
      page_number: 9,
      content,
      start_char: 200,
      end_char: 200 + content.length,
    },
  ];
  const modelQuote =
    "The court held that the licence was FRAND. No injunction issued.";
  const exactQuote =
    "The court held that the licence was FRAND.  No injunction issued.";

  const result = await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks, pageCount: 9 },
    {
      map: async () =>
        JSON.stringify({
          points: [
            {
              text: "법원은 FRAND 조건을 확인하고 금지명령을 내리지 않았다.",
              evidence: [
                {
                  chunk_id: "chunk-spacing",
                  quote: modelQuote,
                },
              ],
            },
          ],
        }),
      reduce: async ({ batchSummaries }) =>
        JSON.stringify({
          title: "판결 요약",
          sections: [
            {
              heading: "결론",
              points: [
                {
                  text: "법원은 FRAND 조건을 확인하고 금지명령을 내리지 않았다.",
                  evidence_ids: [batchSummaries[0].points[0].evidenceIds[0]],
                },
              ],
            },
          ],
        }),
    },
  );

  assert.equal(result.citations[0].quote, exactQuote);
  assert.equal(
    content.slice(
      result.citations[0].quote_start,
      result.citations[0].quote_end,
    ),
    exactQuote,
  );
});

test("minor model quote drift is grounded to a unique exact source excerpt of at most 25 tokens", async () => {
  const content =
    "The series explains important cases and shows both basic principles and decisions that depart from precedent while raising questions for further research.";
  const chunks: DocumentSummaryChunk[] = [
    {
      chunk_id: "chunk-drift",
      chunk_index: 0,
      page_number: 5,
      content,
      start_char: 0,
      end_char: content.length,
    },
  ];
  const result = await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks, pageCount: 5 },
    {
      map: async () =>
        JSON.stringify({
          points: [
            {
              text: "이 시리즈는 기본 원칙과 선례 이탈 판결을 함께 설명한다.",
              evidence: [
                {
                  chunk_id: "chunk-drift",
                  quote:
                    "shows both basic principles and decisions that depart from precedent, while also raising several questions for further research",
                },
              ],
            },
          ],
        }),
      reduce: async ({ batchSummaries }) =>
        JSON.stringify({
          title: "시리즈 설명",
          sections: [
            {
              heading: "성격",
              points: [
                {
                  text: "이 시리즈는 기본 원칙과 선례 이탈 판결을 함께 설명한다.",
                  evidence_ids: [batchSummaries[0].points[0].evidenceIds[0]],
                },
              ],
            },
          ],
        }),
    },
  );

  const citation = result.citations[0];
  assert.equal(
    citation.quote,
    content.slice(citation.quote_start, citation.quote_end),
  );
  assert.ok(citation.quote.split(/\s+/).length <= 25);
  assert.match(citation.quote, /shows both basic principles/);
});

test("a mistyped model chunk id is recovered only from a unique source quote", async () => {
  const chunks = chunksForPages(2);
  const result = await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks, pageCount: 2 },
    {
      map: async () =>
        JSON.stringify({
          points: [
            {
              text: "2페이지의 고유 내용",
              evidence: [
                {
                  chunk_id: "mistyped-hash",
                  quote: "Page 2 source text with material term 2.",
                },
              ],
            },
          ],
        }),
      reduce: async ({ batchSummaries }) =>
        JSON.stringify({
          title: "교정된 요약",
          sections: [
            {
              heading: "근거",
              points: [
                {
                  text: "2페이지의 고유 내용",
                  evidence_ids: [batchSummaries[0].points[0].evidenceIds[0]],
                },
              ],
            },
          ],
        }),
    },
  );

  assert.equal(result.citations[0].chunk_id, "chunk-2");
  assert.equal(result.citations[0].page, 2);
});

test("unknown reduce evidence fails closed", async () => {
  const chunks = chunksForPages(1);
  await assert.rejects(
    summarizeDocumentWithCoverage(
      { ...baseArgs, chunks, pageCount: 1 },
      {
        map: async () =>
          JSON.stringify({
            points: [
              {
                text: "Supported point",
                evidence: [
                  {
                    chunk_id: chunks[0].chunk_id,
                    quote: chunks[0].content.slice(0, 6),
                  },
                ],
              },
            ],
          }),
        reduce: async () =>
          JSON.stringify({
            title: "Summary",
            sections: [
              {
                heading: "Section",
                points: [
                  {
                    text: "Invented synthesis",
                    evidence_ids: ["invented-evidence"],
                  },
                ],
              },
            ],
          }),
      },
    ),
    (error: unknown) =>
      error instanceof DocumentSummaryValidationError &&
      /unknown evidence/.test(error.message),
  );
});

test("coverage exposes missing pages and partial OCR warnings", async () => {
  const chunks = chunksForPages(2);
  const result = await summarizeDocumentWithCoverage(
    {
      ...baseArgs,
      chunks,
      pageCount: 4,
      ocrStatus: { truncated: true, ocrPages: 2, scannedPages: 4 },
    },
    {
      map: async ({ batch }) =>
        JSON.stringify({
          points: [
            {
              text: "부분 요약",
              evidence: [
                {
                  chunk_id: batch.chunks[0].chunk_id,
                  quote: batch.chunks[0].content.slice(0, 6),
                },
              ],
            },
          ],
        }),
      reduce: async ({ batchSummaries }) =>
        JSON.stringify({
          title: "부분 문서 요약",
          sections: [
            {
              heading: "확인된 내용",
              points: [
                {
                  text: "부분 요약",
                  evidence_ids: [batchSummaries[0].points[0].evidenceIds[0]],
                },
              ],
            },
          ],
        }),
    },
  );

  assert.equal(result.coverage.complete, false);
  assert.deepEqual(
    result.coverage.warnings.map((warning) => warning.code),
    ["PARTIAL_OCR", "MISSING_INDEXED_PAGES"],
  );
  assert.deepEqual(result.coverage.warnings[1].pageRanges, [
    { start: 3, end: 4 },
  ]);
  assert.match(result.preparedText, /^> Index coverage: .*; partial\./);
  assert.match(result.preparedText, /> Warning: OCR coverage is partial/);
});

test("a terminal map failure returns the successful batches with partial coverage", async () => {
  const chunks = chunksForPages(3);
  const result = await summarizeDocumentWithCoverage(
    {
      ...baseArgs,
      chunks,
      pageCount: 3,
      maxBatchPages: 1,
      maxBatchCharacters: 2_000,
      mapConcurrency: 1,
      maxStageAttempts: 1,
    },
    {
      map: async ({ batch }) => {
        if (batch.id === "batch-2") throw new Error("synthetic map failure");
        return JSON.stringify({
          points: [
            {
              text: `${batch.id} retained point`,
              evidence: [
                {
                  chunk_id: batch.chunks[0].chunk_id,
                  quote: batch.chunks[0].content.slice(0, 6),
                },
              ],
            },
          ],
        });
      },
      reduce: async ({ batchSummaries }) => {
        assert.deepEqual(
          batchSummaries.map((summary) => summary.batchId),
          ["batch-1", "batch-3"],
        );
        return JSON.stringify({
          title: "Partial map summary",
          sections: [
            {
              heading: "Retained intervals",
              points: batchSummaries.flatMap((summary) =>
                summary.points.map((point) => ({
                  text: point.text,
                  evidence_ids: point.evidenceIds,
                })),
              ),
            },
          ],
        });
      },
    },
  );

  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.processedChunkCount, 2);
  assert.deepEqual(result.coverage.processedChunkIds, ["chunk-1", "chunk-3"]);
  assert.deepEqual(result.coverage.warnings, [
    {
      code: "MAP_FAILED",
      message: "Map summarization failed for source pages 2.",
      pageRanges: [{ start: 2, end: 2 }],
    },
  ]);
  assert.match(result.preparedText, /batch-1 retained point/);
  assert.match(result.preparedText, /batch-3 retained point/);
  assert.doesNotMatch(result.preparedText, /batch-2 retained point/);
});

test("all terminal map failures still abort without invoking reduce", async () => {
  const chunks = chunksForPages(2);
  let reduceCalled = false;
  await assert.rejects(
    summarizeDocumentWithCoverage(
      {
        ...baseArgs,
        chunks,
        pageCount: 2,
        maxBatchPages: 1,
        maxBatchCharacters: 2_000,
        maxStageAttempts: 1,
      },
      {
        map: async () => {
          throw new Error("all maps unavailable");
        },
        reduce: async () => {
          reduceCalled = true;
          throw new Error("reduce must not run");
        },
      },
    ),
    /all maps unavailable/,
  );
  assert.equal(reduceCalled, false);
});

test("DOCKET_SUMMARY_FAIL_HARD restores abort-on-any-map-failure", async () => {
  const oldFailHard = process.env.DOCKET_SUMMARY_FAIL_HARD;
  const chunks = chunksForPages(2);
  let reduceCalled = false;
  try {
    process.env.DOCKET_SUMMARY_FAIL_HARD = "1";
    await assert.rejects(
      summarizeDocumentWithCoverage(
        {
          ...baseArgs,
          chunks,
          pageCount: 2,
          maxBatchPages: 1,
          maxBatchCharacters: 2_000,
          mapConcurrency: 1,
          maxStageAttempts: 1,
        },
        {
          map: async ({ batch }) => {
            if (batch.id === "batch-1") throw new Error("fail-hard map");
            return JSON.stringify({
              points: [
                {
                  text: "Later point",
                  evidence: [
                    {
                      chunk_id: batch.chunks[0].chunk_id,
                      quote: batch.chunks[0].content.slice(0, 6),
                    },
                  ],
                },
              ],
            });
          },
          reduce: async () => {
            reduceCalled = true;
            throw new Error("reduce must not run");
          },
        },
      ),
      /fail-hard map/,
    );
    assert.equal(reduceCalled, false);
  } finally {
    restoreEnv("DOCKET_SUMMARY_FAIL_HARD", oldFailHard);
  }
});

test("production entrypoint delegates map and reduce to injected completeText", async () => {
  const chunks = chunksForPages(1);
  const calls: { model: string; maxTokens?: number }[] = [];
  const responses = [
    `Here is the requested JSON:\n${JSON.stringify({
      points: [
        {
          text: "한 페이지 요약",
          evidence: [
            {
              chunk_id: chunks[0].chunk_id,
              quote: chunks[0].content.slice(0, 6),
            },
          ],
        },
      ],
    })}\nDone.`,
    `Result:\n${JSON.stringify({
      title: "문서 요약",
      sections: [
        {
          heading: "핵심",
          points: [
            {
              text: "한 페이지 요약",
              evidence_ids: ["batch-1-point-1-evidence-1"],
            },
          ],
        },
      ],
    })}\nEnd.`,
  ];

  const result = await summarizeDocumentWithCoverage(
    { ...baseArgs, model: "selected-model", chunks, pageCount: 1 },
    {
      complete: async (params) => {
        calls.push({
          model: params.model,
          maxTokens: params.maxTokens,
        });
        const response = responses.shift();
        assert.ok(response);
        return response;
      },
    },
  );

  assert.deepEqual(calls, [
    { model: "selected-model", maxTokens: 3_072 },
    { model: "selected-model", maxTokens: 6_144 },
  ]);
  assert.match(result.preparedText, /# 문서 요약/);
});

test("Ollama reduce thinking leaves map thinking off and accepts fenced JSON", async () => {
  const oldReduceThinking = process.env.DOCKET_SUMMARY_REDUCE_THINKING;
  const oldSinglePassBudget = process.env.DOCKET_SUMMARY_SINGLE_PASS_CHARS;
  const chunks = chunksForPages(1);
  const calls: { think?: boolean; hasSchema: boolean }[] = [];
  try {
    process.env.DOCKET_SUMMARY_REDUCE_THINKING = "true";
    process.env.DOCKET_SUMMARY_SINGLE_PASS_CHARS = "0";
    const result = await summarizeDocumentWithCoverage(
      {
        ...baseArgs,
        model: "ollama:test-model",
        chunks,
        pageCount: 1,
        maxStageAttempts: 1,
      },
      {
        complete: async (params) => {
          calls.push({
            think: params.think,
            hasSchema: params.responseJsonSchema !== undefined,
          });
          if (!params.think) {
            return JSON.stringify({
              points: [
                {
                  text: "Map extraction",
                  evidence: [
                    {
                      chunk_id: chunks[0].chunk_id,
                      quote: chunks[0].content.slice(0, 6),
                    },
                  ],
                },
              ],
            });
          }
          return `Reasoning complete.\n\`\`\`json\n${JSON.stringify({
            title: "Thinking synthesis",
            sections: [
              {
                heading: "Result",
                points: [
                  {
                    text: "Fenced reduce output",
                    evidence_ids: ["batch-1-point-1-evidence-1"],
                  },
                ],
              },
            ],
          })}\n\`\`\``;
        },
      },
    );

    assert.deepEqual(calls, [
      { think: false, hasSchema: true },
      { think: true, hasSchema: false },
    ]);
    assert.match(result.preparedText, /# Thinking synthesis/);
    assert.match(result.preparedText, /Fenced reduce output/);
  } finally {
    restoreEnv("DOCKET_SUMMARY_REDUCE_THINKING", oldReduceThinking);
    restoreEnv("DOCKET_SUMMARY_SINGLE_PASS_CHARS", oldSinglePassBudget);
  }
});

test("validated summaries are reused only for an identical document version and request", async () => {
  clearDocumentSummaryResultCache();
  const chunks = chunksForPages(1);
  let mapCalls = 0;
  let reduceCalls = 0;
  const dependencies = {
    cacheResults: true,
    map: async () => {
      mapCalls += 1;
      return JSON.stringify({
        points: [
          {
            text: "캐시 가능한 요약",
            evidence: [
              {
                chunk_id: chunks[0].chunk_id,
                quote: chunks[0].content.slice(0, 6),
              },
            ],
          },
        ],
      });
    },
    reduce: async () => {
      reduceCalls += 1;
      return JSON.stringify({
        title: "캐시 요약",
        sections: [
          {
            heading: "핵심",
            points: [
              {
                text: "캐시 가능한 요약",
                evidence_ids: ["batch-1-point-1-evidence-1"],
              },
            ],
          },
        ],
      });
    },
  };

  const first = await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks, pageCount: 1 },
    dependencies,
  );
  const cachedProgress: { completedBatches: number; totalBatches: number }[] =
    [];
  const second = await summarizeDocumentWithCoverage(
    {
      ...baseArgs,
      chunks,
      pageCount: 1,
      onProgress: ({ completedBatches, totalBatches }) => {
        cachedProgress.push({ completedBatches, totalBatches });
      },
    },
    dependencies,
  );

  assert.equal(mapCalls, 1);
  assert.equal(reduceCalls, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(cachedProgress, [{ completedBatches: 1, totalBatches: 1 }]);

  const changedChunks = chunks.map((chunk) => ({
    ...chunk,
    content: `${chunk.content} revised`,
    end_char: chunk.end_char + " revised".length,
  }));
  await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks: changedChunks, pageCount: 1 },
    {
      ...dependencies,
      map: async () => {
        mapCalls += 1;
        return JSON.stringify({
          points: [
            {
              text: "수정본 요약",
              evidence: [
                {
                  chunk_id: changedChunks[0].chunk_id,
                  quote: changedChunks[0].content.slice(0, 6),
                },
              ],
            },
          ],
        });
      },
    },
  );
  assert.equal(mapCalls, 2);
  assert.equal(reduceCalls, 2);
  clearDocumentSummaryResultCache();
});

test("a retry reuses validated map batches completed before a later batch failed", async () => {
  clearDocumentSummaryResultCache();
  const chunks = chunksForPages(2);
  const calls = new Map<string, number>();
  let secondBatchCanSucceed = false;
  const dependencies = {
    cacheResults: true,
    map: async ({
      batch,
    }: {
      batch: { id: string; chunks: readonly DocumentSummaryChunk[] };
    }) => {
      calls.set(batch.id, (calls.get(batch.id) ?? 0) + 1);
      if (batch.id === "batch-2" && !secondBatchCanSucceed) {
        return JSON.stringify({ wrong_field: [] });
      }
      return JSON.stringify({
        points: [
          {
            text: `${batch.id} 요약`,
            evidence: [
              {
                chunk_id: batch.chunks[0].chunk_id,
                quote: batch.chunks[0].content.slice(0, 6),
              },
            ],
          },
        ],
      });
    },
    reduce: async () =>
      JSON.stringify({
        title: "재시도 요약",
        sections: [
          {
            heading: "전 구간",
            points: [
              {
                text: "첫 구간",
                evidence_ids: ["batch-1-point-1-evidence-1"],
              },
              {
                text: "둘째 구간",
                evidence_ids: ["batch-2-point-1-evidence-1"],
              },
            ],
          },
        ],
      }),
  };
  const request = {
    ...baseArgs,
    chunks,
    pageCount: 2,
    maxBatchPages: 1,
    maxBatchCharacters: 2_000,
    maxStageAttempts: 1,
    mapConcurrency: 1,
    failHard: true,
  };

  await assert.rejects(
    summarizeDocumentWithCoverage(request, dependencies),
    DocumentSummaryValidationError,
  );
  secondBatchCanSucceed = true;
  const result = await summarizeDocumentWithCoverage(request, dependencies);

  assert.equal(calls.get("batch-1"), 1);
  assert.equal(calls.get("batch-2"), 2);
  assert.equal(result.coverage.processedChunkCount, 2);
  clearDocumentSummaryResultCache();
});

test("persistent batch cache skips hits and stores validated misses", async () => {
  const chunks = chunksForPages(2);
  const cachedFirstBatch = {
    batchId: "batch-1",
    points: [
      {
        text: "batch-1 cached summary",
        evidenceIds: ["batch-1-point-1-evidence-1"],
      },
    ],
    evidence: [
      {
        id: "batch-1-point-1-evidence-1",
        sourceBatchId: "batch-1",
        claim: "batch-1 cached summary",
        chunk: chunks[0],
        quote: chunks[0].content.slice(0, 6),
        quoteStart: 0,
        quoteEnd: 6,
      },
    ],
  };
  const reads: string[] = [];
  const writes: { key: string; batchId: string }[] = [];
  let mapCalls = 0;

  const result = await summarizeDocumentWithCoverage(
    {
      ...baseArgs,
      chunks,
      pageCount: 2,
      maxBatchPages: 1,
      maxBatchCharacters: 2_000,
      mapConcurrency: 1,
    },
    {
      batchCache: {
        get(key) {
          reads.push(key);
          return reads.length === 1 ? cachedFirstBatch : null;
        },
        set(key, summary) {
          writes.push({ key, batchId: summary.batchId });
        },
      },
      map: async ({ batch }) => {
        mapCalls += 1;
        return JSON.stringify({
          points: [
            {
              text: `${batch.id} mapped summary`,
              evidence: [
                {
                  chunk_id: batch.chunks[0].chunk_id,
                  quote: batch.chunks[0].content.slice(0, 6),
                },
              ],
            },
          ],
        });
      },
      reduce: async () =>
        JSON.stringify({
          title: "Persistent cache",
          sections: [
            {
              heading: "All batches",
              points: [
                {
                  text: "Cached first batch",
                  evidence_ids: ["batch-1-point-1-evidence-1"],
                },
                {
                  text: "Mapped second batch",
                  evidence_ids: ["batch-2-point-1-evidence-1"],
                },
              ],
            },
          ],
        }),
    },
  );

  assert.equal(mapCalls, 1);
  assert.equal(reads.length, 2);
  assert.notEqual(reads[0], reads[1]);
  assert.deepEqual(writes, [{ key: reads[1], batchId: "batch-2" }]);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(
    result.citations.map(({ chunk_id }) => chunk_id),
    ["chunk-1", "chunk-2"],
  );
});

test("a persistently malformed dense batch is split without weakening evidence validation", async () => {
  const chunks = chunksForPages(2);
  const mappedBatchIds: string[] = [];
  const result = await summarizeDocumentWithCoverage(
    {
      ...baseArgs,
      chunks,
      pageCount: 2,
      maxBatchPages: 2,
      maxBatchCharacters: 2_000,
      maxStageAttempts: 1,
    },
    {
      map: async ({ batch }) => {
        mappedBatchIds.push(batch.id);
        if (batch.id === "batch-1") {
          return JSON.stringify({ wrong_field: [] });
        }
        return JSON.stringify({
          points: [
            {
              text: `${batch.id} 요약`,
              evidence: [
                {
                  chunk_id: batch.chunks[0].chunk_id,
                  quote: batch.chunks[0].content.slice(0, 6),
                },
              ],
            },
          ],
        });
      },
      reduce: async ({ batchSummaries }) => {
        assert.equal(batchSummaries.length, 1);
        assert.equal(batchSummaries[0].batchId, "batch-1");
        assert.equal(batchSummaries[0].points.length, 2);
        return JSON.stringify({
          title: "분할 복구 요약",
          sections: [
            {
              heading: "전 구간",
              points: batchSummaries[0].points.map((point) => ({
                text: point.text,
                evidence_ids: [point.evidenceIds[0]],
              })),
            },
          ],
        });
      },
    },
  );

  assert.deepEqual(mappedBatchIds, ["batch-1", "batch-1a", "batch-1b"]);
  assert.equal(result.coverage.batchCount, 1);
  assert.equal(result.citations.length, 2);
});

test("bounded map concurrency preserves batch order while reducing external-model latency", async () => {
  const chunks = chunksForPages(8);
  let active = 0;
  let peak = 0;
  const completionOrder: string[] = [];

  const result = await summarizeDocumentWithCoverage(
    {
      ...baseArgs,
      model: "gemini-3-flash-preview",
      chunks,
      pageCount: 8,
      maxBatchPages: 1,
      maxBatchCharacters: 2_000,
      mapConcurrency: 3,
    },
    {
      map: async ({ batch }) => {
        active += 1;
        peak = Math.max(peak, active);
        const page = batch.chunks[0].page_number ?? 0;
        await new Promise((resolve) => setTimeout(resolve, (9 - page) * 2));
        active -= 1;
        completionOrder.push(batch.id);
        return JSON.stringify({
          points: [
            {
              text: `${batch.id} 요약`,
              evidence: [
                {
                  chunk_id: batch.chunks[0].chunk_id,
                  quote: batch.chunks[0].content.slice(0, 6),
                },
              ],
            },
          ],
        });
      },
      reduce: async ({ batchSummaries }) => {
        assert.deepEqual(
          batchSummaries.map((summary) => summary.batchId),
          Array.from({ length: 8 }, (_, index) => `batch-${index + 1}`),
        );
        return JSON.stringify({
          title: "병렬 전체 요약",
          sections: [
            {
              heading: "전 구간",
              points: batchSummaries.map((summary) => ({
                text: summary.points[0].text,
                evidence_ids: [summary.points[0].evidenceIds[0]],
              })),
            },
          ],
        });
      },
    },
  );

  assert.equal(peak, 3);
  assert.notDeepEqual(
    completionOrder,
    Array.from({ length: 8 }, (_, index) => `batch-${index + 1}`),
  );
  assert.equal(result.coverage.processedChunkCount, 8);
});

test("invalid map evidence is retried once with validation feedback", async () => {
  const chunks = chunksForPages(1);
  let attempts = 0;
  const result = await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks, pageCount: 1, maxStageAttempts: 2 },
    {
      map: async ({ userPrompt }) => {
        attempts += 1;
        if (attempts === 1) {
          return JSON.stringify({
            points: [
              {
                text: "근거 오류",
                evidence: [
                  {
                    chunk_id: chunks[0].chunk_id,
                    quote: "not in source",
                  },
                ],
              },
            ],
          });
        }
        assert.match(userPrompt, /Validation feedback:/);
        return JSON.stringify({
          points: [
            {
              text: "수정된 요약",
              evidence: [
                {
                  chunk_id: chunks[0].chunk_id,
                  quote: chunks[0].content.slice(0, 6),
                },
              ],
            },
          ],
        });
      },
      reduce: async ({ batchSummaries }) =>
        JSON.stringify({
          title: "재시도 요약",
          sections: [
            {
              heading: "핵심",
              points: [
                {
                  text: "수정된 요약",
                  evidence_ids: [batchSummaries[0].points[0].evidenceIds[0]],
                },
              ],
            },
          ],
        }),
    },
  );

  assert.equal(attempts, 2);
  assert.match(result.preparedText, /수정된 요약/);
});

test("reduce retries when it omits an evidence-bearing batch", async () => {
  const chunks = chunksForPages(2);
  let attempts = 0;
  const result = await summarizeDocumentWithCoverage(
    {
      ...baseArgs,
      chunks,
      pageCount: 2,
      maxBatchPages: 1,
      maxBatchCharacters: 2_000,
      maxStageAttempts: 2,
    },
    {
      map: async ({ batch }) =>
        JSON.stringify({
          points: [
            {
              text: `${batch.id} 핵심`,
              evidence: [
                {
                  chunk_id: batch.chunks[0].chunk_id,
                  quote: batch.chunks[0].content.slice(0, 6),
                },
              ],
            },
          ],
        }),
      reduce: async ({ batchSummaries, userPrompt }) => {
        attempts += 1;
        if (attempts === 1) {
          return JSON.stringify({
            title: "불완전 요약",
            sections: [
              {
                heading: "일부",
                points: [
                  {
                    text: "첫 구간만 반영",
                    evidence_ids: [batchSummaries[0].points[0].evidenceIds[0]],
                  },
                ],
              },
            ],
          });
        }
        assert.match(userPrompt, /Validation feedback:/);
        return JSON.stringify({
          title: "완전 요약",
          sections: [
            {
              heading: "전 구간",
              points: batchSummaries.map((summary) => ({
                text: summary.points[0].text,
                evidence_ids: [summary.points[0].evidenceIds[0]],
              })),
            },
          ],
        });
      },
    },
  );

  assert.equal(attempts, 2);
  assert.match(result.preparedText, /batch-1 핵심/);
  assert.match(result.preparedText, /batch-2 핵심/);
});

test("reduce output wrapped in a ```json code fence is still parsed", async () => {
  const content = "Intro. The facility amount is KRW 100 billion. Tail.";
  const quote = "The facility amount is KRW 100 billion.";
  const chunks: DocumentSummaryChunk[] = [
    {
      chunk_id: "chunk-fence",
      chunk_index: 0,
      page_number: 7,
      page_end: 7,
      content,
      start_char: 0,
      end_char: content.length,
    },
  ];

  const result = await summarizeDocumentWithCoverage(
    { ...baseArgs, chunks, pageCount: 7, language: "Korean" },
    {
      map: async () =>
        JSON.stringify({
          points: [
            { text: "요점", evidence: [{ chunk_id: "chunk-fence", quote }] },
          ],
        }),
      // Local models frequently wrap structured output in a markdown fence.
      // The reduce parser must strip it before schema validation.
      reduce: async ({ batchSummaries }) =>
        "```json\n" +
        JSON.stringify({
          title: "제목",
          sections: [
            {
              heading: "섹션",
              points: [
                {
                  text: "결론",
                  evidence_ids: [batchSummaries[0].points[0].evidenceIds[0]],
                },
              ],
            },
          ],
        }) +
        "\n```",
    },
  );

  assert.equal(result.citations.length, 1);
  assert.match(result.preparedText, /# 제목/);
  assert.match(result.preparedText, /결론/);
});
