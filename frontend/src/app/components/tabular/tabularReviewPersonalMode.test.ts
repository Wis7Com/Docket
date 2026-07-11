import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("./TabularReviewView.tsx", import.meta.url),
  "utf8",
);

test("tabular reviews do not expose multi-user sharing UI", () => {
  assert.doesNotMatch(source, /PeopleModal/);
  assert.doesNotMatch(source, /getTabularReviewPeople/);
  assert.doesNotMatch(source, /People with access/);
});

test("removing sharing UI keeps adjacent tabular review actions", () => {
  assert.match(source, /<HeaderSearchBtn/);
  assert.match(source, /exportTabularReviewToExcel/);
  assert.match(source, /<AddProjectDocsModal/);
});
