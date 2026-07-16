import assert from "node:assert/strict";
import test from "node:test";
import {
  abortAllChatSessions,
  beginChatSession,
  finishActiveChatSession,
  flushChatSession,
  getActiveChatSession,
  getChatSessionsSnapshot,
  getSessionByToken,
  getStreamingSessions,
  subscribeToChatSession,
  updateActiveChatSession,
} from "./ChatSessionContext";

function session(overrides: Partial<Parameters<typeof beginChatSession>[0]> = {}) {
  return {
    messages: [],
    isResponseLoading: true,
    isLoadingCitations: false,
    gpuBound: false,
    controller: new AbortController(),
    ...overrides,
  };
}

test("local and API sessions stream concurrently", () => {
  const localController = new AbortController();
  const apiController = new AbortController();
  const local = beginChatSession(session({
    chatId: "concurrent-local",
    gpuBound: true,
    controller: localController,
  }));
  const api = beginChatSession(session({
    chatId: "concurrent-api",
    controller: apiController,
  }));

  assert.equal(getStreamingSessions().some(({ token }) => token === local), true);
  assert.equal(getStreamingSessions().some(({ token }) => token === api), true);
  assert.equal(localController.signal.aborted, false);
  assert.equal(apiController.signal.aborted, false);
  finishActiveChatSession(local, "completed");
  finishActiveChatSession(api, "completed");
});

test("a new run for the same persisted chat supersedes the previous stream", () => {
  const oldController = new AbortController();
  const oldToken = beginChatSession(session({
    chatId: "superseded-chat",
    projectId: "project-1",
    controller: oldController,
  }));
  const newToken = beginChatSession(session({
    chatId: "superseded-chat",
    projectId: "project-1",
  }));

  assert.equal(oldController.signal.aborted, true);
  assert.equal(getActiveChatSession("superseded-chat", "project-1")?.token, newToken);
  finishActiveChatSession(oldToken, "cancelled");
  finishActiveChatSession(newToken, "completed");
});

test("unpersisted new chats coexist and token-scoped writes stay isolated", () => {
  const first = beginChatSession(session());
  const second = beginChatSession(session());

  updateActiveChatSession({ messages: [{ role: "assistant", content: "first" }] }, first);
  assert.equal(getSessionByToken(first)?.messages[0].content, "first");
  assert.deepEqual(getSessionByToken(second)?.messages, []);
  finishActiveChatSession(first, "completed");
  assert.equal(getSessionByToken(second)?.status, "streaming");
  finishActiveChatSession(second, "completed");
});

test("terminal snapshots remain attachable, flush explicitly, and are capped", () => {
  let flushed = false;
  const token = beginChatSession(session({
    chatId: "flush-chat",
    messages: [{ role: "assistant", content: "partial" }],
    flush: () => { flushed = true; },
  }));
  let publications = 0;
  const unsubscribe = subscribeToChatSession(() => { publications += 1; });
  flushChatSession(token);
  finishActiveChatSession(token, "completed");
  assert.equal(flushed, true);
  assert.equal(getSessionByToken(token)?.isResponseLoading, false);
  assert.equal(getSessionByToken(token)?.status, "completed");
  assert.equal(publications, 1);
  unsubscribe();

  for (let i = 0; i < 5; i += 1) {
    const terminal = beginChatSession(session({ chatId: `terminal-cap-${i}` }));
    finishActiveChatSession(terminal, "completed");
  }
  const terminalCount = [...getChatSessionsSnapshot().values()]
    .filter(({ status }) => status !== "streaming").length;
  assert.ok(terminalCount <= 4);
});

test("provider teardown aborts every streaming controller", () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = beginChatSession(session({ chatId: "abort-all-1", controller: firstController }));
  const second = beginChatSession(session({ chatId: "abort-all-2", controller: secondController }));

  abortAllChatSessions();
  assert.equal(firstController.signal.aborted, true);
  assert.equal(secondController.signal.aborted, true);
  finishActiveChatSession(first, "cancelled");
  finishActiveChatSession(second, "cancelled");
});
