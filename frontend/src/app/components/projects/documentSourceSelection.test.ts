import test from "node:test";
import assert from "node:assert/strict";
import { buildDocumentSourceSelection } from "./documentSourceSelection";

const documents = [{ id: "doc-a" }, { id: "doc-b" }, { id: "doc-c" }];

test("document source selection omits the payload when every document is selected", () => {
    const selection = buildDocumentSourceSelection(documents, new Set());
    assert.equal(selection.selectedDocumentIds, undefined);
});

test("document source selection sends only selected documents", () => {
    const selection = buildDocumentSourceSelection(
        documents,
        new Set(["doc-b"]),
    );
    assert.deepEqual(selection.selectedDocumentIds, ["doc-a", "doc-c"]);
});

test("new documents are selected and deleted ids disappear naturally", () => {
    const selection = buildDocumentSourceSelection(
        documents,
        new Set(["deleted-doc", "doc-b"]),
    );
    assert.deepEqual([...selection.deselectedDocIds], ["doc-b"]);
    assert.deepEqual(selection.selectedDocumentIds, ["doc-a", "doc-c"]);
});

test("attached documents are reselected for the same outgoing request", () => {
    const selection = buildDocumentSourceSelection(
        documents,
        new Set(["doc-b", "doc-c"]),
        ["doc-b"],
    );
    assert.deepEqual([...selection.deselectedDocIds], ["doc-c"]);
    assert.deepEqual(selection.selectedDocumentIds, ["doc-a", "doc-b"]);
});
