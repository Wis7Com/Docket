import assert from "node:assert/strict";
import test from "node:test";
import {
    MAX_STORED_CHAT_MODELS,
    chatModelStorageId,
    parseStoredChatModels,
    resolveSelectedModel,
    type StoredChatModels,
    updateStoredChatModels,
} from "./useSelectedModel";

const localModel = "ollama:gemma4:12b-mlx";
const routerModel = "free-router:auto";
const defaultModel = "gemini-3-flash-preview";

test("chat model storage ids distinguish project and global chats", () => {
    assert.equal(chatModelStorageId("chat-1"), JSON.stringify([null, "chat-1"]));
    assert.equal(chatModelStorageId("chat-1", "project-1"), JSON.stringify(["project-1", "chat-1"]));
    assert.equal(chatModelStorageId(), null);
});

test("stored chat models discard malformed and unsupported entries", () => {
    assert.deepEqual(parseStoredChatModels("not json"), {});
    assert.deepEqual(parseStoredChatModels(JSON.stringify({
        good: { model: localModel, lastUsed: 1 },
        badModel: { model: "unsupported", lastUsed: 2 },
        badDate: { model: routerModel, lastUsed: "now" },
    })), {
        good: { model: localModel, lastUsed: 1 },
    });
});

test("stored chat models are capped while parsing an oversized persisted value", () => {
    const raw = Object.fromEntries(
        Array.from({ length: MAX_STORED_CHAT_MODELS + 1 }, (_, index) => [
            `chat-${index}`,
            { model: localModel, lastUsed: index },
        ]),
    );
    const stored = parseStoredChatModels(JSON.stringify(raw));
    assert.equal(Object.keys(stored).length, MAX_STORED_CHAT_MODELS);
    assert.equal(stored["chat-0"], undefined);
});

test("updating chat model storage keeps the most recently used fifty entries", () => {
    let stored: StoredChatModels = {};
    for (let index = 0; index <= MAX_STORED_CHAT_MODELS; index += 1) {
        stored = updateStoredChatModels(stored, `chat-${index}`, localModel, index);
    }
    assert.equal(Object.keys(stored).length, MAX_STORED_CHAT_MODELS);
    assert.equal(stored["chat-0"], undefined);
    assert.equal(stored["chat-50"]?.model, localModel);
});

test("model display priority preserves a local explicit change over a streaming session", () => {
    assert.equal(resolveSelectedModel({
        dirtyModel: routerModel,
        streamingModel: localModel,
        chatModel: localModel,
        globalModel: defaultModel,
    }), routerModel);
    assert.equal(resolveSelectedModel({
        streamingModel: localModel,
        chatModel: routerModel,
        globalModel: defaultModel,
    }), localModel);
    assert.equal(resolveSelectedModel({
        chatModel: routerModel,
        globalModel: defaultModel,
    }), routerModel);
    assert.equal(resolveSelectedModel({ globalModel: defaultModel }), defaultModel);
});
