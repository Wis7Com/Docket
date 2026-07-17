import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("assistant composer exposes +, tool toggles, and @ workflow selection", () => {
  const chatInput = fs.readFileSync(
    new URL("./ChatInput.tsx", import.meta.url),
    "utf8",
  );
  const addButton = fs.readFileSync(
    new URL("./AddDocButton.tsx", import.meta.url),
    "utf8",
  );
  const toolsMenu = fs.readFileSync(
    new URL("./ChatToolsMenu.tsx", import.meta.url),
    "utf8",
  );

  assert.match(addButton, /data-session-check="chat-add-trigger"/);
  assert.match(addButton, /aria-label="Add files"/);
  assert.match(addButton, /uploadProjectDocument\(projectId, file\)/);
  assert.match(chatInput, /data-session-check="workflow-mention-menu"/);
  assert.match(chatInput, /role="listbox"/);
  assert.doesNotMatch(chatInput, /aria-label="Open workflows"/);
  assert.match(toolsMenu, /data-session-check="chat-tools-trigger"/);
  assert.match(toolsMenu, /No MCP servers connected\./);
  assert.match(toolsMenu, /onCheckedChange/);
});

test("project chat shows + and forwards request-level tool preferences", () => {
  const projectChat = fs.readFileSync(
    new URL(
      "../../(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const chatHook = fs.readFileSync(
    new URL("../../hooks/useAssistantChat.ts", import.meta.url),
    "utf8",
  );
  const docketApi = fs.readFileSync(
    new URL("../../lib/docketApi.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(projectChat, /hideAddDocButton/);
  assert.match(projectChat, /projectId=\{projectId\}/);
  assert.match(chatHook, /disabled_tools: message\.disabled_tools/g);
  assert.match(docketApi, /disabled_tools\?: string\[\]/g);
});

test("composer sends a typed next turn while retaining stop for an empty composer", () => {
  const chatInput = fs.readFileSync(
    new URL("./ChatInput.tsx", import.meta.url),
    "utf8",
  );
  assert.match(chatInput, /if \(isLoading && !value\.trim\(\)\)/);
  assert.match(chatInput, /if \(isLoading\) onQueueMessage\?\.\(nextMessage\)/);
  assert.match(chatInput, /hasQueuedMessage/);
});
