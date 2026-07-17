import { nextGpuQueueEntry, removeGpuQueueEntry } from "@/app/lib/gpuQueue.logic";

export type GpuJobIdentity = {
  kind?: "chat" | "tabular";
  chatId?: string;
  projectId?: string;
  reviewId?: string;
};

export type GpuQueueEntry = GpuJobIdentity & {
  id: string;
  kind: "chat" | "tabular";
  label: string;
  seq: number;
  start: () => void;
  onDequeuedByUser?: () => void;
};

type GpuQueueSnapshot = {
  queue: readonly GpuQueueEntry[];
  tabularRun: GpuJobIdentity | null;
};

let entries: readonly GpuQueueEntry[] = [];
let nextSequence = 0;
let tabularRun: GpuJobIdentity | null = null;
let getBusyChat: () => GpuJobIdentity | null = () => null;
let draining = false;
const listeners = new Set<() => void>();

function publish(): void {
  listeners.forEach((listener) => listener());
}

export function setGpuBusyChatGetter(getter: () => GpuJobIdentity | null): void {
  getBusyChat = getter;
}

export function getGpuQueueSnapshot(): GpuQueueSnapshot {
  return { queue: entries, tabularRun };
}

export function subscribeToGpuQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getGpuBusyJob(): GpuJobIdentity | null {
  return getBusyChat() ?? tabularRun;
}

export function setGpuTabularRun(run: GpuJobIdentity | null): void {
  tabularRun = run ? { ...run, kind: "tabular" } : null;
  publish();
  if (!run) drainGpuQueue();
}

export function enqueueGpuJob(entry: Omit<GpuQueueEntry, "seq">): void {
  entries = [...entries, { ...entry, seq: ++nextSequence }];
  publish();
  drainGpuQueue();
}

export function removeGpuJob(id: string): void {
  const removed = entries.find((entry) => entry.id === id);
  entries = removeGpuQueueEntry(entries, id);
  publish();
  removed?.onDequeuedByUser?.();
}

/**
 * `start` must synchronously mark its job busy (begin a chat session or mark
 * a tabular run) before it returns. This keeps the next drain from dispatching
 * another local-model job while an async request is being opened.
 */
export function drainGpuQueue(): void {
  if (draining) return;
  draining = true;
  try {
    const next = nextGpuQueueEntry(entries, getGpuBusyJob() !== null);
    if (!next) return;
    entries = entries.slice(1);
    publish();
    next.start();
  } finally {
    draining = false;
  }
}

export function clearGpuQueue(): void {
  entries = [];
  tabularRun = null;
  publish();
}
