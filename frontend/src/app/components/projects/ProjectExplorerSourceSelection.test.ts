import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
    new URL("./ProjectExplorer.tsx", import.meta.url),
    "utf8",
);

test("project explorer exposes source selection checkboxes without opening documents", () => {
    assert.match(source, /data-session-check="explorer-source-checkbox"/);
    assert.match(source, /data-session-check="explorer-source-select-all"/);
    assert.match(source, /selectAllRef\.current\.indeterminate/);
    assert.match(
        source,
        /aria-label={`Use \$\{doc\.filename\} as a chat source`}[\s\S]*?onClick=\{\(e\) => e\.stopPropagation\(\)\}/,
    );
});
