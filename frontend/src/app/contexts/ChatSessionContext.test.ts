import assert from "node:assert/strict";
import test from "node:test";
import {
  abortActiveChatSession,
  beginChatSession,
  finishActiveChatSession,
  flushActiveChatSession,
  getActiveChatSession,
  getChatSessionSnapshot,
  subscribeToChatSession,
  updateActiveChatSession,
} from "./ChatSessionContext";

test("stream writes continue in the session store after the route owner detaches", () => {
  const token = beginChatSession({
    chatId: "chat-1",
    projectId: "project-1",
    messages: [{ role: "assistant", content: "partial" }],
    isResponseLoading: true,
    isLoadingCitations: false,
    controller: new AbortController(),
  });
  // This is the same direct store update the SSE reader uses after unmount;
  // no React setter/updater is involved.
  updateActiveChatSession({
    messages: [{ role: "assistant", content: "complete response" }],
  });
  assert.equal(
    getActiveChatSession("chat-1", "project-1")?.messages[0].content,
    "complete response",
  );
  finishActiveChatSession(token, "completed");
});

test("reattaching flushes once and terminal publication clears loading", () => {
  let flushed = false;
  const token = beginChatSession({
    chatId: "chat-1",
    projectId: "project-1",
    messages: [{ role: "assistant", content: "partial" }],
    isResponseLoading: true,
    isLoadingCitations: false,
    controller: new AbortController(),
    flush: () => { flushed = true; },
  });
  let publications = 0;
  const unsubscribe = subscribeToChatSession(() => { publications += 1; });
  flushActiveChatSession();
  assert.equal(flushed, true);
  finishActiveChatSession(token, "completed");
  assert.equal(getChatSessionSnapshot()?.isResponseLoading, false);
  assert.equal(getChatSessionSnapshot()?.status, "completed");
  assert.equal(publications, 1);
  unsubscribe();
});

test("ordinary stream updates never invoke the session flush callback", () => {
  let flushes = 0;
  const token = beginChatSession({
    chatId: "chat-no-cascade",
    messages: [],
    isResponseLoading: true,
    isLoadingCitations: false,
    controller: new AbortController(),
    flush: () => { flushes += 1; },
  });
  updateActiveChatSession({ messages: [{ role: "assistant", content: "delta" }] }, token);
  assert.equal(flushes, 0);
  finishActiveChatSession(token, "completed");
});

test("new-chat chat_id replacement is owned by the active stream token", () => {
  const token = beginChatSession({
    messages: [],
    isResponseLoading: true,
    isLoadingCitations: false,
    controller: new AbortController(),
  });
  updateActiveChatSession({ chatId: "persisted-chat" }, token);
  assert.equal(getChatSessionSnapshot()?.chatId, "persisted-chat");
  finishActiveChatSession(token, "completed");
});

test("the layout owner aborts the outstanding session only when it unmounts", () => {
  const controller = new AbortController();
  const token = beginChatSession({
    chatId: "chat-2",
    messages: [],
    isResponseLoading: true,
    isLoadingCitations: false,
    controller,
  });
  assert.equal(controller.signal.aborted, false);
  abortActiveChatSession();
  assert.equal(controller.signal.aborted, true);
  finishActiveChatSession(token, "cancelled");
});
