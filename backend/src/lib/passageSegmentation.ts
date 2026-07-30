export type PassageSegment = Readonly<{
  index: number;
  start: number;
  end: number;
  text: string;
}>;

const LEGAL_ABBREVIATIONS = new Set([
  "al",
  "art",
  "cir",
  "co",
  "corp",
  "ct",
  "dr",
  "e.g",
  "ed",
  "eds",
  "et al",
  "f.2d",
  "f.3d",
  "fed",
  "i.e",
  "id",
  "inc",
  "j",
  "jr",
  "llc",
  "ltd",
  "mr",
  "mrs",
  "ms",
  "no",
  "nos",
  "prof",
  "rev",
  "sec",
  "sr",
  "u.s",
  "v",
  "vs",
]);

const CLOSING_PUNCTUATION = new Set(['"', "'", "”", "’", ")", "]", "}"]);

function tokenBeforePeriod(text: string, periodIndex: number): string {
  let start = periodIndex - 1;
  while (start >= 0 && /[\p{L}\p{N}.]/u.test(text[start])) start -= 1;
  return text.slice(start + 1, periodIndex).toLocaleLowerCase();
}

function isListEnumerator(text: string, periodIndex: number): boolean {
  const lineStart = text.lastIndexOf("\n", periodIndex - 1) + 1;
  const prefix = text.slice(lineStart, periodIndex + 1).trim();
  return /^(?:\d+|[A-Za-z]|[ivxlcdm]+)\.$/i.test(prefix);
}

function isProtectedPeriod(text: string, index: number): boolean {
  const previous = text[index - 1] ?? "";
  const next = text[index + 1] ?? "";
  if (/\d/.test(previous) && /\d/.test(next)) return true;
  if (isListEnumerator(text, index)) return true;

  const token = tokenBeforePeriod(text, index);
  if (!token) return false;
  if (LEGAL_ABBREVIATIONS.has(token)) return true;
  if (/^[a-z]$/i.test(token) && /^[A-Z]$/.test(text[index - 1] ?? "")) {
    return true;
  }
  if (/^(?:[a-z]\.)+[a-z]?$/i.test(token)) return true;

  const previousWordStart = text.lastIndexOf(" ", index - token.length - 2) + 1;
  const phrase = text
    .slice(previousWordStart, index)
    .trim()
    .toLocaleLowerCase();
  return LEGAL_ABBREVIATIONS.has(phrase);
}

function nextNonWhitespace(text: string, start: number): string {
  for (let index = start; index < text.length; index += 1) {
    if (!/\s/u.test(text[index])) return text[index];
  }
  return "";
}

function punctuationBoundary(text: string, index: number): number | null {
  const punctuation = text[index];
  if (punctuation === "." && isProtectedPeriod(text, index)) return null;
  if (!".!?".includes(punctuation)) return null;

  let end = index + 1;
  while (end < text.length && CLOSING_PUNCTUATION.has(text[end])) end += 1;
  if (end < text.length && !/\s/u.test(text[end])) return null;

  const next = nextNonWhitespace(text, end);
  if (next && /^\p{Ll}$/u.test(next)) return null;
  return end;
}

function trimmedSpan(
  text: string,
  rawStart: number,
  rawEnd: number,
): Omit<PassageSegment, "index"> | null {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  if (start >= end) return null;
  return { start, end, text: text.slice(start, end) };
}

function mergeShortFragments(
  text: string,
  spans: Omit<PassageSegment, "index">[],
  minimumLength: number,
): Omit<PassageSegment, "index">[] {
  const merged = [...spans];
  while (merged.length > 1) {
    const shortIndex = merged.findIndex(
      (span) => span.text.trim().length < minimumLength,
    );
    if (shortIndex < 0) break;
    if (shortIndex < merged.length - 1) {
      const current = merged[shortIndex];
      const next = merged[shortIndex + 1];
      const replacement = trimmedSpan(text, current.start, next.end);
      if (replacement) merged.splice(shortIndex, 2, replacement);
    } else {
      const previous = merged[shortIndex - 1];
      const current = merged[shortIndex];
      const replacement = trimmedSpan(text, previous.start, current.end);
      if (replacement) merged.splice(shortIndex - 1, 2, replacement);
    }
  }
  return merged;
}

/**
 * Deterministically split source text into citation-sized legal passages.
 * Boundaries preserve source offsets; short headings and stray fragments are
 * merged so every emitted handle is useful evidence on its own.
 */
export function segmentLegalPassages(
  text: string,
  options: { minimumLength?: number } = {},
): PassageSegment[] {
  if (!text.trim()) return [];
  const spans: Omit<PassageSegment, "index">[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    let end = punctuationBoundary(text, index);
    if (
      end === null &&
      text[index] === "\n" &&
      (text[index + 1] === "\n" || text[index - 1] === "\n")
    ) {
      end = index;
    }
    if (end === null) continue;
    const span = trimmedSpan(text, start, end);
    if (span) spans.push(span);
    start = end;
    while (start < text.length && /\s/u.test(text[start])) start += 1;
    index = Math.max(index, start - 1);
  }

  const tail = trimmedSpan(text, start, text.length);
  if (tail) spans.push(tail);
  return mergeShortFragments(
    text,
    spans,
    Math.max(1, Math.floor(options.minimumLength ?? 40)),
  ).map((span, index) => ({ ...span, index }));
}
