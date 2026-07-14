import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DIGEST_ITEMS,
  collectProjectAnnotations,
  type AnnotationContextChunk,
  type DocIndex,
} from "./chatTools";

type Row = Record<string, unknown>;

class AnnotationQuery {
  private readonly filters: Array<(row: Row) => boolean> = [];
  constructor(private readonly rows: Row[]) {}
  select() {
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  neq(column: string, value: unknown) {
    this.filters.push((row) => row[column] !== value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  is(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  not(column: string, op: string, value: unknown) {
    assert.equal(op, "is");
    this.filters.push((row) => row[column] !== value);
    return this;
  }
  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: Row[];
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

function annotationDb(rows: Row[]) {
  return { from: () => new AnnotationQuery(rows) } as never;
}

const docIndex: DocIndex = {
  "doc-0": {
    document_id: "document-a",
    filename: "brief.pdf",
    version_id: "version-a",
  },
};

function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `annotation-${index.toString().padStart(4, "0")}`,
    user_id: "user-a",
    document_id: "document-a",
    version_id: "version-a",
    page_number: index + 1,
    annotation_type: "highlight",
    color: "#51cf66",
    quote: `indexed quote ${index}`,
    comment: null,
    source: "user",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    deleted_at: null,
  }));
  const chunks: AnnotationContextChunk[] = rows.map((row, index) => ({
    chunk_id: `chunk-${index}`,
    chunk_index: index,
    page_number: index + 1,
    content: `prefix ${row.quote} suffix`,
    start_char: index * 100,
    end_char: index * 100 + 40,
  }));
  return { rows, chunks };
}

test("collectProjectAnnotations pages and grounds every item", async () => {
  const { rows, chunks } = fixture(250);
  const result = await collectProjectAnnotations({
    userId: "user-a",
    db: annotationDb(rows),
    docIndex,
    colorFamily: ["green"],
    loadChunks: () => chunks,
  });
  assert.equal(result.total, 250);
  assert.equal((result.summary as { total: number }).total, 250);
  assert.equal((result.items as unknown[]).length, 250);
  assert.equal(result.truncated, false);
  assert.equal(result.next_cursor, null);
  for (const item of result.items as Array<Record<string, unknown>>) {
    assert.equal(item.grounded, true);
    assert.equal(typeof item.indexed_quote, "string");
    assert.equal(typeof item.chunk_id, "string");
  }
});

test("collectProjectAnnotations enforces the hard cap and resumes by cursor", async () => {
  const { rows, chunks } = fixture(MAX_DIGEST_ITEMS + 1);
  const first = await collectProjectAnnotations({
    userId: "user-a",
    db: annotationDb(rows),
    docIndex,
    grounded: false,
  });
  assert.equal((first.items as unknown[]).length, MAX_DIGEST_ITEMS);
  assert.equal(first.truncated, true);
  assert.equal(first.next_cursor, MAX_DIGEST_ITEMS);
  assert.equal(
    (first.summary as { total: number }).total,
    MAX_DIGEST_ITEMS + 1,
  );

  const second = await collectProjectAnnotations({
    userId: "user-a",
    db: annotationDb(rows),
    docIndex,
    cursor: first.next_cursor as number,
    loadChunks: () => chunks,
  });
  assert.equal((second.items as unknown[]).length, 1);
  assert.equal(second.truncated, false);
  assert.equal(second.next_cursor, null);
  assert.equal(
    (second.items as Array<Record<string, unknown>>)[0].grounded,
    true,
  );
});

test("collectProjectAnnotations enforces party role and side scope", async () => {
  const scopedDocIndex: DocIndex = {
    "doc-0": {
      document_id: "document-a",
      filename: "plaintiff.pdf",
      version_id: "version-a",
      party_role: "plaintiff",
      party_side: "A",
    },
    "doc-1": {
      document_id: "document-b",
      filename: "defendant.pdf",
      version_id: "version-b",
      party_role: "defendant",
      party_side: "B",
    },
  };
  const { rows } = fixture(1);
  const defendantRow = {
    ...rows[0],
    id: "defendant-annotation",
    document_id: "document-b",
    version_id: "version-b",
  };
  const result = await collectProjectAnnotations({
    userId: "user-a",
    db: annotationDb([...rows, defendantRow]),
    docIndex: scopedDocIndex,
    partyRoles: ["defendant"],
    partySides: ["B"],
    grounded: false,
  });
  assert.equal(result.total, 1);
  assert.deepEqual(
    (result.items as Array<Record<string, unknown>>).map((item) => item.id),
    ["defendant-annotation"],
  );
});
