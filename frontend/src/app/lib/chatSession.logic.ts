export type RunningChatIdentity = { chatId?: string; projectId?: string };
export type ChatSessionStatus = "streaming" | "completed" | "cancelled" | "failed";
export type AbortableChatSession = RunningChatIdentity & {
  controller?: AbortController;
};

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
  return status === "streaming"
    ? matchesRoute || ownsSession
    : hasSeenSession && matchesRoute;
}

export function isDifferentRunningChat(
  running: RunningChatIdentity | null,
  current: RunningChatIdentity,
): boolean {
  return !!running && (
    running.chatId !== current.chatId || running.projectId !== current.projectId
  );
}

export function runningChatHref(running: RunningChatIdentity): string | undefined {
  if (!running.chatId) return undefined;
  const base = running.projectId
    ? `/projects/${running.projectId}/assistant/chat`
    : "/assistant/chat";
  return `${base}/${running.chatId}`;
}
