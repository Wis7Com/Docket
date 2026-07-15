import test from "node:test";
import assert from "node:assert/strict";
import {
  citationMappingDiagnostics,
  countCitationDiscards,
  hasCitationDiscards,
} from "./citationDiagnostics";

test("counts citation discard reasons across validation passes", () => {
  const counts = countCitationDiscards([
    [{ code: "orphan_citation" }, { code: "duplicate_ref" }],
    [{ code: "quote_not_found" }, { code: "quote_not_found" }],
  ]);

  assert.deepEqual(counts, {
    duplicate_ref: 1,
    orphan_citation: 1,
    unknown_document: 0,
    quote_not_found: 2,
    invalid_chunk_span: 0,
  });
  assert.equal(hasCitationDiscards(counts), true);
});

test("ignores unknown diagnostic codes and reports an empty summary", () => {
  const counts = countCitationDiscards([[{ code: "future_code" }]]);
  assert.equal(hasCitationDiscards(counts), false);
});

test("builds additive menu-repair diagnostics without changing discard counts", () => {
  const mappings = citationMappingDiagnostics({
    menuCandidates: 42,
    mappingsProposed: 7,
    mappingsAccepted: 5,
    mappingsAmbiguous: 1,
  });

  assert.deepEqual(mappings, {
    menu_candidates: 42,
    mappings_proposed: 7,
    mappings_accepted: 5,
    mappings_ambiguous: 1,
    mapper_unavailable: false,
  });
  assert.equal(Object.isFrozen(mappings), true);

  const existingPayload = {
    discarded: countCitationDiscards([]),
    recovered: 0,
    repair_attempted: true,
    repair_added: 5,
  };
  assert.deepEqual(existingPayload, {
    discarded: {
      duplicate_ref: 0,
      orphan_citation: 0,
      unknown_document: 0,
      quote_not_found: 0,
      invalid_chunk_span: 0,
    },
    recovered: 0,
    repair_attempted: true,
    repair_added: 5,
  });
});

test("menu-repair diagnostics default safely and clamp impossible subsets", () => {
  assert.deepEqual(citationMappingDiagnostics(), {
    menu_candidates: 0,
    mappings_proposed: 0,
    mappings_accepted: 0,
    mappings_ambiguous: 0,
    mapper_unavailable: false,
  });
  assert.deepEqual(
    citationMappingDiagnostics({
      menuCandidates: Number.NaN,
      mappingsProposed: 3,
      mappingsAccepted: 4,
      mappingsAmbiguous: 2,
    }),
    {
      menu_candidates: 0,
      mappings_proposed: 3,
      mappings_accepted: 3,
      mappings_ambiguous: 0,
      mapper_unavailable: false,
    },
  );
});

test("menu-repair diagnostics record mapper availability", () => {
  assert.deepEqual(citationMappingDiagnostics({ mapperUnavailable: true }), {
    menu_candidates: 0,
    mappings_proposed: 0,
    mappings_accepted: 0,
    mappings_ambiguous: 0,
    mapper_unavailable: true,
  });
});
