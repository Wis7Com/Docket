import test from "node:test";
import assert from "node:assert/strict";
import {
    loadGeneratedDocumentOutline,
    saveGeneratedDocumentOutline,
} from "./documentOutlineStorage";

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    };
}

test("generated outlines round-trip by document version", () => {
    const storage = memoryStorage();
    const items = [
        { id: "generated-0", title: "Introduction", level: 1, page: 2 },
        { id: "generated-1", title: "Scope", level: 2, page: 3 },
    ];

    saveGeneratedDocumentOutline(storage, "pdf:doc-a:v2", items);

    assert.deepEqual(
        loadGeneratedDocumentOutline(storage, "pdf:doc-a:v2"),
        items,
    );
    assert.deepEqual(
        loadGeneratedDocumentOutline(storage, "pdf:doc-a:v1"),
        [],
    );
});

test("generated outline storage rejects malformed or unsafe entries", () => {
    const storage = memoryStorage();
    storage.setItem(
        "docket-document-outline:pdf:doc-a:v2",
        JSON.stringify({
            version: 1,
            items: [
                { id: "ok", title: "Valid", level: 1, page: 2 },
                { id: "bad", title: "", level: 99, page: -1 },
            ],
        }),
    );

    assert.deepEqual(
        loadGeneratedDocumentOutline(storage, "pdf:doc-a:v2"),
        [{ id: "ok", title: "Valid", level: 1, page: 2 }],
    );
});
