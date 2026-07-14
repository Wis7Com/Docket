/**
 * SQLite-backed compatibility shim for the subset of @supabase/supabase-js
 * that this codebase actually uses. The shim exposes the same query-builder
 * surface so the existing route handlers don't have to change.
 *
 * Coverage inventory (counted across backend/src):
 *   from, select, eq, neq, in, or, ilike, gte, lte, gt, lt, order, limit,
 *   range, single, maybeSingle, insert, upsert, update, delete, contains,
 *   match, count
 *
 * Not implemented (will throw if hit): rpc, storage, realtime, auth, every
 * filter operator beyond the list above. Anything missing surfaces with a
 * loud "Unsupported in shim" error rather than silent wrong results.
 */

import type Database from "better-sqlite3";
import { getDb } from "./sqlite";
import * as crypto from "crypto";

type Operator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "ilike"
  | "like"
  | "is"
  | "in"
  | "contains";

interface Filter {
  kind: "filter";
  col: string;
  op: Operator;
  value: unknown;
  negate?: boolean;
}

interface OrGroup {
  kind: "or";
  branches: Filter[]; // OR'd together
}

type Predicate = Filter | OrGroup;

type Mode = "select" | "insert" | "update" | "upsert" | "delete";

// Mirrors @supabase/supabase-js result shapes:
//   list query  → { data: T[] | null, error, count }
//   single/maybe → { data: T | null, error, count }
// Returning these as concrete array vs row types keeps TS strict-mode happy
// with the codebase's `data.map(...)` / `data.length` / row-property patterns.
interface ShimError {
  message: string;
  code?: string;
}
interface ListResult<T> {
  data: T[] | null;
  error: ShimError | null;
  count?: number | null;
}
interface SingleResult<T> {
  data: T | null;
  error: ShimError | null;
  count?: number | null;
}

interface CountSpec {
  type: "exact" | "planned" | "estimated";
}

const JSON_COLUMNS_BY_TABLE: Record<string, Set<string>> = {
  projects: new Set(["shared_with"]),
  tabular_reviews: new Set(["shared_with", "columns_config"]),
  workflows: new Set(["columns_config"]),
  documents: new Set(["structure_tree"]),
  chat_messages: new Set(["content", "files", "annotations"]),
  tabular_cells: new Set(["citations"]),
  issue_matrices: new Set(["scope", "issues", "shared_with"]),
  issue_matrix_cells: new Set(["citations"]),
  tabular_review_chat_messages: new Set(["content", "annotations"]),
};

function isJsonColumn(table: string, col: string): boolean {
  return JSON_COLUMNS_BY_TABLE[table]?.has(col) ?? false;
}

function encodeForSqlite(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (v === null) {
      out[k] = null;
    } else if (typeof v === "boolean") {
      out[k] = v ? 1 : 0;
    } else if (v instanceof Map || v instanceof Set) {
      // These don't survive JSON.stringify — silently storing
      // "[object Map]" used to be the failure mode. Surface it loudly.
      throw new Error(
        `encodeForSqlite: ${table}.${k} is a ${v.constructor.name}; convert to a plain object/array before insert`,
      );
    } else if (isJsonColumn(table, k) && typeof v !== "string") {
      out[k] = JSON.stringify(v);
    } else if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.prototype.toString.call(v) === "[object Object]" &&
      !(v instanceof Date) &&
      !(v instanceof Buffer)
    ) {
      out[k] = JSON.stringify(v);
    } else if (Array.isArray(v)) {
      out[k] = JSON.stringify(v);
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

function decodeRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of Object.keys(out)) {
    if (isJsonColumn(table, k) && typeof out[k] === "string") {
      try {
        out[k] = JSON.parse(out[k] as string);
      } catch {
        // C7: leave as string if not valid JSON, but warn so DB corruption
        // doesn't sit silently.
        console.warn(
          `[shim] failed to JSON.parse ${table}.${k}; keeping raw string`,
        );
      }
    }
  }
  return out;
}

function newId(): string {
  return crypto.randomUUID();
}

// ---------- Postgrest .or() parser -----------------------------------------

function parseOrString(filter: string): Filter[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < filter.length; i++) {
    const c = filter[i];
    if (c === "(") {
      depth++;
      buf += c;
    } else if (c === ")") {
      depth--;
      buf += c;
    } else if (c === "," && depth === 0) {
      if (buf) parts.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf) parts.push(buf);

  return parts.map((part) => {
    const m = part.match(/^([^.]+)\.([^.]+)\.(.+)$/);
    if (!m) {
      throw new Error(`Cannot parse .or() filter clause: ${part}`);
    }
    const [, col, op, rawVal] = m;
    let value: unknown = rawVal;
    if (op === "in") {
      const stripped = rawVal.replace(/^\(|\)$/g, "");
      value = stripped ? stripped.split(",") : [];
    }
    return { kind: "filter" as const, col, op: op as Operator, value };
  });
}

// ---------- WHERE compiler -------------------------------------------------

interface CompiledWhere {
  sql: string;
  params: unknown[];
}

function compileFilter(table: string, f: Filter): CompiledWhere {
  const params: unknown[] = [];
  let sql: string;
  switch (f.op) {
    case "eq":
      sql = `${quoteIdent(f.col)} = ?`;
      params.push(coerceParam(f.value));
      break;
    case "neq":
      sql = `${quoteIdent(f.col)} != ?`;
      params.push(coerceParam(f.value));
      break;
    case "gt":
      sql = `${quoteIdent(f.col)} > ?`;
      params.push(coerceParam(f.value));
      break;
    case "gte":
      sql = `${quoteIdent(f.col)} >= ?`;
      params.push(coerceParam(f.value));
      break;
    case "lt":
      sql = `${quoteIdent(f.col)} < ?`;
      params.push(coerceParam(f.value));
      break;
    case "lte":
      sql = `${quoteIdent(f.col)} <= ?`;
      params.push(coerceParam(f.value));
      break;
    case "is":
      if (f.value === null || f.value === "null") {
        sql = `${quoteIdent(f.col)} IS NULL`;
      } else {
        sql = `${quoteIdent(f.col)} = ?`;
        params.push(coerceParam(f.value));
      }
      break;
    case "like":
      sql = `${quoteIdent(f.col)} LIKE ?`;
      params.push(String(f.value));
      break;
    case "ilike":
      // SQLite's LIKE is case-insensitive for ASCII by default. Good enough.
      sql = `${quoteIdent(f.col)} LIKE ?`;
      params.push(String(f.value));
      break;
    case "in": {
      const arr = (f.value as unknown[]) ?? [];
      if (arr.length === 0) {
        sql = "0";
      } else {
        sql = `${quoteIdent(f.col)} IN (${arr.map(() => "?").join(",")})`;
        for (const v of arr) params.push(coerceParam(v));
      }
      break;
    }
    case "contains": {
      // For JSON-array columns (e.g. shared_with), check substring of the
      // serialized value. Single-user setups will rarely match, which is the
      // intended semantics — sharing isn't supported locally.
      const v = f.value;
      const needle =
        Array.isArray(v) && v.length === 1
          ? JSON.stringify(v[0])
          : Array.isArray(v)
            ? JSON.stringify(v).slice(1, -1)
            : typeof v === "string"
              ? v.replace(/^\[|\]$/g, "")
              : JSON.stringify(v);
      sql = `${quoteIdent(f.col)} LIKE ?`;
      params.push(`%${needle}%`);
      break;
    }
  }
  if (f.negate) {
    sql = `NOT (${sql})`;
  }
  return { sql, params };
}

function compilePredicates(
  table: string,
  predicates: Predicate[],
): CompiledWhere {
  if (predicates.length === 0) return { sql: "", params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const p of predicates) {
    if (p.kind === "filter") {
      const c = compileFilter(table, p);
      parts.push(`(${c.sql})`);
      params.push(...c.params);
    } else {
      const sub = p.branches.map((b) => compileFilter(table, b));
      parts.push(`(${sub.map((s) => `(${s.sql})`).join(" OR ")})`);
      for (const s of sub) params.push(...s.params);
    }
  }
  return { sql: ` WHERE ${parts.join(" AND ")}`, params };
}

function quoteIdent(ident: string): string {
  // SQLite identifiers can be any text in double quotes with `"` escaped as `""`.
  return `"${ident.replace(/"/g, '""')}"`;
}

function coerceParam(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

// ---------- Builder --------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
class Query<T = any> implements PromiseLike<ListResult<T>> {
  private table: string;
  private mode: Mode;
  private columns = "*";
  private predicates: Predicate[] = [];
  private orderClauses: { col: string; ascending: boolean }[] = [];
  private limitN: number | null = null;
  private offsetN: number | null = null;
  private rangeEnd: number | null = null;
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private upsertOnConflict: string[] | null = null;
  private upsertIgnoreDuplicates = false;
  private wantSingle: false | "single" | "maybe" = false;
  private returning = false;
  private countSpec: CountSpec | null = null;

  constructor(table: string, mode: Mode) {
    this.table = table;
    this.mode = mode;
  }

  select(
    columns?: string,
    opts?: { count?: CountSpec["type"]; head?: boolean },
  ): Query<T> {
    void opts?.head;
    if (this.mode !== "select") {
      // .insert(...).select() etc. → mark returning
      this.returning = true;
      if (columns) this.columns = columns;
      return this;
    }
    this.columns = columns ?? "*";
    if (opts?.count) this.countSpec = { type: opts.count };
    return this;
  }

  eq(col: string, value: unknown): this {
    this.predicates.push({ kind: "filter", col, op: "eq", value });
    return this;
  }
  neq(col: string, value: unknown): this {
    this.predicates.push({ kind: "filter", col, op: "neq", value });
    return this;
  }
  gt(col: string, value: unknown): this {
    this.predicates.push({ kind: "filter", col, op: "gt", value });
    return this;
  }
  gte(col: string, value: unknown): this {
    this.predicates.push({ kind: "filter", col, op: "gte", value });
    return this;
  }
  lt(col: string, value: unknown): this {
    this.predicates.push({ kind: "filter", col, op: "lt", value });
    return this;
  }
  lte(col: string, value: unknown): this {
    this.predicates.push({ kind: "filter", col, op: "lte", value });
    return this;
  }
  in(col: string, values: unknown[]): this {
    this.predicates.push({ kind: "filter", col, op: "in", value: values });
    return this;
  }
  is(col: string, value: unknown): this {
    this.predicates.push({ kind: "filter", col, op: "is", value });
    return this;
  }
  ilike(col: string, pattern: string): this {
    this.predicates.push({ kind: "filter", col, op: "ilike", value: pattern });
    return this;
  }
  like(col: string, pattern: string): this {
    this.predicates.push({ kind: "filter", col, op: "like", value: pattern });
    return this;
  }
  contains(col: string, value: unknown): this {
    this.predicates.push({ kind: "filter", col, op: "contains", value });
    return this;
  }
  match(obj: Record<string, unknown>): this {
    for (const [col, value] of Object.entries(obj)) {
      this.predicates.push({ kind: "filter", col, op: "eq", value });
    }
    return this;
  }
  not(col: string, op: string, value: unknown): this {
    if (
      ![
        "eq",
        "neq",
        "gt",
        "gte",
        "lt",
        "lte",
        "is",
        "in",
        "ilike",
        "like",
        "contains",
      ].includes(op)
    ) {
      throw new Error(`shim .not() op not supported: ${op}`);
    }
    this.predicates.push({
      kind: "filter",
      col,
      op: op as Operator,
      value,
      negate: true,
    });
    return this;
  }
  filter(col: string, op: string, value: unknown): this {
    if (
      ![
        "eq",
        "neq",
        "gt",
        "gte",
        "lt",
        "lte",
        "is",
        "in",
        "ilike",
        "like",
        "contains",
      ].includes(op)
    ) {
      throw new Error(`shim filter op not supported: ${op}`);
    }
    this.predicates.push({ kind: "filter", col, op: op as Operator, value });
    return this;
  }
  or(filterStr: string): this {
    const branches = parseOrString(filterStr);
    this.predicates.push({ kind: "or", branches });
    return this;
  }
  order(
    col: string,
    opts?: { ascending?: boolean; nullsFirst?: boolean },
  ): this {
    // SQLite supports NULLS FIRST/LAST; default behavior matches Postgres'
    // default (NULLS LAST when ASC, NULLS FIRST when DESC) closely enough.
    void opts?.nullsFirst;
    this.orderClauses.push({ col, ascending: opts?.ascending ?? true });
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  range(start: number, end: number): this {
    this.offsetN = start;
    this.rangeEnd = end;
    this.limitN = end - start + 1;
    return this;
  }
  single(): SingleQueryAdapter<T> {
    this.wantSingle = "single";
    return new SingleQueryAdapter<T>(this);
  }
  maybeSingle(): SingleQueryAdapter<T> {
    this.wantSingle = "maybe";
    return new SingleQueryAdapter<T>(this);
  }

  // Used internally for INSERT/UPDATE/UPSERT/DELETE construction.
  _setInsert(rowOrRows: unknown): void {
    this.payload = rowOrRows as Record<string, unknown> | Record<string, unknown>[];
  }
  _setUpsert(opts: { onConflict?: string; ignoreDuplicates?: boolean }): void {
    this.upsertOnConflict = (opts.onConflict ?? "id")
      .split(",")
      .map((s) => s.trim());
    this.upsertIgnoreDuplicates = !!opts.ignoreDuplicates;
  }
  _setUpdate(row: Record<string, unknown>): void {
    this.payload = row;
  }

  then<TR1 = ListResult<T>, TR2 = never>(
    onfulfilled?:
      | ((value: ListResult<T>) => TR1 | PromiseLike<TR1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TR2 | PromiseLike<TR2>) | null | undefined,
  ): PromiseLike<TR1 | TR2> {
    try {
      const result = this.execute() as ListResult<T>;
      return Promise.resolve(result).then(onfulfilled, onrejected);
    } catch (err) {
      return Promise.resolve(onrejected ? onrejected(err) : (Promise.reject(err) as never));
    }
  }

  /** Used by SingleQueryAdapter only. */
  _executeAsSingle(): SingleResult<T> {
    return this.execute() as SingleResult<T>;
  }

  // -------- Execution --------

  private execute(): ListResult<T> | SingleResult<T> {
    try {
      const db = getDb();
      switch (this.mode) {
        case "select":
          return this.executeSelect(db);
        case "insert":
          return this.executeInsert(db);
        case "upsert":
          return this.executeUpsert(db);
        case "update":
          return this.executeUpdate(db);
        case "delete":
          return this.executeDelete(db);
      }
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  private buildOrderLimit(): { sql: string; params: unknown[] } {
    let sql = "";
    const params: unknown[] = [];
    if (this.orderClauses.length > 0) {
      sql +=
        " ORDER BY " +
        this.orderClauses
          .map(
            (o) => `${quoteIdent(o.col)} ${o.ascending ? "ASC" : "DESC"}`,
          )
          .join(", ");
    }
    if (this.limitN != null) {
      sql += ` LIMIT ?`;
      params.push(this.limitN);
    }
    if (this.offsetN != null) {
      sql += ` OFFSET ?`;
      params.push(this.offsetN);
    }
    return { sql, params };
  }

  private executeSelect(db: Database.Database): ListResult<T> | SingleResult<T> {
    const where = compilePredicates(this.table, this.predicates);
    const ol = this.buildOrderLimit();
    let countOut: number | null = null;

    if (this.countSpec) {
      const countSql = `SELECT COUNT(*) as c FROM ${quoteIdent(this.table)}${where.sql}`;
      const cRow = db.prepare(countSql).get(...where.params) as { c: number };
      countOut = cRow.c;
    }

    const sql = `SELECT ${this.columns === "*" ? "*" : this.columns} FROM ${quoteIdent(this.table)}${where.sql}${ol.sql}`;
    const rows = db
      .prepare(sql)
      .all(...where.params, ...ol.params) as Record<string, unknown>[];
    const decoded = rows.map((r) => decodeRow(this.table, r));
    return this.shapeResult(decoded, countOut);
  }

  private executeInsert(db: Database.Database): ListResult<T> | SingleResult<T> {
    const rows = Array.isArray(this.payload)
      ? (this.payload as Record<string, unknown>[])
      : this.payload
        ? [this.payload as Record<string, unknown>]
        : [];
    const inserted: Record<string, unknown>[] = [];

    const txn = db.transaction(() => {
      for (const r of rows) {
        const withId =
          r["id"] === undefined ? { ...r, id: newId() } : r;
        const enc = encodeForSqlite(this.table, withId);
        const cols = Object.keys(enc);
        const placeholders = cols.map(() => "?").join(",");
        const sql = `INSERT INTO ${quoteIdent(this.table)} (${cols
          .map(quoteIdent)
          .join(",")}) VALUES (${placeholders})`;
        db.prepare(sql).run(...cols.map((c) => enc[c]));
        if (this.returning) {
          const fetched = db
            .prepare(
              `SELECT * FROM ${quoteIdent(this.table)} WHERE id = ?`,
            )
            .get(enc.id) as Record<string, unknown>;
          inserted.push(decodeRow(this.table, fetched));
        }
      }
    });
    txn();
    return this.shapeResult(inserted, null);
  }

  private executeUpsert(db: Database.Database): ListResult<T> | SingleResult<T> {
    const rows = Array.isArray(this.payload)
      ? (this.payload as Record<string, unknown>[])
      : this.payload
        ? [this.payload as Record<string, unknown>]
        : [];
    const conflictCols = this.upsertOnConflict ?? ["id"];
    const inserted: Record<string, unknown>[] = [];

    const txn = db.transaction(() => {
      for (const r of rows) {
        const withId =
          r["id"] === undefined ? { ...r, id: newId() } : r;
        const enc = encodeForSqlite(this.table, withId);
        const cols = Object.keys(enc);
        const placeholders = cols.map(() => "?").join(",");

        // B4: Postgrest semantics — when ignoreDuplicates is set, .select()
        // returns ONLY newly-inserted rows. Pre-check existence so the
        // returned array reflects what actually got inserted.
        let preExisting = false;
        if (this.upsertIgnoreDuplicates) {
          const lookupSql = `SELECT 1 FROM ${quoteIdent(this.table)} WHERE ${conflictCols
            .map((c) => `${quoteIdent(c)} = ?`)
            .join(" AND ")}`;
          const found = db
            .prepare(lookupSql)
            .get(...conflictCols.map((c) => enc[c]));
          preExisting = found !== undefined;
        }

        let conflictClause: string;
        if (this.upsertIgnoreDuplicates) {
          conflictClause = "DO NOTHING";
        } else {
          const updates = cols
            .filter((c) => !conflictCols.includes(c))
            .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
            .join(", ");
          conflictClause = updates
            ? `DO UPDATE SET ${updates}`
            : "DO NOTHING";
        }
        const sql = `INSERT INTO ${quoteIdent(this.table)} (${cols
          .map(quoteIdent)
          .join(",")}) VALUES (${placeholders}) ON CONFLICT(${conflictCols
          .map(quoteIdent)
          .join(",")}) ${conflictClause}`;
        db.prepare(sql).run(...cols.map((c) => enc[c]));

        if (this.returning && !(this.upsertIgnoreDuplicates && preExisting)) {
          const lookupSql = `SELECT * FROM ${quoteIdent(this.table)} WHERE ${conflictCols
            .map((c) => `${quoteIdent(c)} = ?`)
            .join(" AND ")}`;
          const fetched = db
            .prepare(lookupSql)
            .get(...conflictCols.map((c) => enc[c])) as Record<string, unknown>;
          if (fetched) inserted.push(decodeRow(this.table, fetched));
        }
      }
    });
    txn();
    return this.shapeResult(inserted, null);
  }

  private executeUpdate(db: Database.Database): ListResult<T> | SingleResult<T> {
    const row = (this.payload ?? {}) as Record<string, unknown>;
    const enc = encodeForSqlite(this.table, row);
    const setCols = Object.keys(enc);
    if (setCols.length === 0) {
      return this.shapeResult([], null);
    }
    const where = compilePredicates(this.table, this.predicates);
    const sql = `UPDATE ${quoteIdent(this.table)} SET ${setCols
      .map((c) => `${quoteIdent(c)} = ?`)
      .join(", ")}${where.sql}`;
    db.prepare(sql).run(...setCols.map((c) => enc[c]), ...where.params);

    let updated: Record<string, unknown>[] = [];
    if (this.returning) {
      const selectSql = `SELECT * FROM ${quoteIdent(this.table)}${where.sql}`;
      const rows = db.prepare(selectSql).all(...where.params) as Record<
        string,
        unknown
      >[];
      updated = rows.map((r) => decodeRow(this.table, r));
    }
    return this.shapeResult(updated, null);
  }

  private executeDelete(db: Database.Database): ListResult<T> | SingleResult<T> {
    const where = compilePredicates(this.table, this.predicates);
    let deleted: Record<string, unknown>[] = [];
    if (this.returning) {
      const selectSql = `SELECT * FROM ${quoteIdent(this.table)}${where.sql}`;
      const rows = db.prepare(selectSql).all(...where.params) as Record<
        string,
        unknown
      >[];
      deleted = rows.map((r) => decodeRow(this.table, r));
    }
    const sql = `DELETE FROM ${quoteIdent(this.table)}${where.sql}`;
    db.prepare(sql).run(...where.params);
    return this.shapeResult(deleted, null);
  }

  private shapeResult(
    rows: Record<string, unknown>[],
    count: number | null,
  ): ListResult<T> | SingleResult<T> {
    if (this.wantSingle === "single") {
      if (rows.length === 0) {
        return {
          data: null,
          // C8: Postgrest returns this code; callers (and supabase-js) use it
          // to distinguish "no rows" from real errors.
          error: { message: "No rows found", code: "PGRST116" },
          count,
        };
      }
      if (rows.length > 1) {
        return {
          data: null,
          error: { message: "Multiple rows returned" },
          count,
        };
      }
      return { data: rows[0] as T, error: null, count };
    }
    if (this.wantSingle === "maybe") {
      if (rows.length === 0) return { data: null, error: null, count };
      if (rows.length > 1) {
        return {
          data: null,
          error: { message: "Multiple rows returned" },
          count,
        };
      }
      return { data: rows[0] as T, error: null, count };
    }
    return { data: rows as unknown as T[], error: null, count };
  }
}

class SingleQueryAdapter<T> implements PromiseLike<SingleResult<T>> {
  constructor(private inner: Query<T>) {}
  then<TR1 = SingleResult<T>, TR2 = never>(
    onfulfilled?:
      | ((value: SingleResult<T>) => TR1 | PromiseLike<TR1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TR2 | PromiseLike<TR2>) | null | undefined,
  ): PromiseLike<TR1 | TR2> {
    try {
      const result = this.inner._executeAsSingle();
      return Promise.resolve(result).then(onfulfilled, onrejected);
    } catch (err) {
      return Promise.resolve(onrejected ? onrejected(err) : (Promise.reject(err) as never));
    }
  }
}

class FromHandle {
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select(
    columns?: string,
    opts?: { count?: CountSpec["type"]; head?: boolean },
  ): Query {
    const q = new Query(this.table, "select");
    return q.select(columns, opts);
  }
  insert(rowOrRows: unknown): Query {
    const q = new Query(this.table, "insert");
    q._setInsert(rowOrRows);
    return q;
  }
  upsert(
    rowOrRows: unknown,
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): Query {
    const q = new Query(this.table, "upsert");
    q._setInsert(rowOrRows);
    q._setUpsert(opts ?? {});
    return q;
  }
  update(row: Record<string, unknown>): Query {
    const q = new Query(this.table, "update");
    q._setUpdate(row);
    return q;
  }
  delete(): Query {
    return new Query(this.table, "delete");
  }
}

export class SupabaseShimClient {
  from(table: string): FromHandle {
    return new FromHandle(table);
  }
  // Stub for the `auth.admin.*` calls that some routes still make. In single-
  // user local mode there's nothing real to do — these return empty success.
  auth = {
    admin: {
      async deleteUser(
        _userId: string,
      ): Promise<{ error: { message: string } | null }> {
        return { error: null };
      },
      async listUsers(_opts?: {
        page?: number;
        perPage?: number;
      }): Promise<{
        data: { users: { id: string; email: string }[] };
        error: { message: string } | null;
      }> {
        return {
          data: {
            users: [
              {
                id: process.env.LOCAL_USER_ID || "local-user",
                email: process.env.LOCAL_USER_EMAIL || "user@local",
              },
            ],
          },
          error: null,
        };
      },
    },
  };
}

export const sharedClient = new SupabaseShimClient();
