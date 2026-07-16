import assert from "node:assert/strict";
import test from "node:test";
import {
  embeddingTransition,
  pollEmbeddingRegistrations,
} from "./embeddingWatcher.logic";

test("embedding watcher reports completion only after observed active work drains", () => {
  assert.equal(embeddingTransition(false, { queued: 0, embedding: 0, failures: 0, paused: false, lastError: null }), "wait");
  assert.equal(embeddingTransition(true, { queued: 0, embedding: 0, failures: 0, paused: false, lastError: null }), "complete");
});

test("embedding watcher reports failures and paused failures as errors", () => {
  assert.equal(embeddingTransition(true, { queued: 0, embedding: 0, failures: 1, paused: false, lastError: null }), "error");
  assert.equal(embeddingTransition(true, { queued: 0, embedding: 0, failures: 0, paused: true, lastError: null }), "error");
});

test("a sticky last error alone does not turn a clean drain into a failure", () => {
  assert.equal(
    embeddingTransition(true, {
      queued: 0,
      embedding: 0,
      failures: 0,
      paused: false,
      lastError: "old transient error",
    }),
    "complete",
  );
});

test("watcher completes once and unregisters the project", async () => {
  const registrations = new Map([["p1", { projectId: "p1", projectName: "Matter", sawActive: true }]]);
  const events: string[] = [];
  await pollEmbeddingRegistrations(
    registrations,
    async () => ({ queued: 0, embedding: 0, failures: 0, paused: false, lastError: null }),
    (event) => events.push(event.kind),
  );
  await pollEmbeddingRegistrations(
    registrations,
    async () => ({ queued: 0, embedding: 0, failures: 0, paused: false, lastError: null }),
    (event) => events.push(event.kind),
  );
  assert.deepEqual(events, ["complete"]);
  assert.equal(registrations.size, 0);
});

test("manual pause during an in-flight poll remains silent", async () => {
  const registrations = new Map([["p1", { projectId: "p1", projectName: "Matter", sawActive: true }]]);
  let resolveStatus: ((value: { queued: number; embedding: number; failures: number; paused: boolean; lastError: string | null }) => void) | undefined;
  const events: string[] = [];
  const poll = pollEmbeddingRegistrations(
    registrations,
    () => new Promise((resolve) => { resolveStatus = resolve; }),
    (event) => events.push(event.kind),
  );
  registrations.delete("p1");
  resolveStatus?.({ queued: 0, embedding: 0, failures: 0, paused: true, lastError: null });
  await poll;
  assert.deepEqual(events, []);
});
