import assert from "node:assert/strict";
import test from "node:test";
import {
    publishAnnotationsChanged,
    subscribeAnnotationsChanged,
} from "./annotationsChangedChannel";

function waitFor(predicate: () => boolean, timeoutMs = 500) {
    return new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started >= timeoutMs) {
                clearInterval(timer);
                reject(new Error("Timed out waiting for BroadcastChannel message"));
            }
        }, 5);
    });
}

test("annotation change channel delivers document IDs and stops after unsubscribe", async () => {
    const received: string[] = [];
    const unsubscribe = subscribeAnnotationsChanged((docId) => {
        received.push(docId);
    });

    try {
        publishAnnotationsChanged("doc-1");
        await waitFor(() => received.length === 1);
        assert.deepEqual(received, ["doc-1"]);

        unsubscribe();
        publishAnnotationsChanged("doc-2");
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.deepEqual(received, ["doc-1"]);
    } finally {
        unsubscribe();
    }
});
