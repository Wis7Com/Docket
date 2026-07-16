import assert from "node:assert/strict";
import test from "node:test";
import {
  isDifferentRunningChat,
  runningChatHref,
  shouldAttachChatSession,
  controllerForChatCancel,
} from "./chatSession.logic";

test("a completed snapshot does not shadow hydration on a later mount", () => {
  assert.equal(shouldAttachChatSession("completed", true, false, false), false);
  assert.equal(shouldAttachChatSession("completed", true, false, true), true);
  assert.equal(shouldAttachChatSession("completed", false, false, true), false);
  assert.equal(shouldAttachChatSession("streaming", true, false, false), true);
  assert.equal(shouldAttachChatSession("streaming", false, false, true), false);
});

test("a different active chat is blocked and points to its persisted route", () => {
  const running = { chatId: "chat-1", projectId: "project-1" };
  assert.equal(isDifferentRunningChat(running, { chatId: "chat-2", projectId: "project-1" }), true);
  assert.equal(runningChatHref(running), "/projects/project-1/assistant/chat/chat-1");
});

test("the same chat may restart and an unpersisted new chat has no misleading route", () => {
  assert.equal(isDifferentRunningChat({ chatId: "chat-1" }, { chatId: "chat-1" }), false);
  assert.equal(runningChatHref({}), undefined);
});

test("a reattached chat resolves and aborts its active session controller", () => {
  const controller = new AbortController();
  const resolved = controllerForChatCancel(
    null,
    { chatId: "chat-1", projectId: "project-1", controller },
    "chat-1",
    "project-1",
  );
  resolved?.abort();
  assert.equal(controller.signal.aborted, true);
});
