import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAnnotationColor,
  type AnnotationColorFamily,
} from "./annotationColors";

const observedColors: Array<[string, AnnotationColorFamily]> = [
  ["#feffa0", "yellow"],
  ["#ffe066", "yellow"],
  ["#d1ffc3", "green"],
  ["#dfdfdf", "gray"],
  ["#fdffe0", "yellow"],
  ["#fed4ff", "pink"],
  ["#ffda73", "orange"],
  ["#fff240", "yellow"],
  ["#ffff00", "yellow"],
  ["#74c0fc", "blue"],
  ["#8ce99a", "green"],
  ["#ceffff", "blue"],
  ["#f783ac", "pink"],
  ["#ffa52e", "orange"],
  ["#ffaa94", "red"],
  ["#ffb16d", "orange"],
  ["#ffb6f8", "pink"],
  ["#ffd926", "yellow"],
  ["#ffed00", "yellow"],
  ["#fff599", "yellow"],
  ["#fffaa6", "yellow"],
  ["#d4d4d4", "gray"],
  ["#ebebeb", "gray"],
  ["#f5ffe3", "green"],
];

test("classifyAnnotationColor classifies every color observed in project databases", () => {
  for (const [hex, expected] of observedColors) {
    assert.equal(classifyAnnotationColor(hex)?.family, expected, hex);
  }
});

test("classifyAnnotationColor classifies every default annotation palette color", () => {
  const palette: Array<[string, AnnotationColorFamily]> = [
    ["#ffe066", "yellow"],
    ["#ffc078", "orange"],
    ["#ff8787", "red"],
    ["#8ce99a", "green"],
    ["#74c0fc", "blue"],
    ["#b197fc", "purple"],
    ["#f783ac", "pink"],
  ];
  for (const [hex, expected] of palette) {
    const result = classifyAnnotationColor(hex);
    assert.equal(result?.family, expected, hex);
    assert.equal(result?.label, expected, hex);
  }
});

test("classifyAnnotationColor rejects malformed values", () => {
  assert.equal(classifyAnnotationColor("not-a-color"), null);
  assert.equal(classifyAnnotationColor("#fff"), null);
  assert.equal(classifyAnnotationColor(null), null);
});
