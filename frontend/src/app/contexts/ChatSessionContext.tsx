"use client";

import { useEffect, type ReactNode } from "react";
import type { DocketMessage } from "@/app/components/shared/types";
import {
  clearGpuQueue,
  drainGpuQueue,
  removeGpuJob,
  setGpuBusyChatGetter,
} from "@/app/contexts/GpuQueueStore";

export type QueuedChatMessage = {
  message: DocketMessage;
  opts?: {
    displayedDoc?: { filename: string; documentId: string } | null;
    selectedDocumentIds?: string[];
  };
};

export type ActiveChatSession = {
  token: symbol;
  seq: number;
  chatId?: string;
  projectId?: string;
  model?: string;
  gpuBound: boolean;
  messages: DocketMessage[];
  isResponseLoading: boolean;
  isLoadingCitations: boolean;
  status: "waiting" | "streaming" | "completed" | "cancelled" | "failed";
  controller?: AbortController;
  flush?: () => void;
  queueJobId?: string;
  waitingMessage?: DocketMessage;
  queuedMessage?: QueuedChatMessage;
  draft?: string;
};

export const EMPTY_SESSIONS: ReadonlyMap<symbol, ActiveChatSession> = new Map();

let sessions: ReadonlyMap<symbol, ActiveChatSession> = EMPTY_SESSIONS;
let nextSequence = 0;
const listeners = new Set<(sessions: ReadonlyMap<symbol, ActiveChatSession>) => void>();

function publish(nextSessions: ReadonlyMap<symbol, ActiveChatSession>): void {
  sessions = nextSessions;
  listeners.forEach((listener) => listener(sessions));
}

function sameDefinedIdentity(
  session: Pick<ActiveChatSession, "chatId" | "projectId">,
  chatId?: string,
  projectId?: string,
): boolean {
  return chatId != null && session.chatId === chatId && session.projectId === projectId;
}

function pruneTerminalSessions(
  source: Map<symbol, ActiveChatSession>,
): Map<symbol, ActiveChatSession> {
  const terminalSessions = [...source.values()]
    .filter((session) => session.status !== "streaming" && session.status !== "waiting")
    .sort((a, b) => a.seq - b.seq);
  const excess = terminalSessions.length - 4;
  for (const session of terminalSessions.slice(0, Math.max(excess, 0))) {
    source.delete(session.token);
  }
  return source;
}

export function getChatSessionsSnapshot(): ReadonlyMap<symbol, ActiveChatSession> {
  return sessions;
}

export function getSessionByToken(token: symbol | null): ActiveChatSession | null {
  return token ? sessions.get(token) ?? null : null;
}

export function getActiveChatSession(
  chatId?: string,
  projectId?: string,
): ActiveChatSession | null {
  const matches = [...sessions.values()]
    .filter((session) => session.chatId === chatId && session.projectId === projectId)
    .sort((a, b) => {
      if (a.status === "streaming" && b.status !== "streaming") return -1;
      if (a.status !== "streaming" && b.status === "streaming") return 1;
      if (a.status === "waiting" && b.status !== "waiting") return -1;
      if (a.status !== "waiting" && b.status === "waiting") return 1;
      return b.seq - a.seq;
    });
  return matches[0] ?? null;
}

export function getStreamingSessions(): ActiveChatSession[] {
  return [...sessions.values()].filter((session) => session.status === "streaming");
}

export function getRunningChatSessions(): ActiveChatSession[] {
  return [...sessions.values()].filter(
    (session) => session.status === "streaming" || session.status === "waiting",
  );
}

export function getGpuBusySession(): ActiveChatSession | null {
  return getStreamingSessions().find((session) => session.gpuBound) ?? null;
}

function beginSession(
  session: Omit<ActiveChatSession, "token" | "seq" | "status">,
  status: ActiveChatSession["status"],
): symbol {
  const nextSessions = new Map(sessions);

  for (const existing of sessions.values()) {
    if (!sameDefinedIdentity(existing, session.chatId, session.projectId)) continue;
    if (existing.status === "streaming") existing.controller?.abort();
    else if (existing.status === "waiting") {
      if (existing.queueJobId) removeGpuJob(existing.queueJobId);
      nextSessions.delete(existing.token);
    }
    else nextSessions.delete(existing.token);
  }

  const token = Symbol("chat-session");
  nextSessions.set(token, {
    ...session,
    token,
    seq: ++nextSequence,
    status,
  });
  publish(pruneTerminalSessions(nextSessions));
  return token;
}

export function beginChatSession(
  session: Omit<ActiveChatSession, "token" | "seq" | "status">,
): symbol {
  return beginSession(session, "streaming");
}

export function beginWaitingChatSession(
  session: Omit<ActiveChatSession, "token" | "seq" | "status">,
): symbol {
  return beginSession(session, "waiting");
}

export function updateActiveChatSession(
  update: Partial<Omit<ActiveChatSession, "token" | "seq">>,
  token: symbol | null,
): void {
  const active = getSessionByToken(token);
  if (!active || !token) return;
  const nextSessions = new Map(sessions);
  nextSessions.set(token, { ...active, ...update });
  publish(nextSessions);
}

export function queueChatMessage(
  token: symbol | null,
  queuedMessage: QueuedChatMessage,
): boolean {
  const active = getSessionByToken(token);
  if (!active || !token || active.queuedMessage) return false;
  updateActiveChatSession({ queuedMessage }, token);
  return true;
}

export function takeQueuedMessage(token: symbol | null): QueuedChatMessage | null {
  const active = getSessionByToken(token);
  if (!active?.queuedMessage || !token) return null;
  const queuedMessage = active.queuedMessage;
  updateActiveChatSession({ queuedMessage: undefined }, token);
  return queuedMessage;
}

export function restoreChatDraft(token: symbol | null, draft: string): void {
  if (!draft.trim()) return;
  updateActiveChatSession({ draft }, token);
}

export function takeChatDraft(token: symbol | null): string | null {
  const active = getSessionByToken(token);
  if (!active?.draft || !token) return null;
  const draft = active.draft;
  updateActiveChatSession({ draft: undefined }, token);
  return draft;
}

export function finishActiveChatSession(
  token: symbol | null,
  status: "completed" | "cancelled" | "failed" = "completed",
): void {
  const active = getSessionByToken(token);
  if (!active || !token) return;
  const nextSessions = new Map(sessions);
  nextSessions.set(token, {
    ...active,
    status,
    isResponseLoading: false,
    isLoadingCitations: false,
    controller: undefined,
  });
  publish(pruneTerminalSessions(nextSessions));
  if (active.gpuBound) drainGpuQueue();
}

export function abortAllChatSessions(): void {
  getRunningChatSessions().forEach((session) => session.controller?.abort());
  clearGpuQueue();
}

export function flushChatSession(token: symbol | null): void {
  getSessionByToken(token)?.flush?.();
}

export function subscribeToChatSession(
  listener: (sessions: ReadonlyMap<symbol, ActiveChatSession>) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Keeps active SSE owners above route components. The streams live in
 * useAssistantChat, while this provider owns the process-lifetime store and
 * makes routes that return to running chats reattach immediately.
 */
export function ChatSessionProvider({ children }: { children: ReactNode }) {
  useEffect(() => () => abortAllChatSessions(), []);
  return <>{children}</>;
}

setGpuBusyChatGetter(() => {
  const session = getGpuBusySession();
  return session ? { ...session, kind: "chat" } : null;
});
