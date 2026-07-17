import { streamTabularGeneration } from "@/app/lib/docketApi";
import {
  enqueueGpuJob,
  getGpuBusyJob,
  removeGpuJob,
  setGpuTabularRun,
} from "@/app/contexts/GpuQueueStore";
import type { TabularCell } from "@/app/components/shared/types";

export type TabularRunStatus = "waiting" | "running" | "completed" | "failed" | "cancelled";

export type TabularRun = {
  runId: string;
  reviewId: string;
  projectId: string;
  status: TabularRunStatus;
  gpuBound: boolean;
  updates: ReadonlyMap<string, Pick<TabularCell, "document_id" | "column_index" | "content" | "status">>;
  cancel: () => void;
};

type StartOptions = {
  projectId: string;
  reviewId: string;
  title: string;
  gpuBound: boolean;
  notify: (notification: { title: string; body: string; href: string; kind: "tabular-complete" | "tabular-error" }) => void;
};

let run: TabularRun | null = null;
const listeners = new Set<() => void>();

function publish(next: TabularRun | null): void {
  run = next;
  listeners.forEach((listener) => listener());
}

export function getTabularRunSnapshot(): TabularRun | null {
  return run;
}

export function subscribeToTabularRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function cellKey(documentId: string, columnIndex: number): string {
  return `${documentId}:${columnIndex}`;
}

export function startTabularRun(options: StartOptions): TabularRun {
  if (run && (run.status === "waiting" || run.status === "running")) return run;

  const runId = `tabular-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const controller = new AbortController();
  let queueJobId: string | null = null;

  const cancel = () => {
    if (queueJobId) removeGpuJob(queueJobId);
    controller.abort();
    if (run?.runId === runId) publish({ ...run, status: "cancelled" });
    if (options.gpuBound) setGpuTabularRun(null);
  };

  const begin = () => {
    if (run?.runId !== runId) return;
    if (options.gpuBound) setGpuTabularRun({ reviewId: options.reviewId, projectId: options.projectId });
    publish({ ...run, status: "running" });
    void (async () => {
      let status: TabularRunStatus = "completed";
      try {
        const response = await streamTabularGeneration(options.projectId, options.reviewId, controller.signal);
        if (!response.ok || !response.body) throw new Error("Unable to start tabular generation");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;
            try {
              const data = JSON.parse(dataStr);
              if (data.type !== "cell_update" || run?.runId !== runId) continue;
              const updates = new Map(run.updates);
              updates.set(cellKey(data.document_id, data.column_index), {
                document_id: data.document_id,
                column_index: data.column_index,
                content: data.content,
                status: data.status,
              });
              publish({ ...run, updates });
            } catch {
              // Ignore malformed progress events; the persisted review is re-fetched on return.
            }
          }
        }
      } catch (error) {
        status = controller.signal.aborted ? "cancelled" : "failed";
      } finally {
        if (run?.runId !== runId) return;
        publish({ ...run, status });
        if (options.gpuBound) setGpuTabularRun(null);
        if (status !== "cancelled") {
          options.notify({
            title: status === "completed" ? "Tabular Review 완료" : "Tabular Review 실패",
            body: options.title,
            href: `/projects/${options.projectId}/tabular-reviews/${options.reviewId}`,
            kind: status === "completed" ? "tabular-complete" : "tabular-error",
          });
        }
      }
    })();
  };

  const initial: TabularRun = {
    runId,
    reviewId: options.reviewId,
    projectId: options.projectId,
    status: options.gpuBound && getGpuBusyJob() ? "waiting" : "running",
    gpuBound: options.gpuBound,
    updates: new Map(),
    cancel,
  };
  publish(initial);
  if (initial.status === "waiting") {
    queueJobId = runId;
    enqueueGpuJob({
      id: queueJobId,
      kind: "tabular",
      label: options.title,
      reviewId: options.reviewId,
      projectId: options.projectId,
      start: begin,
    });
  } else {
    begin();
  }
  return initial;
}
