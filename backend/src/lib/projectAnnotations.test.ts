import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectDocMeta,
  fetchProjectAnnotations,
  parseProjectAnnotationQuery,
  type ProjectAnnotationDbRow,
  type ProjectAnnotationQuery,
  type ProjectDocMeta,
} from "./projectAnnotations";

type TestRow = ProjectAnnotationDbRow & { user_id: string };

class AnnotationQuery {
  private readonly filters: Array<(row: TestRow) => boolean> = [];

  constructor(private readonly rows: TestRow[]) {}

  select() {
    return this;
  }

  eq(column: keyof TestRow, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: keyof TestRow, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  is(column: keyof TestRow, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  then<TResult1 = { data: TestRow[]; error: null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: TestRow[];
          error: null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve({
      data: this.rows.filter((row) =>
        this.filters.every((filter) => filter(row)),
      ),
      error: null,
    }).then(onfulfilled, onrejected);
  }
}

function annotationDb(rows: TestRow[]) {
  return { from: () => new AnnotationQuery(rows) } as never;
}

const documents: ProjectDocMeta[] = [
  {
    document_id: "doc-a",
    filename: "Alpha.pdf",
    current_version_id: "version-a",
    folder_path: "Pleadings",
    party_role: "원고",
    party_side: "A",
  },
  {
    document_id: "doc-b",
    filename: "Beta.pdf",
    current_version_id: "version-b",
    folder_path: null,
    party_role: "defendant",
    party_side: "B",
  },
];

function row(id: string, overrides: Partial<TestRow> = {}): TestRow {
  return {
    id,
    user_id: "user-a",
    document_id: "doc-a",
    version_id: "version-a",
    page_number: 1,
    annotation_type: "highlight",
    color: "#00ff00",
    quote: id,
    comment: null,
    source: "user",
    created_at: "2026-07-10T12:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

function query(
  overrides: Partial<ProjectAnnotationQuery> = {},
): ProjectAnnotationQuery {
  return { order: "position", limit: 50, offset: 0, ...overrides };
}

test("scopes annotations to the user and each document's current version", async () => {
  const result = await fetchProjectAnnotations({
    db: annotationDb([
      row("current"),
      row("old", { version_id: "old-version" }),
      row("deleted", { deleted_at: "2026-07-11T00:00:00Z" }),
      row("other-user", { user_id: "user-b" }),
      row("other-document", { document_id: "doc-outside" }),
      row("second-doc", {
        document_id: "doc-b",
        version_id: "version-b",
      }),
    ]),
    userId: "user-a",
    documents,
    query: query(),
  });

  assert.deepEqual(
    result.annotations.map((annotation) => annotation.id),
    ["current", "second-doc"],
  );
  assert.equal(result.project_total, 2);
});

test("applies color filters while preserving faceted color counts", async () => {
  const result = await fetchProjectAnnotations({
    db: annotationDb([
      row("green", { color: "#00ff00" }),
      row("orange", { color: "#ff8800" }),
      row("green-comment", { color: "#88cc88", comment: "note" }),
    ]),
    userId: "user-a",
    documents,
    query: query({ color_family: ["green"] }),
  });

  assert.deepEqual(
    result.annotations.map((annotation) => annotation.id),
    ["green", "green-comment"],
  );
  assert.deepEqual(result.group_counts.by_color_family, [
    { color_family: "orange", count: 1 },
    { color_family: "green", count: 2 },
  ]);
  assert.equal(result.total, 2);
  assert.equal(result.project_total, 3);
});

test("combines document, type, comment, and source filters", async () => {
  const rows = [
    row("match", {
      document_id: "doc-b",
      version_id: "version-b",
      annotation_type: "comment",
      comment: "Review",
      source: "citation_promotion",
    }),
    row("wrong-doc", {
      annotation_type: "comment",
      comment: "Review",
      source: "citation_promotion",
    }),
    row("empty-comment", {
      document_id: "doc-b",
      version_id: "version-b",
      annotation_type: "comment",
      comment: "  ",
      source: "citation_promotion",
    }),
  ];
  const result = await fetchProjectAnnotations({
    db: annotationDb(rows),
    userId: "user-a",
    documents,
    query: query({
      doc_id: ["doc-b"],
      annotation_type: "comment",
      has_comment: true,
      source: "citation_promotion",
    }),
  });

  assert.deepEqual(
    result.annotations.map((annotation) => annotation.id),
    ["match"],
  );
  assert.deepEqual(result.group_counts.by_document, [
    { document_id: "doc-b", filename: "Beta.pdf", count: 1 },
  ]);
});

test("supports position and recent ordering plus non-overlapping pagination", async () => {
  const rows = [
    row("alpha-page-2", { page_number: 2, created_at: "2026-07-10T10:00:00Z" }),
    row("alpha-page-1", { page_number: 1, created_at: "2026-07-10T09:00:00Z" }),
    row("beta-recent", {
      document_id: "doc-b",
      version_id: "version-b",
      created_at: "2026-07-12T09:00:00Z",
    }),
  ];
  const first = await fetchProjectAnnotations({
    db: annotationDb(rows),
    userId: "user-a",
    documents,
    query: query({ limit: 2 }),
  });
  const second = await fetchProjectAnnotations({
    db: annotationDb(rows),
    userId: "user-a",
    documents,
    query: query({ limit: 2, offset: first.next_offset ?? 0 }),
  });
  const recent = await fetchProjectAnnotations({
    db: annotationDb(rows),
    userId: "user-a",
    documents,
    query: query({ order: "recent" }),
  });

  assert.deepEqual(
    first.annotations.map((item) => item.id),
    ["alpha-page-1", "alpha-page-2"],
  );
  assert.equal(first.next_offset, 2);
  assert.deepEqual(
    second.annotations.map((item) => item.id),
    ["beta-recent"],
  );
  assert.equal(second.next_offset, null);
  assert.equal(second.project_total, 3);
  assert.deepEqual(
    recent.annotations.map((item) => item.id),
    ["beta-recent", "alpha-page-2", "alpha-page-1"],
  );
});

test("paginates more than 300 annotations without overlap", async () => {
  const rows = Array.from({ length: 305 }, (_, index) =>
    row(`row-${String(index).padStart(3, "0")}`, {
      page_number: index + 1,
    }),
  );
  const seen: string[] = [];
  let offset = 0;
  let nextOffset: number | null = 0;
  while (nextOffset !== null) {
    const result = await fetchProjectAnnotations({
      db: annotationDb(rows),
      userId: "user-a",
      documents,
      query: query({ limit: 200, offset }),
    });
    seen.push(...result.annotations.map((annotation) => annotation.id));
    nextOffset = result.next_offset;
    if (nextOffset !== null) offset = nextOffset;
    assert.equal(result.project_total, 305);
  }
  assert.equal(seen.length, 305);
  assert.equal(new Set(seen).size, 305);
});

test("filters annotations by party role and stable party side", async () => {
  const result = await fetchProjectAnnotations({
    db: annotationDb([
      row("plaintiff"),
      row("defendant", {
        document_id: "doc-b",
        version_id: "version-b",
      }),
    ]),
    userId: "user-a",
    documents,
    query: query({ party_role: ["defendant"], party_side: ["B"] }),
  });
  assert.equal(result.total, 1);
  assert.equal(result.annotations[0].id, "defendant");
  assert.equal(result.warnings.length, 0);

  const legacyAlias = await fetchProjectAnnotations({
    db: annotationDb([
      row("plaintiff"),
      row("defendant", {
        document_id: "doc-b",
        version_id: "version-b",
      }),
    ]),
    userId: "user-a",
    documents,
    query: query({ party: "plaintiff" }),
  });
  assert.deepEqual(
    legacyAlias.annotations.map((annotation) => annotation.id),
    ["plaintiff"],
  );
});

test("parses CSV, booleans and numbers while preserving document ID case", () => {
  const parsed = parseProjectAnnotationQuery({
    color_family: "GREEN,orange",
    doc_id: "Doc-A,doc-b",
    has_comment: "false",
    limit: "20",
    offset: "4",
    party_role: "원고,defendant",
    party_side: "a,B",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.color_family, ["green", "orange"]);
  assert.deepEqual(parsed.value.doc_id, ["Doc-A", "doc-b"]);
  assert.equal(parsed.value.has_comment, false);
  assert.equal(parsed.value.limit, 20);
  assert.equal(parsed.value.offset, 4);
  assert.deepEqual(parsed.value.party_role, ["원고", "defendant"]);
  assert.deepEqual(parsed.value.party_side, ["A", "B"]);

  assert.equal(parseProjectAnnotationQuery({ limit: "0" }).ok, false);
  assert.equal(
    parseProjectAnnotationQuery({ color_family: "chartreuse" }).ok,
    false,
  );
  assert.equal(
    parseProjectAnnotationQuery({ has_comment: "sometimes" }).ok,
    false,
  );
});

test("buildProjectDocMeta resolves nested folder paths", () => {
  assert.deepEqual(
    buildProjectDocMeta(
      [
        {
          id: "doc",
          filename: "Evidence.pdf",
          current_version_id: "v1",
          folder_id: "child",
        },
      ],
      [
        { id: "root", name: "Evidence", parent_folder_id: null },
        { id: "child", name: "Exhibits", parent_folder_id: "root" },
      ],
    ),
    [
      {
        document_id: "doc",
        filename: "Evidence.pdf",
        current_version_id: "v1",
        folder_path: "Evidence / Exhibits",
      },
    ],
  );
});
