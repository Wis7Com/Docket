import { z } from "zod";

export const DOC_ROLES = ["brief", "evidence", "other"] as const;
export type DocRole = (typeof DOC_ROLES)[number];
export const docRoleSchema = z.enum(DOC_ROLES);

export const PARTY_ROLES = [
  "원고",
  "피고",
  "항소인",
  "피항소인",
  "상고인",
  "피상고인",
  "참가인",
  "제3자",
  "plaintiff",
  "defendant",
  "appellant",
  "appellee",
  "petitioner",
  "respondent",
  "cross-appellant",
  "cross-appellee",
  "intervenor",
  "amicus",
  "third-party",
  "neutral",
] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];
export const partyRoleSchema = z.enum(PARTY_ROLES);
export const partyRoleNullableSchema = partyRoleSchema.nullable();
export const partySideSchema = z.enum(["A", "B"]);
export const partySideNullableSchema = partySideSchema.nullable();
export const briefSequenceNullableSchema = z
  .number()
  .int()
  .positive()
  .nullable();

export type RoleConfidence = "high" | "low";
export type DocRoleGuess = { role: DocRole; confidence: RoleConfidence };

export type BriefSequenceHint = Readonly<{
  id: string;
  partySide: "A" | "B" | null;
  docRole: DocRole;
  sequenceHint: number | null;
}>;

export type NormalizedBriefSequence = Readonly<{
  id: string;
  briefSequence: number | null;
}>;

export const LARGE_DOC_PAGE_THRESHOLD = 50;

const EVIDENCE_PATTERNS: readonly RegExp[] = [
  /호증/,
  /서증/,
  /[갑을병]\s*제?\s*\d+\s*호/,
  /\bexhibits?\b/i,
  /\bevidence\b/i,
  /\b(?:pl\.?\s*ex\.|def\.?\s*ex\.)\s*[a-z0-9]/i,
  /\bex\.\s*[a-z0-9]/i,
  /\b(?:pl|def|p|d)x[-\s]?\d/i,
  /\b(?:plaintiff|defendant)['’]?s?\s+(?:trial\s+)?exhibit/i,
  /\btrial\s+exhibit\b/i,
  /\bdeposition\b/i,
  /\bdepo\b/i,
  /\bdiscovery\b/i,
  /\bproduction\b/i,
];

const BRIEF_PATTERNS: readonly RegExp[] = [
  /준비\s*서면/,
  /답변서/,
  /소\s*장/,
  /청구취지/,
  /의견서/,
  /참고\s*서면/,
  /준비명령/,
  /\bbriefs?\b/i,
  /\bpleadings?\b/i,
  /\bmemorandum(?:\s+of\s+law|\s+in\s+(?:support|opposition))?/i,
  /\bmemo\.?\s+(?:of\s+law|in\s+(?:support|opp))/i,
  /\bmotions?\b/i,
  /\bcomplaints?\b/i,
  /\banswer\b/i,
  /\breply\b/i,
  /\bopposition\b/i,
  /\bpetition\b/i,
  /\bpoints?\s+and\s+authorities\b/i,
  /\bmsj\b/i,
  /\bmtd\b/i,
];

function haystack(input: { folderName?: string | null; filename: string }): string {
  return (input.folderName ?? "") + " " + input.filename;
}

export function inferDocRole(input: {
  folderName?: string | null;
  filename: string;
  pageCount?: number | null;
}): DocRoleGuess {
  const value = haystack(input);
  if (EVIDENCE_PATTERNS.some((pattern) => pattern.test(value))) {
    return { role: "evidence", confidence: "high" };
  }
  if (BRIEF_PATTERNS.some((pattern) => pattern.test(value))) {
    return { role: "brief", confidence: "high" };
  }
  if ((input.pageCount ?? 0) > LARGE_DOC_PAGE_THRESHOLD) {
    return { role: "evidence", confidence: "low" };
  }
  return { role: "other", confidence: "low" };
}

function uniquePositiveSequence(
  filename: string,
  patterns: readonly RegExp[],
): { found: boolean; value: number | null } {
  const values = new Set<number>();
  for (const pattern of patterns) {
    for (const match of filename.matchAll(pattern)) {
      const value = Number.parseInt(match[1], 10);
      if (Number.isSafeInteger(value) && value > 0) values.add(value);
    }
  }
  if (values.size === 0) return { found: false, value: null };
  if (values.size !== 1) return { found: true, value: null };
  return { found: true, value: [...values][0] };
}

/**
 * Infer only an explicit ordering signal. ECF numbers are retained as monotonic
 * hints; callers that have a complete party-side group can normalize them to
 * dense 1..N values with `normalizeBriefSequences`.
 */
export function inferBriefSequence(input: {
  filename: string;
  docRole: DocRole;
}): number | null {
  if (input.docRole !== "brief") return null;

  const explicit = uniquePositiveSequence(input.filename, [
    /제\s*(\d+)\s*차/gu,
    /\b(\d+)(?:st|nd|rd|th)[\s._-]+(?:brief|reply|opposition|memorandum|motion|pleading)\b/giu,
    /\b(?:brief|reply|opposition|memorandum|motion|pleading)[\s._-]+(\d+)(?:st|nd|rd|th)\b/giu,
  ]);
  if (explicit.found) return explicit.value;

  return uniquePositiveSequence(input.filename, [/\bECF[-_ ]?(\d+)\b/giu])
    .value;
}

/**
 * Normalize complete, unambiguous party-side groups without mutating input.
 * Missing party sides and duplicate sequence hints fail closed to null.
 */
export function normalizeBriefSequences(
  items: readonly BriefSequenceHint[],
): NormalizedBriefSequence[] {
  const groups = new Map<string, BriefSequenceHint[]>();
  for (const item of items) {
    if (
      item.docRole !== "brief" ||
      item.partySide === null ||
      item.sequenceHint === null ||
      !Number.isSafeInteger(item.sequenceHint) ||
      item.sequenceHint <= 0
    ) {
      continue;
    }
    const key = `${item.partySide}\u0000${item.docRole}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const normalizedById = new Map<string, number>();
  for (const group of groups.values()) {
    const counts = new Map<number, number>();
    for (const item of group) {
      counts.set(item.sequenceHint!, (counts.get(item.sequenceHint!) ?? 0) + 1);
    }
    const orderedHints = [...counts.keys()].sort((a, b) => a - b);
    const rankByHint = new Map(
      orderedHints.map((hint, index) => [hint, index + 1]),
    );
    for (const item of group) {
      if ((counts.get(item.sequenceHint!) ?? 0) !== 1) continue;
      normalizedById.set(item.id, rankByHint.get(item.sequenceHint!)!);
    }
  }

  return items.map((item) => ({
    id: item.id,
    briefSequence: normalizedById.get(item.id) ?? null,
  }));
}

export function refineDocRoleFromFirstPage(
  firstPageText: string,
  prior: DocRoleGuess,
): DocRoleGuess {
  const text = firstPageText.trim();
  if (text.length < 10) return prior;
  if (EVIDENCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { role: "evidence", confidence: "high" };
  }
  if (BRIEF_PATTERNS.some((pattern) => pattern.test(text))) {
    return { role: "brief", confidence: "high" };
  }
  return prior;
}

export function inferPartyRole(input: {
  folderName?: string | null;
  filename: string;
}): { role: PartyRole; confidence: RoleConfidence } | null {
  const value = haystack(input);
  if (/피상고인/.test(value)) return { role: "피상고인", confidence: "high" };
  if (/상고인/.test(value)) return { role: "상고인", confidence: "high" };
  if (/피항소인/.test(value)) return { role: "피항소인", confidence: "high" };
  if (/항소인/.test(value)) return { role: "항소인", confidence: "high" };
  if (/\bcross[-\s]?appellee\b/i.test(value)) return { role: "cross-appellee", confidence: "high" };
  if (/\bcross[-\s]?appellant\b/i.test(value)) return { role: "cross-appellant", confidence: "high" };
  if (/\bappellee\b/i.test(value)) return { role: "appellee", confidence: "high" };
  if (/\bappellant\b/i.test(value)) return { role: "appellant", confidence: "high" };
  if (/\brespondent\b/i.test(value)) return { role: "respondent", confidence: "high" };
  if (/\bpetitioner\b/i.test(value)) return { role: "petitioner", confidence: "high" };
  if (/원고/.test(value) || /갑\s*제?\s*\d+\s*호/.test(value)) return { role: "원고", confidence: "high" };
  if (/피고/.test(value) || /을\s*제?\s*\d+\s*호/.test(value)) return { role: "피고", confidence: "high" };
  if (/\bplaintiff\b/i.test(value) || /\b(?:pl|p)x[-\s]?\d/i.test(value) || /\bpl\.?\s*ex/i.test(value)) {
    return { role: "plaintiff", confidence: "high" };
  }
  if (/\bdefendant\b/i.test(value) || /\b(?:def|d)x[-\s]?\d/i.test(value) || /\bdef\.?\s*ex/i.test(value)) {
    return { role: "defendant", confidence: "high" };
  }
  if (/참가인/.test(value)) return { role: "참가인", confidence: "high" };
  if (/제3자/.test(value)) return { role: "제3자", confidence: "high" };
  if (/법원|감정|사실조회|촉탁|병\s*제?\s*\d+\s*호/.test(value)) return { role: "neutral", confidence: "low" };
  if (/\bamicus\b/i.test(value)) return { role: "amicus", confidence: "high" };
  if (/\bintervenor\b/i.test(value)) return { role: "intervenor", confidence: "high" };
  if (/\bthird[-\s]?party\b/i.test(value)) return { role: "third-party", confidence: "high" };
  if (/\bcourt\b/i.test(value)) return { role: "neutral", confidence: "low" };
  return null;
}
