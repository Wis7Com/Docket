import type { AssistantEvent, DocketMessage } from "@/app/components/shared/types";

export type MessageWithAssistantEvents = {
  role: "user" | "assistant";
  events?: AssistantEvent[];
};

export function findLastContentIndex(events: AssistantEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === "content") return i;
  }
  return -1;
}

export function updateLastAssistantContentEvent<T extends MessageWithAssistantEvents>(
  prev: T[],
  text: string,
  isStreaming?: boolean,
): T[] {
  const updated = [...prev];
  const last = updated[updated.length - 1];
  if (last?.role !== "assistant") return prev;
  const events = last.events ?? [];
  const idx = findLastContentIndex(events);
  if (idx < 0) return prev;
  const existing = events[idx];
  if (existing.type === "content") {
    // This helper is exclusively the typewriter/drip write path. Once a
    // content event has been finalized (notably by content_replace), it is
    // authoritative and immutable to stale timers and terminal flushes.
    if (!existing.isStreaming) return prev;
    if (text.length < existing.text.length) return prev;
  }
  const newEvents = [...events];
  newEvents[idx] = isStreaming
    ? { type: "content", text, isStreaming: true }
    : { type: "content", text };
  updated[updated.length - 1] = { ...last, events: newEvents };
  return updated;
}

export function finalizedMessagesWithHydratedTail(
  localMessages: DocketMessage[],
  hydratedMessages: DocketMessage[],
): DocketMessage[] {
  const fetchedLast = hydratedMessages.at(-1);
  if (
    fetchedLast?.role === "assistant" ||
    hydratedMessages.length >= localMessages.length
  ) {
    return hydratedMessages;
  }
  return localMessages;
}
