import test from "node:test";
import assert from "node:assert/strict";
import { newVersionAccept, UPLOAD_ACCEPT } from "./documentTypes";

test("file pickers offer HWPX alongside the existing formats", () => {
    const offered = UPLOAD_ACCEPT.split(",");
    assert.ok(offered.includes(".hwpx"));
    for (const ext of [".pdf", ".docx", ".doc", ".txt", ".png", ".webp"]) {
        assert.ok(offered.includes(ext), `${ext} is still offered`);
    }
});

test("a new version is restricted to the original document's format", () => {
    assert.equal(newVersionAccept("pdf"), ".pdf");
    assert.equal(newVersionAccept("hwpx"), ".hwpx");
    assert.equal(newVersionAccept("HWPX"), ".hwpx");
    assert.equal(newVersionAccept("docx"), ".docx,.doc");
    assert.equal(newVersionAccept("doc"), ".docx,.doc");
    assert.equal(newVersionAccept(null), UPLOAD_ACCEPT);
});
