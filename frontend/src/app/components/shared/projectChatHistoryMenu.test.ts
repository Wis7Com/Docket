import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const menuSource = fs.readFileSync(
    new URL("./ProjectChatHistoryMenu.tsx", import.meta.url),
    "utf8",
);
const projectChatPageSource = fs.readFileSync(
    new URL(
        "../../(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx",
        import.meta.url,
    ),
    "utf8",
);

test("project chat picker renders a below-trigger dropdown", () => {
    assert.match(menuSource, /side="bottom"/);
    assert.match(menuSource, /avoidCollisions=\{false\}/);
    assert.match(menuSource, /project-chat-history-picker/);
    assert.doesNotMatch(projectChatPageSource, /<select[\s\S]*project-chat-history-picker/);
});

test("project chat dropdown exposes creation and per-chat management", () => {
    assert.match(menuSource, /\n\s*New Chat\n/);
    assert.match(menuSource, /Rename chat/);
    assert.match(menuSource, /Delete chat/);
    assert.match(menuSource, /onRenameChat\(chatId, title\)/);
    assert.match(menuSource, /onDeleteChats\(chatIds\)/);
});

test("project chat dropdown supports creator-only bulk deletion", () => {
    assert.match(menuSource, /chat\.user_id === currentUserId/);
    assert.match(menuSource, /Select all/);
    assert.match(menuSource, /Delete selected chats/);
    assert.match(menuSource, /onDeleteChats\(chatIds\)/);
});

test("project chat dropdown marks streams in progress", () => {
    assert.match(menuSource, /useSyncExternalStore/);
    assert.match(menuSource, /streamingChatKeys/);
    assert.match(menuSource, /chatSessionKey\(chat\.id, projectId\)/);
    assert.match(menuSource, /Answer in progress/);
});

test("project chat header actions have visible English tooltips", () => {
    assert.match(projectChatPageSource, /role="tooltip"/);
    assert.match(projectChatPageSource, /text="Start a new chat"/);
    assert.match(projectChatPageSource, /text="Delete this chat"/);
    assert.match(projectChatPageSource, /group-hover:visible/);
    assert.match(projectChatPageSource, /group-focus-within:visible/);
});
