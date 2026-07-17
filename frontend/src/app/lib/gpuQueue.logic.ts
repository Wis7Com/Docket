export type GpuQueueEntry = {
  id: string;
  seq: number;
};

export function nextGpuQueueEntry<T extends GpuQueueEntry>(
  queue: readonly T[],
  isBusy: boolean,
): T | null {
  return isBusy ? null : queue[0] ?? null;
}

export function removeGpuQueueEntry<T extends GpuQueueEntry>(
  queue: readonly T[],
  id: string,
): T[] {
  return queue.filter((entry) => entry.id !== id);
}
