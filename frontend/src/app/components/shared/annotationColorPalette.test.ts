import test from "node:test";
import assert from "node:assert/strict";
import { ANNOTATION_COLORS } from "./docViewTypes";
import {
    defaultAnnotationColorPalette,
    parseAnnotationColorPalette,
    replaceAnnotationPaletteColor,
} from "./annotationColorPalette";

test("annotation palette falls back to the seven defaults for invalid storage", () => {
    assert.deepEqual(parseAnnotationColorPalette(null), ANNOTATION_COLORS);
    assert.deepEqual(parseAnnotationColorPalette("not-json"), ANNOTATION_COLORS);
    assert.deepEqual(
        parseAnnotationColorPalette(JSON.stringify(["#ffffff"])),
        ANNOTATION_COLORS,
    );
    assert.deepEqual(
        parseAnnotationColorPalette(
            JSON.stringify([
                "#ffffff",
                "#eeeeee",
                "#dddddd",
                "#cccccc",
                "#bbbbbb",
                "#aaaaaa",
                "not-a-color",
            ]),
        ),
        ANNOTATION_COLORS,
    );
});

test("annotation palette restores and normalizes all seven saved colors", () => {
    const saved = [
        "#ABC",
        "112233",
        "#445566",
        "#778899",
        "#AABBCC",
        "#DDEEFF",
        "#010203",
    ];

    assert.deepEqual(parseAnnotationColorPalette(JSON.stringify(saved)), [
        "#aabbcc",
        "#112233",
        "#445566",
        "#778899",
        "#aabbcc",
        "#ddeeff",
        "#010203",
    ]);
});

test("replacing a palette color changes exactly one of the seven slots", () => {
    const original = defaultAnnotationColorPalette();
    const changed = replaceAnnotationPaletteColor(original, 3, "#123ABC");

    assert.equal(changed.length, 7);
    assert.equal(changed[3], "#123abc");
    assert.deepEqual(changed.slice(0, 3), original.slice(0, 3));
    assert.deepEqual(changed.slice(4), original.slice(4));
    assert.deepEqual(original, ANNOTATION_COLORS);
    assert.deepEqual(
        replaceAnnotationPaletteColor(original, 7, "#ffffff"),
        original,
    );
    assert.deepEqual(
        replaceAnnotationPaletteColor(original, 0, "invalid"),
        original,
    );
});
