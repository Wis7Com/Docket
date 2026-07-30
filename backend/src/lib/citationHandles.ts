import {
  segmentLegalPassages,
  type PassageSegment,
} from "./passageSegmentation";
import { escapeRegExp } from "./regex";

export const MAX_PASSAGE_RANGE_SENTENCES = 3;

export type PassageSource = Readonly<{
  docId: string;
  documentId: string;
  versionId?: string | null;
  chunkId: string;
  content: string;
  page?: number | null;
  pageEnd?: number | null;
  startChar?: number;
  endChar?: number;
  pageBreakOffsets?: readonly number[];
}>;

export type PassageRecord = Readonly<{
  id: string;
  sentenceIndex: number;
  start: number;
  end: number;
  text: string;
  source: PassageSource;
}>;

/**
 * A user's PDF highlight registered on the turn registry. Annotation handles
 * (`a1`, `a2`, …) let a model cite a highlight by id instead of reproducing
 * its text; unlike passages they are not backed by an indexed chunk, so
 * `chunkId` and the char offsets are optional.
 */
export type AnnotationHandleSource = Readonly<{
  annotationId: string;
  docId: string;
  documentId: string;
  versionId?: string | null;
  page: number;
  quote: string;
  chunkId?: string;
  quoteStart?: number;
  quoteEnd?: number;
}>;

export type ResolvedPassageCitation = Readonly<{
  passage: string;
  docId: string;
  documentId: string;
  versionId?: string | null;
  chunkId?: string;
  page: number | string;
  quote: string;
  quoteStart: number;
  quoteEnd: number;
  startChar: number;
  endChar: number;
}>;

export type PassageResolution =
  | { ok: true; citation: ResolvedPassageCitation }
  | { ok: false; code: "unknown_passage" | "invalid_passage_range" };

export type PassageAnnotationByteMeasurement = Readonly<{
  serializedBytesWithAnnotations: number;
  serializedBytesWithoutAnnotations: number;
  byteDelta: number;
  percentDelta: number;
}>;

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function citationHandlesEnabled(envValue?: string): boolean {
  if (envValue === undefined || envValue.trim() === "") return true;
  return !DISABLED_VALUES.has(envValue.trim().toLocaleLowerCase());
}

function parsePassageRange(
  value: string,
): { first: string; last: string } | null {
  const match = value.trim().match(/^(p[1-9]\d*)(?:-(p[1-9]\d*))?$/);
  if (!match) return null;
  return { first: match[1], last: match[2] ?? match[1] };
}

function normalizedRange(
  source: PassageSource,
  first: PassageRecord,
  last: PassageRecord,
): { page: number | string; quote: string } {
  const pageStart = source.page ?? 1;
  const literalBreaks: number[] = [];
  for (
    let offset = source.content.indexOf("[[PAGE_BREAK]]");
    offset >= 0;
    offset = source.content.indexOf("[[PAGE_BREAK]]", offset + 1)
  ) {
    literalBreaks.push(offset);
  }
  const breakOffsets = [
    ...new Set([...(source.pageBreakOffsets ?? []), ...literalBreaks]),
  ].sort((a, b) => a - b);
  const breaksBefore = breakOffsets.filter(
    (offset) => offset < first.start,
  ).length;
  const selectedBreaks = breakOffsets.filter(
    (offset) => offset >= first.start && offset < last.end,
  );
  const firstPage = pageStart + breaksBefore;
  const lastPage = Math.min(
    source.pageEnd ?? firstPage + selectedBreaks.length,
    firstPage + selectedBreaks.length,
  );
  let quote = source.content.slice(first.start, last.end);
  if (selectedBreaks.length && !quote.includes("[[PAGE_BREAK]]")) {
    let inserted = 0;
    for (const offset of selectedBreaks) {
      const local = offset - first.start + inserted;
      quote = quote.slice(0, local) + "[[PAGE_BREAK]]" + quote.slice(local);
      inserted += "[[PAGE_BREAK]]".length;
    }
  }
  return {
    page: lastPage > firstPage ? `${firstPage}-${lastPage}` : firstPage,
    quote,
  };
}

/**
 * Locate an excerpt inside content, tolerating whitespace differences. Used
 * both for annotating tool excerpts and for finding a highlight's quote
 * inside a model answer that copied it verbatim.
 */
export function findExcerptSpan(content: string, excerpt: string) {
  return exactExcerptSpan(content, excerpt);
}

function exactExcerptSpan(content: string, excerpt: string) {
  const exactStart = content.indexOf(excerpt);
  if (exactStart >= 0) {
    return { start: exactStart, end: exactStart + excerpt.length };
  }
  const compact = excerpt.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  const words = compact.split(" ").filter(Boolean);
  const anchor = words.slice(0, Math.min(words.length, 8)).join(" ");
  if (anchor.length < 12) return null;
  const normalizedContent = content.replace(/\s+/g, " ");
  const normalizedStart = normalizedContent.indexOf(anchor);
  if (normalizedStart < 0) return null;
  const sourceAnchor = anchor.split(" ").map(escapeRegExp).join("\\s+");
  const match = new RegExp(sourceAnchor, "u").exec(content);
  if (!match?.index) {
    if (match?.index === 0) return { start: 0, end: match[0].length };
    return null;
  }
  return { start: match.index, end: match.index + match[0].length };
}

function stripPassageAnnotationFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripPassageAnnotationFields);
  }
  if (!value || typeof value !== "object") return value;

  const stripped: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "citation_passage") continue;
    stripped[key] =
      key === "indexed_quote" && typeof nested === "string"
        ? nested.replace(/\[p[1-9]\d*\]\s*/g, "")
        : stripPassageAnnotationFields(nested);
  }
  return stripped;
}

export function measurePassageAnnotationByteOverhead(
  annotatedPayload: unknown,
): PassageAnnotationByteMeasurement {
  const serializedWithAnnotations = JSON.stringify(annotatedPayload);
  const serializedWithoutAnnotations = JSON.stringify(
    stripPassageAnnotationFields(annotatedPayload),
  );
  const serializedBytesWithAnnotations = Buffer.byteLength(
    serializedWithAnnotations,
    "utf8",
  );
  const serializedBytesWithoutAnnotations = Buffer.byteLength(
    serializedWithoutAnnotations,
    "utf8",
  );
  const byteDelta =
    serializedBytesWithAnnotations - serializedBytesWithoutAnnotations;
  return {
    serializedBytesWithAnnotations,
    serializedBytesWithoutAnnotations,
    byteDelta,
    percentDelta:
      serializedBytesWithoutAnnotations > 0
        ? (byteDelta / serializedBytesWithoutAnnotations) * 100
        : 0,
  };
}

export class PassageRegistry {
  readonly #recordsById = new Map<string, PassageRecord>();
  readonly #recordsByChunk = new Map<string, PassageRecord[]>();
  readonly #annotationsByHandle = new Map<string, AnnotationHandleSource>();
  readonly #annotationHandlesById = new Map<string, string>();
  #nextId = 1;
  #nextAnnotationId = 1;

  registerChunk(source: PassageSource): PassageRecord[] {
    const existing = this.#recordsByChunk.get(source.chunkId);
    if (existing) return existing;
    const records = segmentLegalPassages(source.content).map(
      (segment: PassageSegment): PassageRecord => {
        const record = Object.freeze({
          id: `p${this.#nextId++}`,
          sentenceIndex: segment.index,
          start: segment.start,
          end: segment.end,
          text: segment.text,
          source: Object.freeze({ ...source }),
        });
        this.#recordsById.set(record.id, record);
        return record;
      },
    );
    this.#recordsByChunk.set(source.chunkId, records);
    return records;
  }

  /**
   * Mint (or reuse) the `aN` handle for one user annotation. Registering the
   * same `annotationId` twice returns the handle already assigned to it, so a
   * highlight surfaced by several tool calls keeps one stable id.
   */
  annotationHandles(): ReadonlyArray<{
    handle: string;
    source: AnnotationHandleSource;
  }> {
    return [...this.#annotationsByHandle.entries()].map(
      ([handle, source]) => ({ handle, source }),
    );
  }

  registerAnnotation(source: AnnotationHandleSource): string {
    const existing = this.#annotationHandlesById.get(source.annotationId);
    if (existing) return existing;
    const handle = `a${this.#nextAnnotationId++}`;
    this.#annotationHandlesById.set(source.annotationId, handle);
    this.#annotationsByHandle.set(handle, Object.freeze({ ...source }));
    return handle;
  }

  annotateChunk(source: PassageSource): string {
    const records = this.registerChunk(source);
    let cursor = 0;
    let rendered = "";
    for (const record of records) {
      rendered += source.content.slice(cursor, record.start);
      rendered += `[${record.id}] ${source.content.slice(record.start, record.end)}`;
      cursor = record.end;
    }
    return rendered + source.content.slice(cursor);
  }

  annotateExcerpt(source: PassageSource, excerpt: string): string {
    const records = this.registerChunk(source);
    const span = exactExcerptSpan(source.content, excerpt);
    if (!span) return excerpt;
    const selected = records.filter(
      (record) => record.end > span.start && record.start < span.end,
    );
    return selected.length
      ? selected.map((record) => `[${record.id}] ${record.text}`).join(" ")
      : excerpt;
  }

  passageForQuote(source: PassageSource, quote: string): string | undefined {
    const records = this.registerChunk(source);
    const span = exactExcerptSpan(source.content, quote);
    if (!span) return undefined;
    const selected = records.filter(
      (record) => record.end > span.start && record.start < span.end,
    );
    if (
      selected.length === 0 ||
      selected.length > MAX_PASSAGE_RANGE_SENTENCES
    ) {
      return undefined;
    }
    return selected.length === 1
      ? selected[0].id
      : `${selected[0].id}-${selected[selected.length - 1].id}`;
  }

  /**
   * Resolve, salvaging over-broad ranges instead of discarding them.
   *
   * A model writing "p5-p12" has named real passages and gotten the format
   * wrong; dropping the entry leaves a marker that can never be clicked.
   * When the range's FIRST id resolves, clamp the span to the longest valid
   * range starting there (same chunk, at most MAX_PASSAGE_RANGE_SENTENCES)
   * and report `clamped` so diagnostics can count the correction. An id the
   * registry never minted stays a hard failure — there is nothing to point
   * at.
   */
  resolveClamped(
    value: string,
  ): PassageResolution & { clamped?: boolean } {
    const direct = this.resolve(value);
    if (direct.ok) return direct;
    if (direct.code !== "invalid_passage_range") return direct;
    const match = value.trim().match(/^(p[1-9]\d*)-(p[1-9]\d*)$/);
    if (!match) return direct;
    const first = this.#recordsById.get(match[1]);
    if (!first) return direct;
    const chunkRecords = this.#recordsByChunk.get(first.source.chunkId) ?? [];
    const tail = chunkRecords
      .filter(
        (record) =>
          record.sentenceIndex >= first.sentenceIndex &&
          record.sentenceIndex <
            first.sentenceIndex + MAX_PASSAGE_RANGE_SENTENCES,
      )
      .sort((a, b) => a.sentenceIndex - b.sentenceIndex);
    const last = tail[tail.length - 1];
    if (!last) return direct;
    const clampedValue =
      last.id === first.id ? first.id : `${first.id}-${last.id}`;
    const salvaged = this.resolve(clampedValue);
    return salvaged.ok ? { ...salvaged, clamped: true } : direct;
  }

  resolve(value: string): PassageResolution {
    const annotationHandle = value.trim().match(/^a[1-9]\d*$/)?.[0];
    if (annotationHandle) {
      const annotation = this.#annotationsByHandle.get(annotationHandle);
      if (!annotation) return { ok: false, code: "unknown_passage" };
      const quoteStart = annotation.quoteStart ?? 0;
      const quoteEnd = annotation.quoteEnd ?? annotation.quote.length;
      return {
        ok: true,
        citation: Object.freeze({
          passage: annotationHandle,
          docId: annotation.docId,
          documentId: annotation.documentId,
          versionId: annotation.versionId,
          chunkId: annotation.chunkId,
          page: annotation.page,
          quote: annotation.quote,
          quoteStart,
          quoteEnd,
          startChar: quoteStart,
          endChar: quoteEnd,
        }),
      };
    }
    const parsed = parsePassageRange(value);
    if (!parsed) return { ok: false, code: "invalid_passage_range" };
    const first = this.#recordsById.get(parsed.first);
    const last = this.#recordsById.get(parsed.last);
    if (!first || !last) return { ok: false, code: "unknown_passage" };
    if (
      first.source.chunkId !== last.source.chunkId ||
      last.sentenceIndex < first.sentenceIndex ||
      last.sentenceIndex - first.sentenceIndex + 1 > MAX_PASSAGE_RANGE_SENTENCES
    ) {
      return { ok: false, code: "invalid_passage_range" };
    }
    const chunkRecords = this.#recordsByChunk.get(first.source.chunkId) ?? [];
    const selected = chunkRecords.filter(
      (record) =>
        record.sentenceIndex >= first.sentenceIndex &&
        record.sentenceIndex <= last.sentenceIndex,
    );
    if (selected.length !== last.sentenceIndex - first.sentenceIndex + 1) {
      return { ok: false, code: "invalid_passage_range" };
    }
    const range = normalizedRange(first.source, first, last);
    return {
      ok: true,
      citation: Object.freeze({
        passage: value.trim(),
        docId: first.source.docId,
        documentId: first.source.documentId,
        versionId: first.source.versionId,
        chunkId: first.source.chunkId,
        page: range.page,
        quote: range.quote,
        quoteStart: first.start,
        quoteEnd: last.end,
        startChar: (first.source.startChar ?? 0) + first.start,
        endChar: (first.source.startChar ?? 0) + last.end,
      }),
    };
  }

  repairCandidates(): Array<{
    index: number;
    passage: string;
    doc_id: string;
    page: number | string;
    quote: string;
    chunk_id: string;
  }> {
    return [...this.#recordsById.values()].map((record, index) => {
      const resolved = this.resolve(record.id);
      if (!resolved.ok) {
        throw new Error(`Registered passage ${record.id} did not resolve`);
      }
      return {
        index: index + 1,
        passage: record.id,
        doc_id: resolved.citation.docId,
        page: resolved.citation.page,
        quote: resolved.citation.quote,
        chunk_id: record.source.chunkId,
      };
    });
  }
}
