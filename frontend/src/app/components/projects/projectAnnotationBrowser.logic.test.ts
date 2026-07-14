import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectAnnotationQueryString,
  colorFamilyLabel,
  orderColorFamilyChips,
} from "./projectAnnotationBrowser.logic";

test("buildProjectAnnotationQueryString serializes supported filters", () => {
  assert.equal(buildProjectAnnotationQueryString({}), "");
  const params = new URLSearchParams(
    buildProjectAnnotationQueryString({
      colorFamily: ["green", "orange"],
      docId: ["Doc-A", "doc-b"],
      annotationType: "highlight",
      hasComment: false,
      source: "user",
      order: "recent",
      limit: 25,
      offset: 50,
    }),
  );
  assert.equal(params.get("color_family"), "green,orange");
  assert.equal(params.get("doc_id"), "Doc-A,doc-b");
  assert.equal(params.get("annotation_type"), "highlight");
  assert.equal(params.get("has_comment"), "false");
  assert.equal(params.get("source"), "user");
  assert.equal(params.get("order"), "recent");
  assert.equal(params.get("limit"), "25");
  assert.equal(params.get("offset"), "50");
});

test("colorFamilyLabel uses an optional legend and handles null", () => {
  assert.equal(colorFamilyLabel("green"), "green");
  assert.equal(
    colorFamilyLabel("green", { green: "Undisputed facts" }),
    "Undisputed facts",
  );
  assert.equal(colorFamilyLabel(null), "unclassified");
});

test("orderColorFamilyChips returns the stable family order", () => {
  assert.deepEqual(
    orderColorFamilyChips([
      { color_family: null, count: 1 },
      { color_family: "green", count: 2 },
      { color_family: "red", count: 3 },
      { color_family: "orange", count: 4 },
    ]),
    [
      { color_family: "red", count: 3 },
      { color_family: "orange", count: 4 },
      { color_family: "green", count: 2 },
      { color_family: null, count: 1 },
    ],
  );
});
