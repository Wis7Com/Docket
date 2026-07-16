"use client";

import { useEffect, type ReactNode } from "react";
import type { DocketMessage } from "@/app/components/shared/types";

export type ActiveChatSession = {
  token: symbol;
  chatId?: string;
  projectId?: string;
  messages: DocketMessage[];
  isResponseLoading: boolean;
  isLoadingCitations: boolean;
  status: "streaming" | "completed" | "cancelled" | "failed";
  controller?: AbortController;
  flush?: () => void;
};

let sessionSnapshot: ActiveChatSession | null = null;
const listeners = new Set<(session: ActiveChatSession | null) => void>();

function publish() {
  listeners.forEach((listener) => listener(sessionSnapshot));
}

export function getChatSessionSnapshot(): ActiveChatSession | null {
  return sessionSnapshot;
}

export function getActiveChatSession(
  chatId?: string,
  projectId?: string,
): ActiveChatSession | null {
  if (
    !sessionSnapshot ||
    sessionSnapshot.chatId !== chatId ||
    sessionSnapshot.projectId !== projectId
  ) {
    return null;
  }
  return sessionSnapshot;
}

export function getAnyActiveChatSession(): ActiveChatSession | null {
  return sessionSnapshot?.status === "streaming" ? sessionSnapshot : null;
}

export function beginChatSession(
  session: Omit<ActiveChatSession, "token" | "status">,
): symbol {
  getAnyActiveChatSession()?.controller?.abort();
  const token = Symbol("chat-session");
  sessionSnapshot = { ...session, token, status: "streaming" };
  publish();
  return token;
}

export function updateActiveChatSession(
  update: Partial<ActiveChatSession>,
  token?: symbol | null,
): void {
  if (!sessionSnapshot || (token && sessionSnapshot.token !== token)) return;
  sessionSnapshot = { ...sessionSnapshot, ...update };
  publish();
}

export function finishActiveChatSession(
  token: symbol | null,
  status: "completed" | "cancelled" | "failed" = "completed",
): void {
  if (!sessionSnapshot || sessionSnapshot.token !== token) return;
  sessionSnapshot = {
    ...sessionSnapshot,
    status,
    isResponseLoading: false,
    isLoadingCitations: false,
    controller: undefined,
  };
  publish();
}

export function abortActiveChatSession(): void {
  getAnyActiveChatSession()?.controller?.abort();
}

export function flushActiveChatSession(): void {
  getAnyActiveChatSession()?.flush?.();
}

export function subscribeToChatSession(
  listener: (session: ActiveChatSession | null) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Keeps the active SSE owner above route components. The actual stream lives
 * in useAssistantChat, while this provider owns the process-lifetime store
 * and makes a route that returns to the same chat reattach immediately.
 */
export function ChatSessionProvider({ children }: { children: ReactNode }) {
  useEffect(() => () => abortActiveChatSession(), []);
  return <>{children}</>;
}
