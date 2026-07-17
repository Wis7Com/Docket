import assert from "node:assert/strict";
import test from "node:test";
import {
    CHAT_FONT_SCALE_MAX,
    CHAT_FONT_SCALE_MIN,
    clampChatFontScale,
    parseStoredChatFontScale,
} from "./chatFontScale";

test("chat font scale clamps bounds and rounds to one decimal place", () => {
    assert.equal(clampChatFontScale(CHAT_FONT_SCALE_MIN), CHAT_FONT_SCALE_MIN);
    assert.equal(clampChatFontScale(CHAT_FONT_SCALE_MAX), CHAT_FONT_SCALE_MAX);
    assert.equal(clampChatFontScale(0.1), CHAT_FONT_SCALE_MIN);
    assert.equal(clampChatFontScale(2), CHAT_FONT_SCALE_MAX);
    assert.equal(clampChatFontScale(1.249), 1.2);
    assert.equal(clampChatFontScale(1.251), 1.3);
});

test("stored chat font scale parsing accepts positive finite values only", () => {
    assert.equal(parseStoredChatFontScale(null), null);
    assert.equal(parseStoredChatFontScale("not a number"), null);
    assert.equal(parseStoredChatFontScale("-1"), null);
    assert.equal(parseStoredChatFontScale("1.3"), 1.3);
    assert.equal(parseStoredChatFontScale("2"), CHAT_FONT_SCALE_MAX);
});
