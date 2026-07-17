import assert from "node:assert/strict";
import test from "node:test";
import { nextGpuQueueEntry, removeGpuQueueEntry } from "./gpuQueue.logic";

const first = { id: "first", seq: 1 };
const second = { id: "second", seq: 2 };

test("GPU queue dispatches FIFO only when idle", () => {
  assert.equal(nextGpuQueueEntry([first, second], true), null);
  assert.equal(nextGpuQueueEntry([first, second], false), first);
});

test("GPU queue removes a cancelled entry without disturbing order", () => {
  assert.deepEqual(removeGpuQueueEntry([first, second], "first"), [second]);
});
