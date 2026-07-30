import assert from "node:assert/strict";
import test from "node:test";
import { savePdfToChosenFolder, type SavePdfDeps } from "./savePdfAs";

const BYTES = new Uint8Array([1, 2, 3]);

function baseDeps(overrides: Partial<SavePdfDeps> = {}): SavePdfDeps & {
    anchorCalls: string[];
} {
    const anchorCalls: string[] = [];
    return {
        anchorCalls,
        fetchBytes: async () => BYTES,
        downloadViaAnchor: (url: string) => {
            anchorCalls.push(url);
        },
        ...overrides,
    };
}

test("desktop bridge save dialog is preferred over a silent download", async () => {
    const seen: { suggestedName: string; data: Uint8Array }[] = [];
    const deps = baseDeps({
        bridge: {
            savePdfAs: async (payload) => {
                seen.push(payload);
                return { ok: true, path: "/Users/x/Desktop/report.pdf" };
            },
        },
    });

    const outcome = await savePdfToChosenFolder(
        "http://127.0.0.1:1/files?t=x",
        "report.pdf",
        deps,
    );

    assert.deepEqual(outcome, {
        status: "saved",
        path: "/Users/x/Desktop/report.pdf",
    });
    assert.deepEqual(seen, [{ suggestedName: "report.pdf", data: BYTES }]);
    assert.deepEqual(deps.anchorCalls, []);
});

test("canceling the desktop save dialog is not an error", async () => {
    const deps = baseDeps({
        bridge: { savePdfAs: async () => ({ ok: false, canceled: true }) },
    });

    const outcome = await savePdfToChosenFolder("url", "report.pdf", deps);

    assert.deepEqual(outcome, { status: "canceled" });
    assert.deepEqual(deps.anchorCalls, []);
});

test("a failed desktop save surfaces the reported reason", async () => {
    const deps = baseDeps({
        bridge: {
            savePdfAs: async () => ({ ok: false, error: "Disk is full." }),
        },
    });

    await assert.rejects(
        () => savePdfToChosenFolder("url", "report.pdf", deps),
        /Disk is full\./,
    );
});

test("browser fallback writes through the File System Access picker", async () => {
    const written: Uint8Array[] = [];
    let closed = false;
    let suggested: string | undefined;
    const deps = baseDeps({
        showSaveFilePicker: async (options) => {
            suggested = options.suggestedName;
            return {
                createWritable: async () => ({
                    write: async (data: Uint8Array) => {
                        written.push(data);
                    },
                    close: async () => {
                        closed = true;
                    },
                }),
            };
        },
    });

    const outcome = await savePdfToChosenFolder("url", "report.pdf", deps);

    assert.deepEqual(outcome, { status: "saved" });
    assert.equal(suggested, "report.pdf");
    assert.deepEqual(written, [BYTES]);
    assert.equal(closed, true);
    assert.deepEqual(deps.anchorCalls, []);
});

test("dismissing the browser picker cancels instead of downloading", async () => {
    const abort = new Error("The user aborted a request.");
    abort.name = "AbortError";
    const deps = baseDeps({
        showSaveFilePicker: async () => {
            throw abort;
        },
    });

    const outcome = await savePdfToChosenFolder("url", "report.pdf", deps);

    assert.deepEqual(outcome, { status: "canceled" });
    assert.deepEqual(deps.anchorCalls, []);
});

test("without a picker the anchor download stays as the last resort", async () => {
    const deps = baseDeps();

    const outcome = await savePdfToChosenFolder("url", "report.pdf", deps);

    assert.deepEqual(outcome, { status: "saved" });
    assert.deepEqual(deps.anchorCalls, ["url"]);
});
