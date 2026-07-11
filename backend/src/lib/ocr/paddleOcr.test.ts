import test from "node:test";
import assert from "node:assert/strict";
import {
  PaddleLanguageSelector,
  ctcGreedyDecode,
  parseCharacterDictionary,
} from "./paddleOcr";

test("auto OCR language starts with Korean and switches to English without Hangul", () => {
  const korean = new PaddleLanguageSelector("auto");
  assert.equal(korean.languageForPage(), "korean");
  korean.observeFirstPage("계약 agreement");
  assert.equal(korean.languageForPage(), "korean");

  const english = new PaddleLanguageSelector("auto");
  assert.equal(english.languageForPage(), "korean");
  english.observeFirstPage("English only agreement");
  assert.equal(english.languageForPage(), "english");
});

test("explicit OCR language settings never auto-switch", () => {
  const korean = new PaddleLanguageSelector("korean+english");
  korean.observeFirstPage("English only");
  assert.equal(korean.languageForPage(), "korean");

  const english = new PaddleLanguageSelector("english");
  english.observeFirstPage("한국어");
  assert.equal(english.languageForPage(), "english");
});

test("Paddle CTC decode removes blanks and consecutive duplicates", () => {
  const decoded = ctcGreedyDecode(
    new Float32Array([
      0.1, 0.9, 0.0,
      0.1, 0.8, 0.1,
      0.9, 0.05, 0.05,
      0.1, 0.1, 0.8,
    ]),
    4,
    3,
    ["A", "B"],
  );
  assert.equal(decoded.text, "AB");
  assert.ok(decoded.confidence > 0.8);
});

test("Paddle YAML dictionaries preserve quoted characters and the space class", () => {
  assert.deepEqual(
    parseCharacterDictionary(
      [
        "PostProcess:",
        "  character_dict:",
        "  - A",
        "  - ''''",
        "  - \\",
        "  use_space_char: true",
      ].join("\n"),
    ),
    ["A", "'", "\\", " "],
  );
});
