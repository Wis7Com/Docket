import test from "node:test";
import assert from "node:assert/strict";
import {
    PROJECT_EXTRA_TOOLS,
    boundDocumentToolResult,
    documentToolResultMaxCharsForModel,
    buildWorkflowStore,
    extractAnnotations,
    filterDocContext,
    filterToolsByDisabled,
    extractAnnotationContext,
    fetchUserPdfAnnotations,
    readAnnotationContexts,
    resolveSearchDocumentIds,
    sanitizeAssistantVisibleText,
    validateCitationContract,
    type DocIndex,
    type DocStore,
} from "./chatTools";
import { BUILTIN_WORKFLOWS } from "./builtinWorkflows";

const EXPECTED_BACKEND_BUILTIN_WORKFLOW_IDS = [
  "builtin-cp-checklist",
  "builtin-issue-comparison",
  "builtin-credit-summary",
  "builtin-sha-summary",
];

const docIndex: DocIndex = {
  "doc-0": {
    document_id: "document-a",
    filename: "credit-agreement.pdf",
    version_id: "version-a",
    version_number: 3,
  },
  "doc-1": {
    document_id: "document-b",
    filename: "shareholders-agreement.pdf",
    version_id: null,
    version_number: null,
  },
};

test("boundDocumentToolResult redirects oversized full-document reads", () => {
  const oversized = "x".repeat(101);
  const result = boundDocumentToolResult(oversized, 100);
  const payload = JSON.parse(result) as Record<string, unknown>;

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "DOCUMENT_RESULT_TOO_LARGE");
  assert.equal(payload.original_characters, 101);
  assert.equal(payload.max_characters, 100);
  assert.equal(result.includes(oversized), false);
  assert.match(result, /search_project_documents/);
  assert.equal(boundDocumentToolResult("short", 100), "short");
});

test("local document tool budgets are stricter without changing remote budgets", () => {
  assert.equal(
    documentToolResultMaxCharsForModel("ollama:gemma4:12b-mlx", 300_000),
    96_000,
  );
  assert.equal(
    documentToolResultMaxCharsForModel(
      "mlx:mlx-community/gemma-4-26b-a4b-it-4bit",
      80_000,
    ),
    80_000,
  );
  assert.equal(
    documentToolResultMaxCharsForModel("claude-sonnet-4-6", 300_000),
    300_000,
  );
});

test("project search tool exposes opt-in document discovery grouping", () => {
    const searchTool = PROJECT_EXTRA_TOOLS.find(
        (tool) => tool.function.name === "search_project_documents",
    );
    assert.ok(searchTool);
    const grouping = searchTool.function.parameters.properties.group_by_document;
    assert.ok(grouping);
    assert.equal(grouping.type, "boolean");
    assert.deepEqual(searchTool.function.parameters.required, ["query"]);
});

test("project chat exposes a dedicated annotation retrieval tool", () => {
    const annotationTool = PROJECT_EXTRA_TOOLS.find(
        (tool) => tool.function.name === "get_user_pdf_annotations",
    );
    assert.ok(annotationTool);
    assert.match(annotationTool.function.description, /hilighted/i);
    assert.match(annotationTool.function.description, /하이라이트/);
    assert.match(annotationTool.function.description, /Do not substitute/i);
});

test("filterToolsByDisabled is deny-only and ignores unknown tool names", () => {
    const tools = PROJECT_EXTRA_TOOLS.slice(0, 4);
    const filtered = filterToolsByDisabled(tools, [
        "get_user_pdf_annotations",
        "not_a_server_tool",
    ]);
    assert.deepEqual(
        filtered.map(
            (tool) =>
                (tool as { function: { name: string } }).function.name,
        ),
        ["read_annotation_context", "list_documents", "search_project_documents"],
    );
});

type AnnotationTestRow = Record<string, unknown>;

class AnnotationQuery {
  private filters: Array<(row: AnnotationTestRow) => boolean> = [];
  constructor(private readonly rows: AnnotationTestRow[]) {}
  select() { return this; }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value); return this;
  }
  neq(column: string, value: unknown) {
    this.filters.push((row) => row[column] !== value); return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column])); return this;
  }
  is(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value); return this;
  }
  not(column: string, op: string, value: unknown) {
    assert.equal(op, "is");
    this.filters.push((row) => row[column] !== value); return this;
  }
  then<TResult1 = { data: AnnotationTestRow[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: AnnotationTestRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve({
      data: this.rows.filter((row) => this.filters.every((filter) => filter(row))),
      error: null,
    }).then(onfulfilled, onrejected);
  }
}

function annotationDb(rows: AnnotationTestRow[]) {
  return { from: () => new AnnotationQuery(rows) } as never;
}

test("fetchUserPdfAnnotations scopes rows to matched docs, user query, and current version", async () => {
    const rows = [
        {
            id: "keep",
            document_id: "document-a",
            version_id: "version-a",
            page_number: 12,
            annotation_type: "highlight",
            color: "#ffff00",
            quote: "The DAO may appoint a manager.",
            comment: null,
            source: "user",
            created_at: "2026-07-10T12:00:00Z",
            deleted_at: null,
        },
        {
            id: "old-version",
            document_id: "document-a",
            version_id: "version-old",
            page_number: 3,
            annotation_type: "highlight",
            color: "#ffff00",
            quote: "Stale text",
            comment: null,
            source: "user",
            created_at: "2026-07-09T12:00:00Z",
            deleted_at: null,
        },
        {
            id: "other-doc",
            document_id: "document-b",
            version_id: null,
            page_number: 1,
            annotation_type: "comment",
            color: "#ff0000",
            quote: null,
            comment: "Not part of the requested filename",
            source: "user",
            created_at: "2026-07-08T12:00:00Z",
            deleted_at: null,
        },
    ];
    const result = await fetchUserPdfAnnotations({
        userId: "user-a",
        db: annotationDb(rows.map((row) => ({ ...row, user_id: "user-a" }))),
        docIndex,
        documentQuery: "credit agreement",
    });

    assert.equal(result.total, 1);
    assert.equal(result.returned, 1);
    assert.deepEqual(result.annotations, [
        {
            id: "keep",
            doc_id: "doc-0",
            document_id: "document-a",
            filename: "credit-agreement.pdf",
            version_id: "version-a",
            page: 12,
            type: "highlight",
            color: "#ffff00",
            color_family: "yellow",
            quote: "The DAO may appoint a manager.",
            comment: null,
            source: "user",
            created_at: "2026-07-10T12:00:00Z",
        },
    ]);
    assert.equal((result.summary as { project_total: number }).project_total, 2);
});

test("fetchUserPdfAnnotations applies filters and filtered summaries", async () => {
  const rows = [
    { id: "red", user_id: "user-a", document_id: "document-a", version_id: "version-a", page_number: 3, annotation_type: "highlight", color: "#ff8787", quote: "red", comment: "note", source: "user", created_at: "2026-01-01T00:00:00Z", deleted_at: null },
    { id: "blue", user_id: "user-a", document_id: "document-a", version_id: "version-a", page_number: 4, annotation_type: "highlight", color: "#74c0fc", quote: "blue", comment: null, source: "citation_promotion", created_at: "2026-01-02T00:00:00Z", deleted_at: null },
    { id: "gray", user_id: "user-a", document_id: "document-b", version_id: null, page_number: 1, annotation_type: "comment", color: "#dfdfdf", quote: null, comment: "", source: "user", created_at: "2026-01-03T00:00:00Z", deleted_at: null },
  ];
  const red = await fetchUserPdfAnnotations({
    userId: "user-a", db: annotationDb(rows), docIndex,
    colorFamily: ["red"], source: "user", hasComment: true,
  });
  assert.deepEqual((red.annotations as Array<{ id: string }>).map((row) => row.id), ["red"]);
  assert.deepEqual(red.summary, {
    total: 1,
    project_total: 3,
    by_color: [{ color: "#ff8787", color_family: "red", count: 1 }],
    by_document: [{ doc_id: "document-a", filename: "credit-agreement.pdf", count: 1 }],
    by_type: { highlight: 1 },
    by_source: { user: 1 },
    with_comment: 1,
  });
  const exact = await fetchUserPdfAnnotations({
    userId: "user-a", db: annotationDb(rows), docIndex,
    colors: ["#74C0FC"], source: "citation_promotion", hasComment: false,
  });
  assert.deepEqual((exact.annotations as Array<{ id: string }>).map((row) => row.id), ["blue"]);
  const recent = await fetchUserPdfAnnotations({
    userId: "user-a", db: annotationDb(rows), docIndex, hasComment: false, order: "recent",
  });
  assert.deepEqual((recent.annotations as Array<{ id: string }>).map((row) => row.id), ["gray", "blue"]);
});

test("fetchUserPdfAnnotations paginates 900 rows without duplicates or the old cap", async () => {
  const rows = Array.from({ length: 900 }, (_, index) => ({
    id: `annotation-${index.toString().padStart(4, "0")}`,
    user_id: "user-a",
    document_id: index % 2 ? "document-b" : "document-a",
    version_id: index % 2 ? null : "version-a",
    page_number: Math.floor(index / 2) + 1,
    annotation_type: "highlight",
    color: index % 2 ? "#74c0fc" : "#feffa0",
    quote: `quote ${index}`,
    comment: null,
    source: "user",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    deleted_at: null,
  }));
  const first = await fetchUserPdfAnnotations({ userId: "user-a", db: annotationDb(rows), docIndex, limit: 100 });
  const second = await fetchUserPdfAnnotations({ userId: "user-a", db: annotationDb(rows), docIndex, limit: 100, offset: 100 });
  const firstIds = (first.annotations as Array<{ id: string }>).map((row) => row.id);
  const secondIds = (second.annotations as Array<{ id: string }>).map((row) => row.id);
  assert.equal(first.total, 900);
  assert.equal(first.next_offset, 100);
  assert.equal(new Set([...firstIds, ...secondIds]).size, 200);
  assert.equal((first.summary as { project_total: number }).project_total, 900);
});

test("annotation context locates same-page and cross-chunk quotes", () => {
  assert.deepEqual(extractAnnotationContext({
    quote: "target phrase", page: 1, radius: 7,
    chunks: [{ chunk_id: "chunk-single", chunk_index: 0, page_number: 1, content: "prefix target phrase suffix", start_char: 0, end_char: 27 }],
  }), {
    before: "prefix ", after: " suffix", located: true,
    chunk_id: "chunk-single", indexed_quote: "target phrase",
  });
  const spanning = extractAnnotationContext({
    quote: "boundary overlap phrase", page: 2, radius: 20,
    chunks: [
      { chunk_id: "chunk-start", chunk_index: 0, page_number: 2, content: "before boundary overlap", start_char: 0, end_char: 23 },
      { chunk_id: "chunk-end", chunk_index: 1, page_number: 2, content: "overlap phrase after", start_char: 16, end_char: 36 },
    ],
  });
  assert.equal(spanning.located, true);
  assert.match(spanning.before, /before/);
  assert.match(spanning.after, /after/);
  assert.equal(spanning.chunk_id, "chunk-start");
  assert.equal(spanning.indexed_quote, "boundary overlap");
  assert.equal("before boundary overlap".includes(spanning.indexed_quote ?? ""), true);
});

test("annotation context returns bounded page text when a quote is absent", () => {
  const context = extractAnnotationContext({
    quote: "missing", page: 5, radius: 5,
    chunks: [{ chunk_id: "chunk-fallback", chunk_index: 2, page_number: 5, content: "abcdefghijklmno", start_char: 0, end_char: 15 }],
  });
  assert.deepEqual(context, { before: "", after: "", located: false, page_text: "abcdefghij" });
  assert.equal("chunk_id" in context, false);
  assert.equal("indexed_quote" in context, false);
});

test("readAnnotationContexts caps ids and radius and prevents cross-document access", async () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `id-${index}`, user_id: "user-a", document_id: "document-a", version_id: "version-a",
    page_number: 1, annotation_type: "highlight", color: "#feffa0", quote: `quote ${index}`,
    comment: null, source: "user", created_at: "2026-01-01T00:00:00Z", deleted_at: null,
  }));
  rows.push({ ...rows[0], id: "outside", document_id: "outside-document", version_id: "outside-version" });
  const result = await readAnnotationContexts({
    userId: "user-a", db: annotationDb(rows), docIndex,
    annotationIds: [...rows.map((row) => row.id), "outside"], radius: 9999,
    loadChunks: () => [{ chunk_id: "annotations-chunk", chunk_index: 0, page_number: 1, content: rows.map((row) => row.quote).join(" -- "), start_char: 0, end_char: 500 }],
  });
  assert.equal(result.requested, 20);
  assert.equal(result.returned, 20);
  assert.equal(result.radius, 2000);
  assert.equal((result.contexts as Array<{ annotation_id: string }>).some((row) => row.annotation_id === "outside"), false);
  const firstContext = (result.contexts as Array<{ chunk_id?: string; indexed_quote?: string }>)[0];
  assert.equal(firstContext.chunk_id, "annotations-chunk");
  assert.equal(firstContext.indexed_quote, "quote 0");
});

test("filterDocContext preserves original slugs while filtering every context map", () => {
  const store: DocStore = new Map([
    [
      "doc-0",
      {
        storage_path: "a.pdf",
        file_type: "pdf",
        filename: "credit-agreement.pdf",
      },
    ],
    [
      "doc-1",
      {
        storage_path: "b.pdf",
        file_type: "pdf",
        filename: "shareholders-agreement.pdf",
      },
    ],
  ]);
  const paths = new Map([
    ["doc-0", "Pleadings / Claimant"],
    ["doc-1", "Pleadings / Respondent"],
  ]);

  const filtered = filterDocContext(
    docIndex,
    store,
    paths,
    ["document-b"],
  );

  assert.deepEqual(Object.keys(filtered.docIndex), ["doc-1"]);
  assert.deepEqual([...filtered.docStore.keys()], ["doc-1"]);
  assert.deepEqual([...filtered.folderPaths.entries()], [
    ["doc-1", "Pleadings / Respondent"],
  ]);
});

test("resolveSearchDocumentIds maps slugs and intersects the enforced source scope", () => {
  assert.deepEqual(resolveSearchDocumentIds(["doc-0"], docIndex), {
    documentIds: ["document-a"],
  });
  assert.deepEqual(
    resolveSearchDocumentIds(
      ["doc-0", "doc-1", "unknown"],
      docIndex,
      ["document-b"],
    ),
    { documentIds: ["document-b"] },
  );
  assert.match(
    resolveSearchDocumentIds(["unknown"], docIndex).error ?? "",
    /None of the requested doc_ids/,
  );
  assert.deepEqual(resolveSearchDocumentIds(undefined, docIndex, ["document-b"]), {
    documentIds: ["document-b"],
  });
});

test("extractAnnotations preserves citation metadata for inline markers", () => {
  const text = `The borrower must deliver CPs [1].

<CITATIONS>
[
  {"ref":1,"doc_id":"doc-0","page":7,"quote":"deliver each Condition Precedent"}
]
</CITATIONS>`;

  assert.deepEqual(extractAnnotations(text, docIndex), [
    {
      type: "citation_data",
      ref: 1,
      doc_id: "doc-0",
      document_id: "document-a",
      version_id: "version-a",
      version_number: 3,
      filename: "credit-agreement.pdf",
      page: 7,
      quote: "deliver each Condition Precedent",
    },
  ]);
});

test("extractAnnotations supports multiple refs and page ranges", () => {
  const text = `The agreement covers CPs [1] and transfer rights [2].

<CITATIONS>
[
  {"ref":1,"doc_id":"doc-0","page":"41-42","quote":"conditions precedent are listed"},
  {"ref":2,"doc_id":"doc-1","page":12,"quote":"shares may not be transferred"}
]
</CITATIONS>`;

  const annotations = extractAnnotations(text, docIndex) as Record<
    string,
    unknown
  >[];

  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].page, "41-42");
  assert.equal(annotations[0].quote, "conditions precedent are listed");
  assert.equal(annotations[1].document_id, "document-b");
  assert.equal(annotations[1].filename, "shareholders-agreement.pdf");
});

test("citation contract fails closed on duplicate or out-of-order refs", () => {
  const text = `Waterfall [3]. Legal uncertainty [2].

<CITATIONS>
[
  {"ref":2,"doc_id":"doc-0","page":2,"quote":"uncertainty"},
  {"ref":3,"doc_id":"doc-0","page":3,"quote":"waterfall"},
  {"ref":2,"doc_id":"doc-0","page":3,"quote":"control"}
]
</CITATIONS>`;
  const citations = [
    { ref: 2, doc_id: "doc-0", page: 2, quote: "uncertainty" },
    { ref: 3, doc_id: "doc-0", page: 3, quote: "waterfall" },
    { ref: 2, doc_id: "doc-0", page: 3, quote: "control" },
  ];

  const result = validateCitationContract(text, citations, docIndex);

  assert.deepEqual(result.citations, []);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ["duplicate_ref", "invalid_ref_sequence"],
  );
});

test("citation contract accepts exactly one sequential marker per source", () => {
  const text = `Waterfall [1]. Control [2].

<CITATIONS>
[
  {"ref":1,"doc_id":"doc-0","page":2,"quote":"waterfall"},
  {"ref":2,"doc_id":"doc-0","page":3,"quote":"control"}
]
</CITATIONS>`;
  const citations = [
    { ref: 1, doc_id: "doc-0", page: 2, quote: "waterfall" },
    { ref: 2, doc_id: "doc-0", page: 3, quote: "control" },
  ];

  const result = validateCitationContract(text, citations, docIndex);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.citations, citations);
});

test("extractAnnotations ignores malformed citation blocks without crashing", () => {
  const text = `The answer has a bad citation block [1].

<CITATIONS>
not json
</CITATIONS>`;

  assert.deepEqual(extractAnnotations(text, docIndex), []);
});

test("sanitizeAssistantVisibleText removes internal labels and unsupported markers", () => {
  const text = `The credit-agreement.pdf(doc-0) point is supported [1].

The source sentence also had a page-looking marker [19], and doc-1 should not be exposed.

<CITATIONS>
[
  {"ref":1,"doc_id":"doc-0","page":7,"quote":"deliver each Condition Precedent"}
]
</CITATIONS>`;

  assert.equal(
    sanitizeAssistantVisibleText(
      text,
      [{ ref: 1, doc_id: "doc-0", filename: "credit-agreement.pdf" }],
      docIndex,
    ),
    `The credit-agreement.pdf point is supported [1].

The source sentence also had a page-looking marker, and shareholders-agreement.pdf should not be exposed.`,
  );
});

type WorkflowRow = {
  id: string;
  user_id: string;
  title: string;
  prompt_md: string;
  type: string;
};
type ShareRow = { workflow_id: string; shared_with_email: string };

class FakeQuery<T extends Record<string, unknown>> {
  private filters: { col: string; value: unknown; op: "eq" | "in" }[] = [];

  constructor(private readonly rows: T[]) {}

  select(): this {
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push({ col, value, op: "eq" });
    return this;
  }

  in(col: string, value: unknown[]): this {
    this.filters.push({ col, value, op: "in" });
    return this;
  }

  then<TResult1 = { data: T[]; error: null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: T[];
          error: null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const filtered = this.rows.filter((row) =>
      this.filters.every((filter) => {
        if (filter.op === "eq") return row[filter.col] === filter.value;
        return (filter.value as unknown[]).includes(row[filter.col]);
      }),
    );
    return Promise.resolve({ data: filtered, error: null }).then(
      onfulfilled,
      onrejected,
    );
  }
}

function fakeDb(args: { workflows: WorkflowRow[]; shares: ShareRow[] }) {
  return {
    from(table: string) {
      if (table === "workflows") return new FakeQuery(args.workflows);
      if (table === "workflow_shares") return new FakeQuery(args.shares);
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

test("buildWorkflowStore seeds built-ins and overlays user/shared assistant workflows", async () => {
  const db = fakeDb({
    workflows: [
      {
        id: "owned-assistant",
        user_id: "local-user",
        title: "Owned Assistant",
        prompt_md: "owned prompt",
        type: "assistant",
      },
      {
        id: "owned-tabular",
        user_id: "local-user",
        title: "Owned Tabular",
        prompt_md: "tabular prompt",
        type: "tabular",
      },
      {
        id: "shared-assistant",
        user_id: "someone-else",
        title: "Shared Assistant",
        prompt_md: "shared prompt",
        type: "assistant",
      },
    ],
    shares: [
      {
        workflow_id: "shared-assistant",
        shared_with_email: "user@example.com",
      },
    ],
  });

  const store = await buildWorkflowStore(
    "local-user",
    "USER@example.com",
    db as never,
  );

  assert.equal(
    store.get(BUILTIN_WORKFLOWS[0].id)?.prompt_md,
    BUILTIN_WORKFLOWS[0].prompt_md,
  );
  assert.equal(store.get("owned-assistant")?.prompt_md, "owned prompt");
  assert.equal(store.has("owned-tabular"), false);
  assert.equal(store.get("shared-assistant")?.prompt_md, "shared prompt");
});

test("backend assistant built-in workflows keep the upstream Mike catalog", () => {
  assert.deepEqual(
    BUILTIN_WORKFLOWS.map((workflow) => workflow.id),
    EXPECTED_BACKEND_BUILTIN_WORKFLOW_IDS,
  );
  for (const workflow of BUILTIN_WORKFLOWS) {
    assert.ok(workflow.title.trim(), `${workflow.id} should have a title`);
    assert.ok(
      workflow.prompt_md.includes("## "),
      `${workflow.id} should keep a structured prompt`,
    );
  }
});
