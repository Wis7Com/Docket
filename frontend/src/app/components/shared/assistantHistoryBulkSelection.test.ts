import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sidebarSource = fs.readFileSync(
  new URL("./AppSidebar.tsx", import.meta.url),
  "utf8",
);
const chatItemSource = fs.readFileSync(
  new URL("./SidebarChatItem.tsx", import.meta.url),
  "utf8",
);

test("assistant history exposes selected-chat bulk deletion", () => {
  assert.match(sidebarSource, /historySelectionMode/);
  assert.match(sidebarSource, /Select all/);
  assert.match(sidebarSource, /Delete selected chats/);
  assert.match(
    sidebarSource,
    /Promise\.all\(ids\.map\(\(id\) => deleteChat\(id\)\)\)/,
  );
});

test("assistant history selection remains creator-only", () => {
  assert.match(
    sidebarSource,
    /chat\.user_id === user\.id/,
    "select-all must only include chats owned by the signed-in user",
  );
  assert.match(chatItemSource, /disabled=\{!isChatOwner\}/);
  assert.match(chatItemSource, /selectionMode \? onToggleSelected : onSelect/);
});

test("assistant history marks streams in progress", () => {
  assert.match(sidebarSource, /useSyncExternalStore/);
  assert.match(sidebarSource, /streamingChatKeys/);
  assert.match(sidebarSource, /chatSessionKey\(chat\.id, chat\.project_id\)/);
  assert.match(chatItemSource, /Answer in progress/);
});
