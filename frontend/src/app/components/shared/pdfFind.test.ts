import test from "node:test";
import assert from "node:assert/strict";
import { findMatchesInTexts, normalizeFindText } from "./pdfFind";

test("findMatchesInTexts matches across text-layer div boundaries", () => {
    const matches = findMatchesInTexts(
        ["The Borrower shall", "deliver evidence", "of authority."],
        "shall deliver",
    );

    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].segments, [
        { divIndex: 0, start: 13, end: 18 },
        { divIndex: 1, start: 0, end: 7 },
    ]);
});

test("findMatchesInTexts finds every occurrence, case-insensitively", () => {
    const matches = findMatchesInTexts(["Foo bar foo", "FOO"], "foo");

    assert.equal(matches.length, 3);
    assert.deepEqual(
        matches.map((m) => m.segments[0]),
        [
            { divIndex: 0, start: 0, end: 3 },
            { divIndex: 0, start: 8, end: 11 },
            { divIndex: 1, start: 0, end: 3 },
        ],
    );
});

test("findMatchesInTexts ignores punctuation and hyphenation differences", () => {
    const matches = findMatchesInTexts(
        ["good-faith co-operation is required"],
        "goodfaith cooperation",
    );

    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].segments, [
        { divIndex: 0, start: 0, end: 23 },
    ]);
});

test("findMatchesInTexts supports non-Latin text", () => {
    const matches = findMatchesInTexts(["임대인은 계약을 해지할 수 있다"], "계약");

    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].segments, [{ divIndex: 0, start: 5, end: 7 }]);
});

test("normalizeFindText strips spacing and punctuation for the match count gate", () => {
    assert.equal(normalizeFindText("  Force  Majeure! "), "forcemajeure");
    assert.equal(normalizeFindText(" … --- "), "");
});
