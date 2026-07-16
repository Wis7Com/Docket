export type EmbeddingSnapshot = {
  queued: number;
  embedding: number;
  failures: number;
  paused: boolean;
  lastError: string | null;
};

export type EmbeddingRegistration = {
  projectId: string;
  projectName: string;
  sawActive: boolean;
};

export type EmbeddingWatchNotification = {
  projectId: string;
  projectName: string;
  kind: "complete" | "error";
  error?: string | null;
};

export function embeddingTransition(
  sawActive: boolean,
  snapshot: EmbeddingSnapshot,
): "wait" | "complete" | "error" {
  const active = snapshot.queued + snapshot.embedding > 0;
  if (active || !sawActive) return "wait";
  return snapshot.failures > 0 || snapshot.paused
    ? "error"
    : "complete";
}

/** Poll one stable registration snapshot. Re-checking identity after await
 * makes an explicit pause/unregister during the request silent. */
export async function pollEmbeddingRegistrations(
  registrations: Map<string, EmbeddingRegistration>,
  readStatus: (projectId: string) => Promise<EmbeddingSnapshot>,
  notify: (notification: EmbeddingWatchNotification) => void,
): Promise<void> {
  await Promise.all([...registrations.values()].map(async (registration) => {
    const snapshot = await readStatus(registration.projectId);
    const current = registrations.get(registration.projectId);
    if (!current || current !== registration) return;

    if (snapshot.queued + snapshot.embedding > 0) {
      registrations.set(registration.projectId, { ...current, sawActive: true });
      return;
    }

    const transition = embeddingTransition(current.sawActive, snapshot);
    if (transition === "wait" || registrations.get(registration.projectId) !== current) return;

    registrations.delete(registration.projectId);
    notify({
      projectId: current.projectId,
      projectName: current.projectName,
      kind: transition === "error" ? "error" : "complete",
      error: snapshot.lastError,
    });
  }));
}
