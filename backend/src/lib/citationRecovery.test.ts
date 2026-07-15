import test from "node:test";
import assert from "node:assert/strict";
import {
  recoverNamedQuotedCitation,
  recoverNamedQuotedCitations,
  type CitationEvidenceRow,
  type CitationRecoveryDocIndex,
} from "./citationRecovery";

const docIndex: CitationRecoveryDocIndex = {
  "doc-0": {
    document_id: "document-a",
    filename: "agreement-a.pdf",
    version_id: "version-a",
  },
  "doc-1": {
    document_id: "document-b",
    filename: "agreement-b.pdf",
    version_id: "version-b",
  },
};

const rowsByDocument = new Map<string, CitationEvidenceRow[]>([
  [
    "document-a",
    [
      {
        chunk_id: "chunk-a-1",
        chunk_index: 0,
        page_number: 2,
        content: "The payment obligation survives every termination.",
        start_char: 0,
        end_char: 50,
      },
      {
        chunk_id: "chunk-a-2",
        chunk_index: 1,
        page_number: 4,
        content: "Notices must be delivered by registered mail.",
        start_char: 51,
        end_char: 97,
      },
    ],
  ],
  [
    "document-b",
    [
      {
        chunk_id: "chunk-b-1",
        chunk_index: 0,
        page_number: 7,
        content: "The payment obligation survives every termination.",
        start_char: 0,
        end_char: 50,
      },
    ],
  ],
]);

const loadRows = (doc: { document_id: string }) =>
  rowsByDocument.get(doc.document_id) ?? [];

test("recovers all uniquely named quotations with refs after existing citations", () => {
  const existing = [
    {
      ref: 5,
      doc_id: "doc-1",
      page: 1,
      quote: "An existing source quotation",
    },
  ];
  const result = recoverNamedQuotedCitations(
    'agreement-a.pdf says "The payment obligation survives every termination." It also says "Notices must be delivered by registered mail."',
    docIndex,
    existing,
    loadRows,
  );

  assert.equal(
    result.text,
    'agreement-a.pdf says "The payment obligation survives every termination." [6] It also says "Notices must be delivered by registered mail." [7]',
  );
  assert.deepEqual(
    result.citations.map(({ ref, doc_id, page }) => ({
      ref,
      doc_id,
      page,
    })),
    [
      { ref: 5, doc_id: "doc-1", page: 1 },
      { ref: 6, doc_id: "doc-0", page: 2 },
      { ref: 7, doc_id: "doc-0", page: 4 },
    ],
  );
  assert.deepEqual(existing, [
    {
      ref: 5,
      doc_id: "doc-1",
      page: 1,
      quote: "An existing source quotation",
    },
  ]);
});

test("skips ambiguous, unknown-named, and unsafe unnamed quotations", () => {
  const ambiguous = recoverNamedQuotedCitations(
    'The source says "The payment obligation survives every termination."',
    docIndex,
    [],
    loadRows,
  );
  assert.deepEqual(ambiguous.citations, []);

  const unknown = recoverNamedQuotedCitations(
    'missing.pdf says "The payment obligation survives every termination."',
    docIndex,
    [],
    loadRows,
  );
  assert.deepEqual(unknown.citations, []);

  const largeIndex = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `doc-${index}`,
      {
        document_id: `document-${index}`,
        filename: `source-${index}.pdf`,
      },
    ]),
  );
  let loads = 0;
  const large = recoverNamedQuotedCitations(
    'The source says "The payment obligation survives every termination."',
    largeIndex,
    [],
    () => {
      loads += 1;
      return [];
    },
  );
  assert.deepEqual(large.citations, []);
  assert.equal(loads, 0);
});

test("deduplicates normalized evidence and preserves continuous recovered refs", () => {
  const existing = [
    {
      ref: 3,
      doc_id: "doc-0",
      page: 2,
      quote: "THE PAYMENT OBLIGATION SURVIVES EVERY TERMINATION.",
    },
  ];
  const result = recoverNamedQuotedCitations(
    'agreement-a.pdf repeats "The payment obligation survives every termination." and adds "Notices must be delivered by registered mail."',
    docIndex,
    existing,
    loadRows,
  );

  assert.equal(result.text.includes("[4]"), true);
  assert.equal(result.text.includes("[5]"), false);
  assert.deepEqual(result.recoveredCitations, [
    {
      ref: 4,
      doc_id: "doc-0",
      page: 4,
      quote: "Notices must be delivered by registered mail.",
    },
  ]);
});

test("enforces quote length bounds and the twenty-citation cap", () => {
  const phrases = Array.from(
    { length: 22 },
    (_, index) => `Unique recoverable clause number ${index + 1}`,
  );
  const index: CitationRecoveryDocIndex = {
    "doc-0": {
      document_id: "document-cap",
      filename: "source.pdf",
    },
  };
  const rows: CitationEvidenceRow[] = phrases.map((phrase, index) => ({
    chunk_id: `chunk-${index}`,
    chunk_index: index,
    page_number: index + 1,
    content: `${phrase}.`,
    start_char: index * 50,
    end_char: index * 50 + phrase.length + 1,
  }));
  const body = [
    'source.pdf says "only two".',
    ...phrases.map((phrase) => `It says "${phrase}".`),
    `It says "${Array.from({ length: 26 }, () => "word").join(" ")}".`,
  ].join(" ");
  const result = recoverNamedQuotedCitations(body, index, [], () => rows);

  assert.equal(result.recoveredCitations.length, 20);
  assert.deepEqual(
    result.recoveredCitations.map((citation) => citation.ref),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert.equal(result.text.includes("[20]"), true);
  assert.equal(result.text.includes("[21]"), false);
});

test("the legacy API recovers only the first safe quotation", () => {
  const result = recoverNamedQuotedCitation(
    'agreement-a.pdf says "The payment obligation survives every termination." and "Notices must be delivered by registered mail."',
    docIndex,
    loadRows,
  );

  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].ref, 1);
  assert.equal(result.text.includes("[1]"), true);
  assert.equal(result.text.includes("[2]"), false);
});
