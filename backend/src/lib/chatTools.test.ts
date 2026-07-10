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
    fetchUserPdfAnnotations,
    resolveSearchDocumentIds,
    sanitizeAssistantVisibleText,
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
    const tools = PROJECT_EXTRA_TOOLS.slice(0, 3);
    const filtered = filterToolsByDisabled(tools, [
        "get_user_pdf_annotations",
        "not_a_server_tool",
    ]);
    assert.deepEqual(
        filtered.map(
            (tool) =>
                (tool as { function: { name: string } }).function.name,
        ),
        ["list_documents", "search_project_documents"],
    );
});

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
    const chain = {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        order() { return this; },
        async limit() { return { data: rows, error: null }; },
    };
    const result = await fetchUserPdfAnnotations({
        userId: "user-a",
        db: { from: () => chain } as never,
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
            quote: "The DAO may appoint a manager.",
            comment: null,
            source: "user",
            created_at: "2026-07-10T12:00:00Z",
        },
    ]);
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
