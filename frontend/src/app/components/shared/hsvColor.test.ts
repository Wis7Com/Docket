import test from "node:test";
import assert from "node:assert/strict";
import {
    hexToHsv,
    hexToRgb,
    hsvToHex,
    hsvToRgb,
    normalizeHexColor,
    rgbToHex,
    rgbToHsv,
} from "./hsvColor";

test("normalizeHexColor accepts 3/6-digit hex with or without hash", () => {
    assert.equal(normalizeHexColor(" #FFE066 "), "#ffe066");
    assert.equal(normalizeHexColor("fa0"), "#ffaa00");
    assert.equal(normalizeHexColor("#12345"), null);
    assert.equal(normalizeHexColor("saddle"), null);
});

test("hex <-> rgb round trip", () => {
    assert.deepEqual(hexToRgb("#feffa0"), { r: 254, g: 255, b: 160 });
    assert.equal(rgbToHex({ r: 254, g: 255, b: 160 }), "#feffa0");
    assert.equal(rgbToHex({ r: -4, g: 300, b: 0 }), "#00ff00");
});

test("hsv <-> rgb primaries and grays", () => {
    assert.deepEqual(hsvToRgb({ h: 0, s: 1, v: 1 }), { r: 255, g: 0, b: 0 });
    assert.deepEqual(hsvToRgb({ h: 120, s: 1, v: 1 }), { r: 0, g: 255, b: 0 });
    assert.deepEqual(hsvToRgb({ h: 240, s: 1, v: 1 }), { r: 0, g: 0, b: 255 });
    assert.deepEqual(hsvToRgb({ h: 200, s: 0, v: 0.5 }), {
        r: 128,
        g: 128,
        b: 128,
    });
    assert.deepEqual(rgbToHsv({ r: 255, g: 0, b: 0 }), { h: 0, s: 1, v: 1 });
    assert.deepEqual(rgbToHsv({ r: 0, g: 0, b: 0 }), { h: 0, s: 0, v: 0 });
});

test("hex <-> hsv round trips picker colors", () => {
    for (const hex of ["#feffa0", "#ffe066", "#74c0fc", "#2f9e44", "#d4d4d4"]) {
        const hsv = hexToHsv(hex);
        assert.ok(hsv);
        assert.equal(hsvToHex(hsv), hex);
    }
    assert.equal(hexToHsv("nope"), null);
});

test("hsv hue wraps past 360 degrees", () => {
    assert.equal(hsvToHex({ h: 360, s: 1, v: 1 }), "#ff0000");
    assert.equal(hsvToHex({ h: -120, s: 1, v: 1 }), "#0000ff");
});
