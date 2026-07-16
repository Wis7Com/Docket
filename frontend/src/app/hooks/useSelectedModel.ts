"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
} from "react";
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID } from "../components/assistant/ModelToggle";
import {
    EMPTY_SESSIONS,
    getActiveChatSession,
    getChatSessionsSnapshot,
    subscribeToChatSession,
} from "../contexts/ChatSessionContext";

const STORAGE_KEY = "docket.selectedModel";
export const CHAT_STORAGE_KEY = "docket.selectedModel.byChat";
export const MAX_STORED_CHAT_MODELS = 50;

export type StoredChatModels = Record<string, { model: string; lastUsed: number }>;

function isAllowedModel(model: unknown): model is string {
    return typeof model === "string" && ALLOWED_MODEL_IDS.has(model);
}

function readStored(): string {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isAllowedModel(raw) ? raw : DEFAULT_MODEL_ID;
}

export function chatModelStorageId(chatId?: string, projectId?: string): string | null {
    return chatId == null ? null : JSON.stringify([projectId ?? null, chatId]);
}

function trimStoredChatModels(stored: StoredChatModels): StoredChatModels {
    return Object.fromEntries(
        Object.entries(stored)
            .sort(([leftKey, left], [rightKey, right]) =>
                right.lastUsed - left.lastUsed || leftKey.localeCompare(rightKey),
            )
            .slice(0, MAX_STORED_CHAT_MODELS),
    );
}

export function parseStoredChatModels(raw: string | null): StoredChatModels {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return trimStoredChatModels(Object.fromEntries(
            Object.entries(parsed).flatMap(([key, value]) => {
                if (!value || typeof value !== "object" || Array.isArray(value)) return [];
                const { model, lastUsed } = value as { model?: unknown; lastUsed?: unknown };
                return isAllowedModel(model) && typeof lastUsed === "number" && Number.isFinite(lastUsed)
                    ? [[key, { model, lastUsed }]]
                    : [];
            }),
        ));
    } catch {
        return {};
    }
}

export function updateStoredChatModels(
    stored: StoredChatModels,
    chatKey: string,
    model: string,
    lastUsed = Date.now(),
): StoredChatModels {
    if (!isAllowedModel(model)) return stored;
    const next = {
        ...stored,
        [chatKey]: { model, lastUsed },
    };
    return trimStoredChatModels(next);
}

export function resolveSelectedModel({
    dirtyModel,
    streamingModel,
    chatModel,
    globalModel,
}: {
    dirtyModel?: string | null;
    streamingModel?: string | null;
    chatModel?: string | null;
    globalModel?: string | null;
}): string {
    for (const candidate of [dirtyModel, streamingModel, chatModel, globalModel]) {
        if (isAllowedModel(candidate)) return candidate;
    }
    return DEFAULT_MODEL_ID;
}

function readStoredChatModels(): StoredChatModels {
    if (typeof window === "undefined") return {};
    return parseStoredChatModels(window.localStorage.getItem(CHAT_STORAGE_KEY));
}

export function persistSelectedModelForChat(
    chatId: string,
    projectId: string | undefined,
    model: string | undefined,
): void {
    const chatKey = chatModelStorageId(chatId, projectId);
    if (typeof window === "undefined" || !chatKey || !isAllowedModel(model)) return;
    const updated = updateStoredChatModels(readStoredChatModels(), chatKey, model);
    window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(updated));
}

export function useSelectedModel(
    chatId?: string,
    projectId?: string,
): [string, (id: string) => void] {
    // The subscription keeps the displayed selection pinned to the model that
    // owns a live answer when this composer has not made its own selection.
    useSyncExternalStore(
        subscribeToChatSession,
        getChatSessionsSnapshot,
        () => EMPTY_SESSIONS,
    );
    const chatKey = useMemo(
        () => chatModelStorageId(chatId, projectId),
        [chatId, projectId],
    );
    const [globalModel, setGlobalModel] = useState(DEFAULT_MODEL_ID);
    const [storedModels, setStoredModels] = useState<StoredChatModels>({});
    const [dirtySelection, setDirtySelection] = useState<{
        chatKey: string | null;
        model: string;
    } | null>(null);

    useEffect(() => {
        // Read after hydration so server markup keeps the default selection.
        const timer = window.setTimeout(() => {
            setGlobalModel(readStored());
            setStoredModels(readStoredChatModels());
            setDirtySelection(null);
        }, 0);
        return () => window.clearTimeout(timer);
    }, [chatKey]);

    const streamingSession = getActiveChatSession(chatId, projectId);
    const streamingModel = streamingSession?.status === "streaming"
        ? streamingSession.model
        : null;
    const model = resolveSelectedModel({
        dirtyModel: dirtySelection?.chatKey === chatKey ? dirtySelection.model : null,
        streamingModel,
        chatModel: chatKey ? storedModels[chatKey]?.model : null,
        globalModel,
    });

    const setModel = useCallback((id: string) => {
        const next = isAllowedModel(id) ? id : DEFAULT_MODEL_ID;
        setDirtySelection({ chatKey, model: next });
        setGlobalModel(next);
        if (typeof window === "undefined") return;

        window.localStorage.setItem(STORAGE_KEY, next);
        if (!chatKey) return;
        setStoredModels((current) => {
            const updated = updateStoredChatModels(current, chatKey, next);
            window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(updated));
            return updated;
        });
    }, [chatKey]);

    return [model, setModel];
}
