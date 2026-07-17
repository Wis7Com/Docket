import assert from "node:assert/strict";
import test from "node:test";
import {
  controllerForChatCancel,
  evaluateChatAdmission,
  isDifferentRunningChat,
  runningChatHref,
  selectAttachedSession,
  shouldAttachChatSession,
  shouldRouteWriteToSession,
  streamingChatKeys,
} from "./chatSession.logic";

test("a completed snapshot does not shadow hydration on a later mount", () => {
  assert.equal(shouldAttachChatSession("completed", true, false, false), false);
  assert.equal(shouldAttachChatSession("completed", true, false, true), true);
  assert.equal(shouldAttachChatSession("completed", false, false, true), false);
  assert.equal(shouldAttachChatSession("streaming", true, false, false), true);
  assert.equal(shouldAttachChatSession("waiting", true, false, false), true);
  assert.equal(shouldAttachChatSession("streaming", false, false, true), false);
});

test("attached-session selection prefers a matching stream then highest sequence", () => {
  const terminal = Symbol("terminal");
  const streaming = Symbol("streaming");
  const sessions = new Map([
    [terminal, { token: terminal, seq: 1, status: "completed" as const, chatId: "chat-1" }],
    [streaming, { token: streaming, seq: 2, status: "streaming" as const, chatId: "chat-1" }],
  ]);
  assert.equal(selectAttachedSession(sessions, { chatId: "chat-1" }, null, terminal)?.token, streaming);
  assert.equal(selectAttachedSession(sessions, { chatId: "chat-1" }, null, null)?.token, streaming);

  const newer = Symbol("newer");
  const terminalOnly = new Map([
    [terminal, { token: terminal, seq: 1, status: "completed" as const, chatId: "chat-1" }],
    [newer, { token: newer, seq: 3, status: "failed" as const, chatId: "chat-1" }],
  ]);
  assert.equal(selectAttachedSession(terminalOnly, { chatId: "chat-1" }, null, terminal)?.token, terminal);
  assert.equal(selectAttachedSession(terminalOnly, { chatId: "chat-1" }, null, null), null);
  assert.equal(selectAttachedSession(terminalOnly, { chatId: "chat-1" }, null, newer)?.token, newer);
});

test("route writes reach only the streaming session owned by this hook instance", () => {
  const owned = Symbol("owned");
  const other = Symbol("other");
  const session = {
    token: owned,
    seq: 1,
    status: "streaming" as const,
    chatId: "chat-1",
    projectId: "project-1",
  };

  assert.equal(
    shouldRouteWriteToSession(session, { chatId: "chat-1", projectId: "project-1" }, owned),
    true,
  );
  assert.equal(
    shouldRouteWriteToSession(session, { chatId: "chat-1", projectId: "project-1" }, other),
    false,
  );
  assert.equal(
    shouldRouteWriteToSession(session, { chatId: "chat-2", projectId: "project-1" }, owned),
    false,
  );
  assert.equal(
    shouldRouteWriteToSession(null, { chatId: "chat-1", projectId: "project-1" }, owned),
    false,
  );
});

test("GPU admission queues a different local chat", () => {
  const busy = { chatId: "chat-1", projectId: "project-1" };
  assert.deepEqual(evaluateChatAdmission({
    gpuBound: true,
    gpuBusySession: busy,
    current: { chatId: "chat-2", projectId: "project-1" },
  }), { kind: "queue-local-busy", conflict: busy });
  assert.deepEqual(evaluateChatAdmission({
    gpuBound: true,
    gpuBusySession: busy,
    current: busy,
  }), { kind: "allow" });
  assert.deepEqual(evaluateChatAdmission({
    gpuBound: false,
    gpuBusySession: busy,
    current: { chatId: "chat-2" },
  }), { kind: "allow" });
  assert.deepEqual(evaluateChatAdmission({
    gpuBound: true,
    gpuBusySession: null,
    current: { chatId: "chat-2" },
  }), { kind: "allow" });
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

test("streaming chat keys include persisted streams with their project identity", () => {
  const global = Symbol("global");
  const project = Symbol("project");
  const completed = Symbol("completed");
  const unsaved = Symbol("unsaved");
  const sessions = new Map([
    [global, { token: global, seq: 1, status: "streaming" as const, chatId: "chat-1" }],
    [project, { token: project, seq: 2, status: "streaming" as const, chatId: "chat-1", projectId: "project-1" }],
    [completed, { token: completed, seq: 3, status: "completed" as const, chatId: "chat-2" }],
    [unsaved, { token: unsaved, seq: 4, status: "streaming" as const }],
  ]);

  assert.deepEqual([...streamingChatKeys(sessions)].sort(), [
    JSON.stringify([null, "chat-1"]),
    JSON.stringify(["project-1", "chat-1"]),
  ].sort());
});

test("waiting chats remain visible as in-progress sidebar activity", () => {
  const waiting = Symbol("waiting");
  const sessions = new Map([
    [waiting, { token: waiting, seq: 1, status: "waiting" as const, chatId: "chat-1" }],
  ]);
  assert.deepEqual([...streamingChatKeys(sessions)], [JSON.stringify([null, "chat-1"])]);
});
