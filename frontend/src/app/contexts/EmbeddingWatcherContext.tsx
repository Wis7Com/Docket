"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { getProjectIndexStatus } from "@/app/lib/docketApi";
import { useNotifications } from "@/app/contexts/NotificationContext";
import {
  pollEmbeddingRegistrations,
  type EmbeddingRegistration,
} from "@/app/lib/embeddingWatcher.logic";

type EmbeddingWatcherValue = {
  registerEmbedding: (project: Omit<EmbeddingRegistration, "sawActive">) => void;
  unregisterEmbedding: (projectId: string) => void;
};

const EmbeddingWatcherContext = createContext<EmbeddingWatcherValue | null>(null);

export function EmbeddingWatcherProvider({ children }: { children: ReactNode }) {
  const { notify } = useNotifications();
  const registrations = useRef(new Map<string, EmbeddingRegistration>());
  const pollInFlight = useRef(false);

  const registerEmbedding = useCallback((project: Omit<EmbeddingRegistration, "sawActive">) => {
    const existing = registrations.current.get(project.projectId);
    registrations.current.set(project.projectId, {
      ...project,
      sawActive: existing?.sawActive ?? false,
    });
  }, []);

  const unregisterEmbedding = useCallback((projectId: string) => {
    registrations.current.delete(projectId);
  }, []);

  useEffect(() => {
    const poll = async () => {
      if (pollInFlight.current || registrations.current.size === 0) return;
      pollInFlight.current = true;
      try {
        await pollEmbeddingRegistrations(
          registrations.current,
          async (projectId) => {
            const semantic = (await getProjectIndexStatus(projectId)).semantic;
            if (!semantic) throw new Error("Semantic indexing is unavailable");
            return {
              queued: semantic.queued_vectors,
              embedding: semantic.status_counts.embedding ?? 0,
              failures: (semantic.status_counts.error ?? 0) + (semantic.status_counts.failed ?? 0),
              paused: semantic.paused,
              lastError: semantic.last_error,
            };
          },
          (event) => {
            const href = `/projects/${event.projectId}`;
            notify({
              title: event.kind === "error" ? "Embedding stopped" : "Embedding complete",
              body: event.kind === "error"
                ? event.error || `${event.projectName} has embedding failures.`
                : event.projectName,
              href,
              kind: event.kind === "error" ? "embedding-error" : "embedding-complete",
              suppressPathPrefix: href,
            });
          },
        );
      } catch {
        // A later polling pass retries transient backend failures.
      } finally {
        pollInFlight.current = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 7000);
    return () => window.clearInterval(interval);
  }, [notify]);

  const value = useMemo(
    () => ({ registerEmbedding, unregisterEmbedding }),
    [registerEmbedding, unregisterEmbedding],
  );
  return <EmbeddingWatcherContext.Provider value={value}>{children}</EmbeddingWatcherContext.Provider>;
}

export function useEmbeddingWatcher(): EmbeddingWatcherValue {
  const value = useContext(EmbeddingWatcherContext);
  if (!value) throw new Error("useEmbeddingWatcher must be used inside EmbeddingWatcherProvider");
  return value;
}
