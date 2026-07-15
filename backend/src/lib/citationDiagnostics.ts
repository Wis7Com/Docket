export const CITATION_DISCARD_CODES = [
  "duplicate_ref",
  "orphan_citation",
  "unknown_document",
  "quote_not_found",
  "invalid_chunk_span",
] as const;

export type CitationDiscardCode = (typeof CITATION_DISCARD_CODES)[number];

export type CitationDiscardCounts = Record<CitationDiscardCode, number>;

/**
 * Menu-repair telemetry. These fields are additive to the existing citation
 * diagnostics event so older event consumers can continue ignoring them.
 */
export type CitationMappingDiagnosticCounts = Readonly<{
  menu_candidates: number;
  mappings_proposed: number;
  mappings_accepted: number;
  mappings_ambiguous: number;
  mapper_unavailable: boolean;
}>;

export type CitationMappingDiagnosticInput = Readonly<{
  menuCandidates?: number;
  mappingsProposed?: number;
  mappingsAccepted?: number;
  mappingsAmbiguous?: number;
  mapperUnavailable?: boolean;
}>;

function diagnosticCount(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    return 0;
  }
  return value;
}

/**
 * Build safe, immutable counters for the menu-based repair pass. Accepted and
 * ambiguous mappings are disjoint subsets of the proposed mappings; invalid
 * telemetry is clamped rather than allowed to disrupt the response stream.
 */
export function citationMappingDiagnostics(
  input: CitationMappingDiagnosticInput = {},
): CitationMappingDiagnosticCounts {
  const proposed = diagnosticCount(input.mappingsProposed);
  const accepted = Math.min(diagnosticCount(input.mappingsAccepted), proposed);
  const ambiguous = Math.min(
    diagnosticCount(input.mappingsAmbiguous),
    proposed - accepted,
  );
  return Object.freeze({
    menu_candidates: diagnosticCount(input.menuCandidates),
    mappings_proposed: proposed,
    mappings_accepted: accepted,
    mappings_ambiguous: ambiguous,
    mapper_unavailable: input.mapperUnavailable === true,
  });
}

export function countCitationDiscards(
  groups: readonly (readonly { code: string }[])[],
): CitationDiscardCounts {
  const counts = Object.fromEntries(
    CITATION_DISCARD_CODES.map((code) => [code, 0]),
  ) as CitationDiscardCounts;
  for (const errors of groups) {
    for (const error of errors) {
      if (CITATION_DISCARD_CODES.includes(error.code as CitationDiscardCode)) {
        counts[error.code as CitationDiscardCode] += 1;
      }
    }
  }
  return counts;
}

export function hasCitationDiscards(counts: CitationDiscardCounts): boolean {
  return Object.values(counts).some((count) => count > 0);
}
