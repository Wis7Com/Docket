export type RunningChatIdentity = { kind?: "chat" | "tabular"; chatId?: string; projectId?: string };
export type ChatSessionStatus = "waiting" | "streaming" | "completed" | "cancelled" | "failed";
export type AbortableChatSession = RunningChatIdentity & {
  controller?: AbortController;
};
export type SelectableChatSession = RunningChatIdentity & {
  token: symbol;
  seq: number;
  status: ChatSessionStatus;
};

export type ChatAdmission =
  | { kind: "allow" }
  | { kind: "queue-local-busy"; conflict: RunningChatIdentity };

export function controllerForChatCancel(
  localController: AbortController | null,
  activeSession: AbortableChatSession | null,
  chatId?: string,
  projectId?: string,
): AbortController | null {
  if (localController) return localController;
  if (!activeSession) return null;
  return activeSession.chatId === chatId && activeSession.projectId === projectId
    ? activeSession.controller ?? null
    : null;
}

export function shouldAttachChatSession(
  status: ChatSessionStatus,
  matchesRoute: boolean,
  ownsSession: boolean,
  hasSeenSession: boolean,
): boolean {
  // A terminal snapshot is only for a route that was already attached while
  // streaming. A later mount must use freshly hydrated persisted messages.
  return status === "streaming" || status === "waiting"
    ? matchesRoute || ownsSession
    : hasSeenSession && matchesRoute;
}

export function selectAttachedSession<T extends SelectableChatSession>(
  sessions: ReadonlyMap<symbol, T>,
  route: RunningChatIdentity,
  ownerToken: symbol | null,
  seenToken: symbol | null,
): T | null {
  const candidates = [...sessions.values()]
    .filter((session) => shouldAttachChatSession(
      session.status,
      session.chatId === route.chatId && session.projectId === route.projectId,
      session.token === ownerToken,
      session.token === seenToken,
    ))
    .sort((a, b) => {
      if (a.status === "streaming" && b.status !== "streaming") return -1;
      if (a.status !== "streaming" && b.status === "streaming") return 1;
      if (a.status === "waiting" && b.status !== "waiting") return -1;
      if (a.status !== "waiting" && b.status === "waiting") return 1;
      return b.seq - a.seq;
    });
  return candidates[0] ?? null;
}

/**
 * Route-level setters may update a streaming snapshot only when this hook
 * instance owns that snapshot. Fresh mounts use local state while the session
 * remains the rendered source of truth, so hydration cannot overwrite a live
 * trailing assistant message.
 */
export function shouldRouteWriteToSession(
  session: SelectableChatSession | null,
  route: RunningChatIdentity,
  ownedToken: symbol | null,
): boolean {
  return session?.status === "streaming"
    && session.chatId === route.chatId
    && session.projectId === route.projectId
    && session.token === ownedToken;
}

export function isDifferentRunningChat(
  running: RunningChatIdentity | null,
  current: RunningChatIdentity,
): boolean {
  if (running?.kind === "tabular") return true;
  return !!running && (
    running.chatId !== current.chatId || running.projectId !== current.projectId
  );
}

export function evaluateChatAdmission({
  gpuBound,
  gpuBusySession,
  current,
}: {
  gpuBound: boolean;
  gpuBusySession: RunningChatIdentity | null;
  current: RunningChatIdentity;
}): ChatAdmission {
  // Two new chats have no id until their first SSE event. Treating both as
  // the same chat preserves retry semantics during that short window.
  return gpuBound && gpuBusySession && isDifferentRunningChat(gpuBusySession, current)
    ? { kind: "queue-local-busy", conflict: gpuBusySession }
    : { kind: "allow" };
}

export function runningChatHref(running: RunningChatIdentity): string | undefined {
  if (!running.chatId) return undefined;
  const base = running.projectId
    ? `/projects/${running.projectId}/assistant/chat`
    : "/assistant/chat";
  return `${base}/${running.chatId}`;
}

/**
 * A stable identity for a persisted chat. JSON keeps project and chat IDs
 * unambiguous even if either contains a conventional delimiter.
 */
export function chatSessionKey(chatId: string, projectId?: string | null): string {
  return JSON.stringify([projectId ?? null, chatId]);
}

/**
 * Returns the persisted chats that currently own an in-progress response.
 * Sessions for brand-new chats are omitted until their stream assigns a chat
 * ID, because no history row exists for them yet.
 */
export function streamingChatKeys<T extends SelectableChatSession>(
  sessions: ReadonlyMap<symbol, T>,
): Set<string> {
  const keys = new Set<string>();
  for (const session of sessions.values()) {
    if ((session.status === "streaming" || session.status === "waiting") && session.chatId != null) {
      keys.add(chatSessionKey(session.chatId, session.projectId));
    }
  }
  return keys;
}
