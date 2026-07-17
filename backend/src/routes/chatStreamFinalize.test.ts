import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const routeFiles = ["chat.ts", "projectChat.ts"];

test("chat routes persist the assistant row before signaling SSE completion", () => {
    for (const filename of routeFiles) {
        const source = fs.readFileSync(
            path.join(__dirname, filename),
            "utf8",
        );
        const successStart = source.indexOf("const annotations = extractAnnotations");
        const successEnd = source.indexOf("} catch (err)", successStart);
        assert.ok(successStart >= 0, `${filename} should save assistant events`);
        assert.ok(successEnd > successStart, `${filename} should have a stream catch`);

        const successBlock = source.slice(successStart, successEnd);
        assert.match(successBlock, /DOCKET_DEBUG_INSERT_DELAY_MS/);
        assert.match(
            successBlock,
            /await db\.from\("chat_messages"\)\.insert\([\s\S]*write\("data: \[DONE\]\\n\\n"\);/,
            `${filename} must emit [DONE] after the awaited insert`,
        );
    }
});

test("the shared LLM stream leaves final completion to its owning route", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../lib/chatTools.ts"),
        "utf8",
    );
    const finalCitationEmit = source.indexOf(
        'write(`data: ${JSON.stringify({ type: "citations", citations })}\\n\\n`);',
    );
    assert.ok(finalCitationEmit >= 0);
    const returnIndex = source.indexOf("return { fullText: answerText, events, citations };", finalCitationEmit);
    assert.ok(returnIndex > finalCitationEmit);
    assert.doesNotMatch(
        source.slice(finalCitationEmit, returnIndex),
        /data: \[DONE\]/,
    );
});
