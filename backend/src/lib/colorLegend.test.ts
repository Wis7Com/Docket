import assert from "node:assert/strict";
import test from "node:test";
import { buildColorLegendPrompt, parseColorLegendEntries } from "./colorLegend";

test("buildColorLegendPrompt omits an empty legend", () => {
  assert.equal(buildColorLegendPrompt([]), null);
});

test("buildColorLegendPrompt orders families and describes party bindings", () => {
  const prompt = buildColorLegendPrompt([
    {
      color_family: "blue",
      label: "피고 핵심 주장",
      party_role: "피고",
    },
    { color_family: "green", label: "다툼 없는 사실" },
    { color_family: "orange", label: "검토 필요", party_side: "B" },
  ]);

  assert.match(prompt ?? "", /^PROJECT COLOR LEGEND:/);
  assert.match(prompt ?? "", /- green: 다툼 없는 사실/);
  assert.match(prompt ?? "", /- blue \(피고\): 피고 핵심 주장/);
  assert.match(prompt ?? "", /- orange \(side B\): 검토 필요/);
  assert.ok(
    (prompt ?? "").indexOf("- orange") < (prompt ?? "").indexOf("- green"),
  );
});

test("parseColorLegendEntries validates entries without mutating input", () => {
  const input = {
    entries: [
      {
        color_family: "green",
        label: "  다툼 없는 사실  ",
        party_role: "항소인",
        party_side: "A",
      },
      { color_family: "gray", label: "   " },
    ],
  };
  const snapshot = structuredClone(input);
  const parsed = parseColorLegendEntries(input);

  assert.deepEqual(input, snapshot);
  assert.deepEqual(parsed, {
    ok: true,
    entries: [
      {
        color_family: "green",
        label: "다툼 없는 사실",
        party_role: "항소인",
        party_side: "A",
      },
    ],
  });
});

test("parseColorLegendEntries rejects invalid families and duplicates", () => {
  assert.match(
    parseFailure({ entries: [{ color_family: "teal", label: "x" }] }),
    /invalid color_family/,
  );
  assert.match(
    parseFailure({
      entries: [
        { color_family: "red", label: "x" },
        { color_family: "red", label: "y" },
      ],
    }),
    /duplicate color_family/,
  );
});

test("parseColorLegendEntries rejects invalid party bindings", () => {
  assert.match(
    parseFailure({
      entries: [{ color_family: "red", label: "x", party_role: "judge" }],
    }),
    /unknown party_role/,
  );
  assert.match(
    parseFailure({
      entries: [{ color_family: "red", label: "x", party_side: "C" }],
    }),
    /party_side/,
  );
});

function parseFailure(body: unknown): string {
  const parsed = parseColorLegendEntries(body);
  assert.equal(parsed.ok, false);
  return parsed.ok ? "" : parsed.detail;
}
