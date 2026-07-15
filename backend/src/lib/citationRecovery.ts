import { getDb } from "../db/sqlite";

const CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;
const QUOTED_TEXT_RE = /["“]([^"”\n]{8,300})["”]/g;
const UNKNOWN_FILENAME_RE =
  /(?:^|[^\p{L}\p{N}_.-])[\p{L}\p{N}_.-]+\.(?:pdf|docx?|txt|md|rtf|xlsx?|pptx?)(?=$|[^\p{L}\p{N}_.-])/iu;
const MAX_RECOVERED_CITATIONS = 20;

export type CitationRecoveryDocument = {
  document_id: string;
  filename: string;
  version_id?: string | null;
};

export type CitationRecoveryDocIndex = Readonly<
  Record<string, CitationRecoveryDocument>
>;

export type RecoverableCitation = {
  ref: number;
  doc_id: string;
  page: number | string;
  quote: string;
  chunk_id?: string;
  quote_start?: number;
  quote_end?: number;
};

export type CitationEvidenceRow = {
  chunk_id: string;
  chunk_index: number;
  page_number: number | null;
  content: string;
  start_char: number;
  end_char: number;
};

export type CitationRowLoader = (
  doc: CitationRecoveryDocument,
  quote?: string,
) => readonly CitationEvidenceRow[];

export type CitationRecoveryResult = {
  text: string;
  /** Existing citations followed by citations recovered in this pass. */
  citations: RecoverableCitation[];
  recoveredCitations: RecoverableCitation[];
};

function normaliseCitationText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\u00ad/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/-\s+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function citationEvidenceRows(
  doc: CitationRecoveryDocument,
  quote?: string,
): CitationEvidenceRow[] {
  try {
    const versionId = doc.version_id ?? null;
    return getDb()
      .prepare(
        `SELECT id AS chunk_id, chunk_index, page_number, content, start_char, end_char
                 FROM document_index_chunks
                 WHERE document_id = ? AND (? IS NULL OR version_id = ?)
                   AND (? IS NULL OR instr(lower(content), lower(?)) > 0)
                 ORDER BY chunk_index ASC`,
      )
      .all(
        doc.document_id,
        versionId,
        versionId,
        quote || null,
        quote || null,
      ) as CitationEvidenceRow[];
  } catch {
    return [];
  }
}

function textNamesFilename(text: string, filename: string): boolean {
  const haystack = text.toLocaleLowerCase();
  const needle = filename.toLocaleLowerCase();
  let offset = 0;
  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return false;
    const before = index > 0 ? haystack[index - 1] : "";
    const after = haystack[index + needle.length] ?? "";
    const isFilenameCharacter = (character: string) =>
      character !== "" && /[\p{L}\p{N}_.-]/u.test(character);
    if (!isFilenameCharacter(before) && !isFilenameCharacter(after)) {
      return true;
    }
    offset = index + 1;
  }
  return false;
}

function evidenceKey(citation: {
  doc_id: string;
  page: number | string;
  quote: string;
}): string {
  return JSON.stringify([
    citation.doc_id,
    String(citation.page),
    normaliseCitationText(citation.quote),
  ]);
}

function nextCitationRef(citations: readonly RecoverableCitation[]): number {
  const maximum = citations.reduce(
    (current, citation) =>
      Number.isSafeInteger(citation.ref) && citation.ref > current
        ? citation.ref
        : current,
    0,
  );
  return maximum + 1;
}

function insertMarkers(
  body: string,
  insertions: readonly { offset: number; ref: number }[],
): string {
  if (insertions.length === 0) return body;
  const parts: string[] = [];
  let cursor = 0;
  for (const insertion of insertions) {
    parts.push(body.slice(cursor, insertion.offset), ` [${insertion.ref}]`);
    cursor = insertion.offset;
  }
  parts.push(body.slice(cursor));
  return parts.join("");
}

function recoverQuotedCitations(
  text: string,
  docIndex: CitationRecoveryDocIndex,
  existingCitations: readonly RecoverableCitation[],
  loadRows: CitationRowLoader,
  limit: number,
): CitationRecoveryResult {
  const body = text.replace(CITATIONS_BLOCK_RE, "").trimEnd();
  const entries = Object.entries(docIndex);
  const seenEvidence = new Set(existingCitations.map(evidenceKey));
  const recoveredCitations: RecoverableCitation[] = [];
  const insertions: Array<{ offset: number; ref: number }> = [];
  let nextRef = nextCitationRef(existingCitations);

  for (const match of body.matchAll(QUOTED_TEXT_RE)) {
    if (recoveredCitations.length >= limit || match.index === undefined) {
      break;
    }

    const quote = match[1].trim();
    const wordCount = quote.split(/\s+/).filter(Boolean).length;
    if (wordCount < 3 || wordCount > 25) continue;

    const nearbyText = body.slice(
      Math.max(0, match.index - 240),
      Math.min(body.length, match.index + match[0].length + 240),
    );
    const namedEntries = entries.filter(([, doc]) =>
      textNamesFilename(nearbyText, doc.filename),
    );
    const mentionsUnknownFilename =
      namedEntries.length === 0 && UNKNOWN_FILENAME_RE.test(nearbyText);
    const searchableEntries =
      namedEntries.length > 0
        ? namedEntries
        : mentionsUnknownFilename || entries.length > 16
          ? []
          : entries;
    const expected = normaliseCitationText(quote);
    const candidates = searchableEntries.flatMap(([docId, doc]) => {
      const row = loadRows(doc, quote).find((item) =>
        normaliseCitationText(item.content).includes(expected),
      );
      return row ? [{ docId, row }] : [];
    });
    if (candidates.length !== 1) continue;

    const selected = candidates[0];
    const citation: RecoverableCitation = {
      ref: nextRef,
      doc_id: selected.docId,
      page: selected.row.page_number ?? 1,
      quote,
    };
    const key = evidenceKey(citation);
    if (seenEvidence.has(key)) continue;

    seenEvidence.add(key);
    recoveredCitations.push(citation);
    insertions.push({
      offset: match.index + match[0].length,
      ref: nextRef,
    });
    nextRef += 1;
  }

  return {
    text: insertMarkers(body, insertions),
    citations: [...existingCitations, ...recoveredCitations],
    recoveredCitations,
  };
}

/**
 * Recover every unambiguous exact quotation in the answer, up to a hard cap
 * of twenty. Recovered refs begin after the largest existing citation ref.
 */
export function recoverNamedQuotedCitations(
  text: string,
  docIndex: CitationRecoveryDocIndex,
  existingCitations: readonly RecoverableCitation[] = [],
  loadRows: CitationRowLoader = citationEvidenceRows,
): CitationRecoveryResult {
  return recoverQuotedCitations(
    text,
    docIndex,
    existingCitations,
    loadRows,
    MAX_RECOVERED_CITATIONS,
  );
}

/** Backwards-compatible one-citation recovery API. */
export function recoverNamedQuotedCitation(
  text: string,
  docIndex: CitationRecoveryDocIndex,
  loadRows: CitationRowLoader = citationEvidenceRows,
): { text: string; citations: RecoverableCitation[] } {
  const recovered = recoverQuotedCitations(text, docIndex, [], loadRows, 1);
  return { text: recovered.text, citations: recovered.recoveredCitations };
}
