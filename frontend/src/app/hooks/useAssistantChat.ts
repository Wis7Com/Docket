"use client";

import {
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import { getChat, streamChat, streamProjectChat } from "@/app/lib/docketApi";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useGenerateChatTitle } from "./useGenerateChatTitle";
import { useNotifications } from "@/app/contexts/NotificationContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    evaluateChatAdmission,
    selectAttachedSession,
    controllerForChatCancel,
    shouldRouteWriteToSession,
} from "@/app/lib/chatSession.logic";
import {
    EMPTY_SESSIONS,
    beginChatSession,
    beginWaitingChatSession,
    finishActiveChatSession,
    flushChatSession,
    getActiveChatSession,
    getChatSessionsSnapshot,
    getSessionByToken,
    queueChatMessage,
    restoreChatDraft,
    subscribeToChatSession,
    takeQueuedMessage,
    updateActiveChatSession,
} from "@/app/contexts/ChatSessionContext";
import {
    enqueueGpuJob,
    getGpuBusyJob,
    removeGpuJob,
} from "@/app/contexts/GpuQueueStore";
import { isGpuBoundModel } from "@/app/lib/modelAvailability";
import type {
    AssistantEvent,
    DocketCitationAnnotation,
    DocketMessage,
} from "@/app/components/shared/types";

interface UseAssistantChatOptions {
    initialMessages?: DocketMessage[];
    chatId?: string;
    projectId?: string;
}

function findLastContentIndex(events: AssistantEvent[]): number {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "content") return i;
    }
    return -1;
}

export function useAssistantChat({
    initialMessages = [],
    chatId: initialChatId,
    projectId,
}: UseAssistantChatOptions = {}) {
    const router = useRouter();
    const {
        replaceChatId,
        loadChats,
        setCurrentChatId,
        saveChat,
        setNewChatMessages,
    } = useChatHistoryContext();
    const { generate: generateTitle } = useGenerateChatTitle();
    const { notify } = useNotifications();
    const { profile } = useUserProfile();

    // A stream token must outlive a retained route component, while the route
    // attachment token is reset whenever its dynamic chat id changes.
    const streamTokenRef = useRef<symbol | null>(null);
    const ownerTokenRef = useRef<symbol | null>(null);
    const lastFlushedTokenRef = useRef<symbol | null>(null);
    const seenSessionTokenRef = useRef<symbol | null>(null);
    const syncedTerminalTokenRef = useRef<symbol | null>(null);
    const routeChatIdRef = useRef(initialChatId);
    if (routeChatIdRef.current !== initialChatId) {
        routeChatIdRef.current = initialChatId;
        seenSessionTokenRef.current = null;
        ownerTokenRef.current = null;
        lastFlushedTokenRef.current = null;
        syncedTerminalTokenRef.current = null;
    }
    const sessions = useSyncExternalStore(
        subscribeToChatSession,
        getChatSessionsSnapshot,
        () => EMPTY_SESSIONS,
    );
    const matchingSession = getActiveChatSession(initialChatId, projectId);
    const attachedSession = selectAttachedSession(
        sessions,
        { chatId: initialChatId, projectId },
        ownerTokenRef.current,
        seenSessionTokenRef.current,
    );
    if (attachedSession?.status === "streaming" || attachedSession?.status === "waiting") {
        seenSessionTokenRef.current = attachedSession.token;
    }
    const [localMessages, setLocalMessages] = useState<DocketMessage[]>(
        () => matchingSession?.messages ?? initialMessages,
    );
    const [localIsResponseLoading, setLocalIsResponseLoading] = useState(
        () => matchingSession?.isResponseLoading ?? false,
    );
    const [localIsLoadingCitations, setLocalIsLoadingCitations] = useState(
        () => matchingSession?.isLoadingCitations ?? false,
    );
    const [chatId, setChatId] = useState<string | undefined>(initialChatId);
    const messages = attachedSession?.messages ?? localMessages;
    const isResponseLoading =
        attachedSession?.isResponseLoading ?? localIsResponseLoading;
    const isLoadingCitations =
        attachedSession?.isLoadingCitations ?? localIsLoadingCitations;
    const queuedMessage = attachedSession?.queuedMessage ?? null;
    const restoreDraft = attachedSession?.draft ?? matchingSession?.draft ?? null;

    // Route interactions write to a live session only when this hook owns it.
    // Fresh mounts keep their hydration writes local so they cannot overwrite
    // the rendered streaming snapshot.
    const getRouteStreamingSession = () => {
        const active = getActiveChatSession(initialChatId, projectId);
        return active?.status === "streaming" ? active : null;
    };
    const setMessages = (update: SetStateAction<DocketMessage[]>) => {
        const active = getRouteStreamingSession();
        if (active && shouldRouteWriteToSession(
            active,
            { chatId: initialChatId, projectId },
            streamTokenRef.current,
        )) {
            const next = typeof update === "function"
                ? (update as (value: DocketMessage[]) => DocketMessage[])(active.messages)
                : update;
            updateActiveChatSession({ messages: next }, active.token);
            return;
        }
        setLocalMessages(update);
    };
    const setIsResponseLoading = (update: SetStateAction<boolean>) => {
        const active = getRouteStreamingSession();
        if (active && shouldRouteWriteToSession(
            active,
            { chatId: initialChatId, projectId },
            streamTokenRef.current,
        )) {
            const next = typeof update === "function"
                ? (update as (value: boolean) => boolean)(active.isResponseLoading)
                : update;
            updateActiveChatSession(
                { isResponseLoading: next },
                active.token,
            );
            return;
        }
        setLocalIsResponseLoading(update);
    };
    const setIsLoadingCitations = (update: SetStateAction<boolean>) => {
        const active = getRouteStreamingSession();
        if (active && shouldRouteWriteToSession(
            active,
            { chatId: initialChatId, projectId },
            streamTokenRef.current,
        )) {
            const next = typeof update === "function"
                ? (update as (value: boolean) => boolean)(active.isLoadingCitations)
                : update;
            updateActiveChatSession(
                { isLoadingCitations: next },
                active.token,
            );
            return;
        }
        setLocalIsLoadingCitations(update);
    };

    // Next can retain this hook instance while moving between dynamic chat
    // routes. Keep the request id aligned with the id in the current URL so a
    // completed response cannot navigate back to a stale chat and remount the
    // project assistant (which would also discard its open document tabs).
    useEffect(() => {
        setChatId(initialChatId);
    }, [initialChatId]);

    const updateLastContentEvent = (
        prev: DocketMessage[],
        text: string,
        isStreaming?: boolean,
    ): DocketMessage[] => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role !== "assistant") return prev;
        const events = last.events ?? [];
        const idx = findLastContentIndex(events);
        if (idx < 0) return prev;
        const newEvents = [...events];
        newEvents[idx] = isStreaming
            ? { type: "content", text, isStreaming: true }
            : { type: "content", text };
        updated[updated.length - 1] = { ...last, events: newEvents };
        return updated;
    };

    const cancel = () => {
        const active = getActiveChatSession(chatId, projectId);
        if (active?.status === "waiting") {
            if (active.queueJobId) removeGpuJob(active.queueJobId);
            updateActiveChatSession({
                messages: active.messages.slice(0, -2),
                draft: active.waitingMessage?.content,
                waitingMessage: undefined,
                queueJobId: undefined,
            }, active.token);
            finishActiveChatSession(active.token, "cancelled");
            return;
        }
        const controller = controllerForChatCancel(
            null,
            active,
            chatId,
            projectId,
        );
        if (controller) {
            controller.abort();
            setIsResponseLoading(false);
            setIsLoadingCitations(false);
        }
    };

    useEffect(() => {
        if (
            !attachedSession ||
            attachedSession.status !== "streaming" ||
            attachedSession.token === ownerTokenRef.current ||
            lastFlushedTokenRef.current === attachedSession.token
        ) {
            return;
        }
        lastFlushedTokenRef.current = attachedSession.token;
        // Fast-forward only a new attachment; the stream owner never listens
        // to or flushes its own writes.
        flushChatSession(attachedSession.token);
    }, [attachedSession]);

    // Preserve a completed response after the bounded terminal-session cache
    // evicts it. A terminal snapshot is attached only to a route that saw its
    // stream, so copying it once cannot shadow a freshly hydrated route.
    useEffect(() => {
        if (
            !attachedSession ||
            attachedSession.status === "streaming" ||
            syncedTerminalTokenRef.current === attachedSession.token
        ) {
            return;
        }
        syncedTerminalTokenRef.current = attachedSession.token;
        setLocalMessages(attachedSession.messages);
        setLocalIsResponseLoading(false);
        setLocalIsLoadingCitations(false);
    }, [attachedSession]);

    const handleChat = async (
        message: DocketMessage,
        opts?: {
            displayedDoc?: { filename: string; documentId: string } | null;
            selectedDocumentIds?: string[];
        },
        baseMessages?: DocketMessage[],
        existingWaitingToken?: symbol,
        targetChatIdOverride?: string,
    ): Promise<string | null> => {
        if (!message.content.trim()) return null;

        const waitingSession = existingWaitingToken
            ? getSessionByToken(existingWaitingToken)
            : null;
        const targetChatId = targetChatIdOverride ?? waitingSession?.chatId ?? chatId;

        const gpuBound = isGpuBoundModel(message.model ?? "", {
            openaiCompatibleBaseUrl: profile?.openaiCompatibleBaseUrl ?? null,
        });
        const admission = evaluateChatAdmission({
            gpuBound,
            gpuBusySession: getGpuBusyJob(),
            current: { chatId: targetChatId, projectId },
        });
        if (!waitingSession && admission.kind === "queue-local-busy") {
            const sessionMessages: DocketMessage[] = [
                ...(baseMessages ?? messages),
                message,
                {
                    role: "assistant",
                    content: "로컬 모델 대기 중 — 다른 채팅의 응답 생성이 끝나면 시작됩니다",
                    annotations: [],
                    events: [{ type: "thinking", isStreaming: true }],
                },
            ];
            const queueJobId = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const token = beginWaitingChatSession({
                chatId: targetChatId,
                projectId,
                messages: sessionMessages,
                isResponseLoading: true,
                isLoadingCitations: false,
                model: message.model,
                gpuBound: true,
                waitingMessage: message,
                queueJobId,
            });
            streamTokenRef.current = token;
            ownerTokenRef.current = token;
            enqueueGpuJob({
                id: queueJobId,
                kind: "chat",
                label: message.content.slice(0, 80),
                chatId: targetChatId,
                projectId,
                start: () => {
                    updateActiveChatSession({
                        status: "streaming",
                        queueJobId: undefined,
                        waitingMessage: undefined,
                    }, token);
                    void handleChat(message, opts, undefined, token);
                },
            });
            return null;
        }
        // A same-chat retry supersedes the existing request instead of leaving
        // two writers racing for the same persisted conversation.
        if (targetChatId != null && !waitingSession) {
            getActiveChatSession(targetChatId, projectId)?.controller?.abort();
        }

        const sourceMessages = waitingSession
            ? waitingSession.messages.slice(0, -1)
            : baseMessages ?? messages;
        const lastMessage = sourceMessages[sourceMessages.length - 1];
        const isMessageAlreadyAdded =
            lastMessage &&
            lastMessage.role === "user" &&
            lastMessage.content === message.content;

        const newMessages: DocketMessage[] = isMessageAlreadyAdded
            ? sourceMessages
            : [...sourceMessages, message];

        const sessionMessages: DocketMessage[] = [
            ...newMessages,
            { role: "assistant", content: "", annotations: [], events: [] },
        ];
        let streamedChatId: string | null = null;

        const stream = {
            token: null as symbol | null,
            controller: new AbortController(),
            events: [] as AssistantEvent[],
            dripTarget: "",
            dripDisplayLen: 0,
            dripInterval: null as ReturnType<typeof setInterval> | null,
        };
        let streamToken: symbol | null = null;
        const updateStreamMessages = (update: SetStateAction<DocketMessage[]>) => {
            const active = getSessionByToken(stream.token);
            if (!active || active.status !== "streaming") return;
            const next = typeof update === "function"
                ? (update as (value: DocketMessage[]) => DocketMessage[])(active.messages)
                : update;
            updateActiveChatSession({ messages: next }, stream.token);
        };
        const updateStreamLoading = (update: SetStateAction<boolean>) => {
            const active = getSessionByToken(stream.token);
            if (!active || active.status !== "streaming") return;
            const next = typeof update === "function"
                ? (update as (value: boolean) => boolean)(active.isResponseLoading)
                : update;
            updateActiveChatSession({ isResponseLoading: next }, stream.token);
        };
        const updateStreamCitationsLoading = (update: SetStateAction<boolean>) => {
            const active = getSessionByToken(stream.token);
            if (!active || active.status !== "streaming") return;
            const next = typeof update === "function"
                ? (update as (value: boolean) => boolean)(active.isLoadingCitations)
                : update;
            updateActiveChatSession({ isLoadingCitations: next }, stream.token);
        };
        const setMessages = updateStreamMessages;
        const setIsResponseLoading = updateStreamLoading;
        const setIsLoadingCitations = updateStreamCitationsLoading;
        const stopDrip = () => {
            if (stream.dripInterval !== null) {
                clearInterval(stream.dripInterval);
                stream.dripInterval = null;
            }
        };
        const flushDrip = () => {
            stopDrip();
            stream.dripDisplayLen = stream.dripTarget.length;
            setMessages((prev) => updateLastContentEvent(prev, stream.dripTarget));
        };
        const writeEvents = (events: AssistantEvent[]) => {
            stream.events = events;
            const snapshot = [...events];
            setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                    updated[updated.length - 1] = { ...last, events: snapshot };
                }
                return updated;
            });
        };
        const finalizeStreamingContent = () => {
            stopDrip();
            const last = stream.events[stream.events.length - 1];
            if (last?.type === "content" && last.isStreaming) {
                writeEvents([
                    ...stream.events.slice(0, -1),
                    { type: "content", text: stream.dripTarget },
                ]);
            }
            stream.dripTarget = "";
            stream.dripDisplayLen = 0;
        };
        const finalizeStreamingReasoning = () => {
            const last = stream.events[stream.events.length - 1];
            if (last?.type !== "reasoning" || !last.isStreaming) return;
            writeEvents([
                ...stream.events.slice(0, -1),
                { type: "reasoning", text: last.text },
            ]);
        };
        const startDrip = () => {
            if (stream.dripInterval !== null) return;
            stream.dripInterval = setInterval(() => {
                if (stream.dripDisplayLen >= stream.dripTarget.length) return;
                stream.dripDisplayLen = Math.min(
                    stream.dripDisplayLen + 8,
                    stream.dripTarget.length,
                );
                const text = stream.dripTarget.slice(0, stream.dripDisplayLen);
                const lastIndex = stream.events.length - 1;
                const last = stream.events[lastIndex];
                if (last?.type === "content" && last.isStreaming) {
                    const events = [...stream.events];
                    events[lastIndex] = { type: "content", text, isStreaming: true };
                    stream.events = events;
                }
                setMessages((prev) => updateLastContentEvent(prev, text, true));
            }, 16);
        };
        const isStreamingPlaceholder = (event: AssistantEvent) =>
            (event.type === "tool_call_start" || event.type === "thinking") &&
            !!event.isStreaming;
        const clearStreamingPlaceholders = () => {
            const events = stream.events.filter((event) => !isStreamingPlaceholder(event));
            if (events.length !== stream.events.length) writeEvents(events);
        };
        const pushThinkingPlaceholder = () => {
            const last = stream.events[stream.events.length - 1];
            if (!last || !isStreamingPlaceholder(last)) {
                writeEvents([
                    ...stream.events,
                    { type: "thinking" as const, isStreaming: true },
                ]);
            }
        };
        const pushEvent = (event: AssistantEvent) => {
            finalizeStreamingContent();
            finalizeStreamingReasoning();
            const events = event.type === "tool_call_start" || event.type === "thinking"
                ? stream.events
                : stream.events.filter((current) => !isStreamingPlaceholder(current));
            writeEvents([...events, event]);
        };
        const updateMatchingEvent = (
            predicate: (event: AssistantEvent) => boolean,
            updater: (event: AssistantEvent) => AssistantEvent,
        ) => {
            const index = [...stream.events]
                .map((_, i) => i)
                .reverse()
                .find((i) => predicate(stream.events[i]));
            if (index === undefined) return;
            const events = [...stream.events];
            events[index] = updater(events[index]);
            writeEvents(events);
        };

        try {
            streamToken = waitingSession?.token ?? beginChatSession({
                chatId: targetChatId,
                projectId,
                messages: sessionMessages,
                isResponseLoading: true,
                isLoadingCitations: false,
                model: message.model,
                gpuBound,
                controller: stream.controller,
                flush: flushDrip,
            });
            if (waitingSession) {
                updateActiveChatSession({
                    isResponseLoading: true,
                    isLoadingCitations: false,
                    controller: stream.controller,
                    flush: flushDrip,
                    messages: sessionMessages,
                }, streamToken);
            }
            stream.token = streamToken;
            streamTokenRef.current = streamToken;
            ownerTokenRef.current = streamToken;

            const apiMessages = newMessages.map((currentMessage) => ({
                role: currentMessage.role,
                content: currentMessage.content,
                files: currentMessage.files,
                workflow: currentMessage.workflow,
            }));

            const model = message.model;

            const displayedDoc = opts?.displayedDoc ?? null;

            // Pull the user's attachments from the just-submitted message.
            // These are the files dragged into / picked from the chat input
            // for this turn (separate from the running history of past
            // attachments). Sent as a request-level field so the backend
            // can call them out specifically in the system prompt.
            const attachedDocs = (
                message.files?.filter((f) => !!f.document_id) ?? []
            ).map((f) => ({
                filename: f.filename,
                document_id: f.document_id as string,
            }));

            const response = await (projectId
                ? streamProjectChat({
                      projectId,
                      messages: apiMessages,
                      chat_id: targetChatId,
                      model,
                      displayed_doc: displayedDoc
                          ? {
                                filename: displayedDoc.filename,
                                document_id: displayedDoc.documentId,
                            }
                          : undefined,
                      attached_documents:
                          attachedDocs.length > 0 ? attachedDocs : undefined,
                      selected_document_ids: opts?.selectedDocumentIds,
                      disabled_tools: message.disabled_tools,
                      signal: stream.controller.signal,
                  })
                : streamChat({
                      messages: apiMessages,
                      chat_id: targetChatId,
                      model,
                      disabled_tools: message.disabled_tools,
                      signal: stream.controller.signal,
                  }));

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errText}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";
            let sawDone = false;
            let streamError: Error | null = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data:")) continue;

                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === "[DONE]") {
                        sawDone = true;
                        continue;
                    }

                    try {
                        const data = JSON.parse(dataStr);

                        if (data.type === "error") {
                            streamError = new Error(
                                typeof data.message === "string" && data.message
                                    ? data.message
                                    : "The assistant stream ended unexpectedly. Please retry the request.",
                            );
                            break;
                        }

                        if (data.type === "chat_id") {
                            streamedChatId = data.chatId;
                            updateActiveChatSession(
                                { chatId: data.chatId },
                                streamToken,
                            );
                            if (streamTokenRef.current === streamToken) {
                                setChatId(data.chatId);
                                setCurrentChatId(data.chatId);
                            }
                            continue;
                        }

                        if (data.type === "content_done") {
                            setIsLoadingCitations(true);
                            continue;
                        }

                        if (data.type === "content_delta") {
                            const text = data.text as string;

                            // Real content is streaming — retire any
                            // "Thinking…" / "Running…" placeholders, and
                            // finalize any in-flight reasoning block so it
                            // doesn't get stuck rendering as streaming.
                            clearStreamingPlaceholders();
                            finalizeStreamingReasoning();

                            // Ensure a streaming content event exists. If
                            // the last event isn't already a streaming
                            // content block, start a fresh one — and reset
                            // the drip so we don't inherit a previous
                            // block's accumulated text.
                            const events = stream.events;
                            const lastEvent = events[events.length - 1];
                            if (
                                lastEvent?.type !== "content" ||
                                !lastEvent.isStreaming
                            ) {
                                stream.dripTarget = text;
                                stream.dripDisplayLen = 0;
                                stream.events = [
                                    ...events,
                                    {
                                        type: "content" as const,
                                        text: "",
                                        isStreaming: true,
                                    },
                                ];
                                const snapshot = [...stream.events];
                                setMessages((prev) => {
                                    const updated = [...prev];
                                    const last = updated[updated.length - 1];
                                    if (last?.role === "assistant") {
                                        updated[updated.length - 1] = {
                                            ...last,
                                            events: snapshot,
                                        };
                                    }
                                    return updated;
                                });
                            } else {
                                stream.dripTarget += text;
                            }

                            startDrip();
                            continue;
                        }

                        if (data.type === "content_replace") {
                            const text = (data.text as string) ?? "";
                            stopDrip();
                            stream.dripTarget = "";
                            stream.dripDisplayLen = 0;
                            clearStreamingPlaceholders();
                            finalizeStreamingReasoning();
                            stream.events = [
                                ...stream.events.filter(
                                    (event) => event.type !== "content",
                                ),
                                { type: "content" as const, text },
                            ].filter(
                                (event) =>
                                    event.type !== "content" ||
                                    event.text.length > 0,
                            );
                            const snapshot = [...stream.events];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }

                        if (data.type === "reasoning_delta") {
                            const text = data.text as string;
                            let events = stream.events;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                stream.events = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text + text,
                                        isStreaming: true,
                                    },
                                ];
                            } else {
                                // New reasoning block — finalize any in-flight
                                // content event first so the next content_delta
                                // starts a fresh block at the correct position.
                                finalizeStreamingContent();
                                clearStreamingPlaceholders();
                                events = stream.events;
                                stream.events = [
                                    ...events,
                                    {
                                        type: "reasoning" as const,
                                        text,
                                        isStreaming: true,
                                    },
                                ];
                            }
                            const snapshot = [...stream.events];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }

                        if (data.type === "reasoning_block_end") {
                            const events = stream.events;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                stream.events = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text,
                                    },
                                ];
                            }
                            const snapshot = [...stream.events];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "tool_call_start") {
                            // Transient placeholder so the client immediately
                            // shows activity after Claude ends a turn with
                            // tool_use. Replaced by the real tool event
                            // (doc_edited_start, doc_read_start, …) if one
                            // arrives; otherwise it lingers as a "Working…"
                            // indicator until the next iteration streams.
                            pushEvent({
                                type: "tool_call_start",
                                name: (data.name as string) ?? "",
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "workflow_applied") {
                            pushEvent({
                                type: "workflow_applied",
                                workflow_id: data.workflow_id as string,
                                title: data.title as string,
                            });
                            continue;
                        }

                        if (data.type === "doc_summary_start") {
                            pushEvent({
                                type: "doc_summary",
                                filename: data.filename as string,
                                completed_batches: 0,
                                total_batches: 0,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_summary_progress") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_summary" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => ({
                                    ...e,
                                    completed_batches:
                                        (data.completed_batches as number) ?? 0,
                                    total_batches:
                                        (data.total_batches as number) ?? 0,
                                }),
                            );
                            continue;
                        }

                        if (data.type === "doc_summary") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_summary" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => {
                                    if (e.type !== "doc_summary") return e;
                                    return {
                                        ...e,
                                        document_id:
                                            typeof data.document_id === "string"
                                                ? data.document_id
                                                : e.document_id,
                                        coverage: data.coverage,
                                        completed_batches:
                                            typeof data.coverage?.batchCount ===
                                            "number"
                                                ? data.coverage.batchCount
                                                : e.completed_batches,
                                        total_batches:
                                            typeof data.coverage?.batchCount ===
                                            "number"
                                                ? data.coverage.batchCount
                                                : e.total_batches,
                                        isStreaming: false,
                                    };
                                },
                            );
                            continue;
                        }

                        if (data.type === "doc_read_start") {
                            pushEvent({
                                type: "doc_read",
                                filename: data.filename as string,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_read") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_read" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => ({ ...e, isStreaming: false }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_find_start") {
                            pushEvent({
                                type: "doc_find",
                                filename: data.filename as string,
                                query: (data.query as string) ?? "",
                                total_matches: 0,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_find") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_find" &&
                                    e.filename === data.filename &&
                                    e.query === (data.query as string) &&
                                    !!e.isStreaming,
                                (e) => ({
                                    ...e,
                                    isStreaming: false,
                                    total_matches:
                                        typeof data.total_matches === "number"
                                            ? (data.total_matches as number)
                                            : (
                                                  e as {
                                                      type: "doc_find";
                                                      total_matches: number;
                                                  }
                                              ).total_matches,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_created_start") {
                            pushEvent({
                                type: "doc_created",
                                filename: data.filename as string,
                                download_url: "",
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_download") {
                            pushEvent({
                                type: "doc_download",
                                filename: data.filename as string,
                                download_url: data.download_url as string,
                            });
                            continue;
                        }

                        if (data.type === "doc_created") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_created" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => {
                                    const next: Extract<
                                        AssistantEvent,
                                        { type: "doc_created" }
                                    > = {
                                        type: "doc_created",
                                        filename: (e as { filename: string })
                                            .filename,
                                        download_url:
                                            data.download_url as string,
                                        isStreaming: false,
                                    };
                                    if (typeof data.document_id === "string") {
                                        next.document_id =
                                            data.document_id as string;
                                    }
                                    if (typeof data.version_id === "string") {
                                        next.version_id =
                                            data.version_id as string;
                                    }
                                    if (
                                        typeof data.version_number === "number"
                                    ) {
                                        next.version_number =
                                            data.version_number as number;
                                    }
                                    return next;
                                },
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_replicate_start") {
                            pushEvent({
                                type: "doc_replicated",
                                filename: data.filename as string,
                                count:
                                    typeof data.count === "number"
                                        ? (data.count as number)
                                        : 1,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_replicated") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_replicated" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "doc_replicated",
                                    filename: data.filename as string,
                                    count:
                                        typeof data.count === "number"
                                            ? (data.count as number)
                                            : Array.isArray(data.copies)
                                              ? (data.copies as unknown[])
                                                    .length
                                              : 1,
                                    copies: Array.isArray(data.copies)
                                        ? (data.copies as {
                                              new_filename: string;
                                              document_id: string;
                                              version_id: string;
                                          }[])
                                        : undefined,
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_edited_start") {
                            pushEvent({
                                type: "doc_edited",
                                filename: data.filename as string,
                                document_id: "",
                                version_id: "",
                                download_url: "",
                                annotations: [],
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_edited") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_edited" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "doc_edited",
                                    filename: data.filename as string,
                                    document_id:
                                        (data.document_id as string) ?? "",
                                    version_id:
                                        (data.version_id as string) ?? "",
                                    version_number:
                                        typeof data.version_number === "number"
                                            ? (data.version_number as number)
                                            : null,
                                    download_url:
                                        (data.download_url as string) ?? "",
                                    annotations: Array.isArray(data.annotations)
                                        ? (data.annotations as import("@/app/components/shared/types").DocketEditAnnotation[])
                                        : [],
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "citation_summary") {
                            const verifiedCount =
                                typeof data.verified_count === "number" &&
                                Number.isFinite(data.verified_count)
                                    ? Math.max(
                                          0,
                                          Math.floor(data.verified_count),
                                      )
                                    : 0;
                            pushEvent({
                                type: "citation_summary",
                                verified_count: verifiedCount,
                                used_document_tools:
                                    data.used_document_tools === true,
                            });
                            continue;
                        }

                        if (data.type === "citations") {
                            // End-of-stream signal — scrub any lingering
                            // placeholders so they don't persist into the
                            // finalised message.
                            clearStreamingPlaceholders();
                            const incoming = (data.citations ??
                                []) as DocketCitationAnnotation[];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        annotations: incoming,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }
                    } catch (e) {
                        console.warn(
                            "[useAssistantChat] failed to parse SSE line:",
                            trimmed,
                            e,
                        );
                    }
                }
                if (streamError) break;
            }

            if (streamError) throw streamError;
            if (!sawDone) {
                throw new Error(
                    "The local backend connection closed before the response finished. It may have restarted; please retry the request.",
                );
            }

            flushDrip();
            finalizeStreamingReasoning();
            setIsResponseLoading(false);
            setIsLoadingCitations(false);

            const finalChatId = streamedChatId || chatId || null;
            let completedChatTitle: string | null = null;
            if (finalChatId) {
                try {
                    const detail = await getChat(finalChatId);
                    completedChatTitle = detail.chat.title;
                    setMessages(detail.messages);
                } catch (err) {
                    console.warn(
                        "[useAssistantChat] failed to hydrate completed chat:",
                        err,
                    );
                }
            }
            const chatBasePath = projectId
                ? `/projects/${projectId}/assistant/chat`
                : `/assistant/chat`;
            const finalChatHref = finalChatId
                ? `${chatBasePath}/${finalChatId}`
                : undefined;
            const wasViewingFinishingChat =
                typeof window !== "undefined" &&
                (window.location.pathname === finalChatHref ||
                    window.location.pathname === chatBasePath ||
                    window.location.pathname === `${chatBasePath}/${initialChatId}`);
            if (finalChatId && finalChatId !== initialChatId) {
                if (initialChatId) {
                    replaceChatId(
                        initialChatId,
                        finalChatId,
                        message.content.trim().slice(0, 120) || "New Chat",
                    );
                }
                if (streamTokenRef.current === streamToken) {
                    setCurrentChatId(finalChatId);
                }
                // Never yank a user back from a page they intentionally
                // visited while the answer was streaming. This also retains
                // the dynamic-route stale-id guard for project chat tabs.
                if (
                    wasViewingFinishingChat
                ) {
                    router.replace(`${chatBasePath}/${finalChatId}`);
                }
            }

            await loadChats();

            const finalChatIdForTitle = streamedChatId || chatId || null;
            if (finalChatIdForTitle && newMessages.length === 1) {
                const titleParts = [message.content];
                if (message.workflow)
                    titleParts.push(`Workflow: ${message.workflow.title}`);
                if (message.files?.length)
                    titleParts.push(
                        `Files: ${message.files.map((f) => f.filename).join(", ")}`,
                    );
                void generateTitle(finalChatIdForTitle, titleParts.join("\n"));
            }

            finishActiveChatSession(streamToken, "completed");
            const queuedAfterCompletion = takeQueuedMessage(streamToken);
            if (queuedAfterCompletion) {
                const terminal = getSessionByToken(streamToken);
                void handleChat(
                    queuedAfterCompletion.message,
                    queuedAfterCompletion.opts,
                    terminal?.messages,
                    undefined,
                    terminal?.chatId,
                );
            }
            if (
                finalChatHref &&
                !wasViewingFinishingChat
            ) {
                notify({
                    title: completedChatTitle || "Answer ready",
                    body: "Your answer is ready to review.",
                    href: finalChatHref,
                    kind: "chat-complete",
                });
            }

            return streamedChatId || null;
        } catch (error: unknown) {
            if (error instanceof Error && error.name === "AbortError") {
                flushDrip();
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant") {
                        const updated = [...prev];
                        const events = last.events ?? [];
                        const idx = findLastContentIndex(events);
                        const cancelText = "Cancelled by user";
                        if (idx >= 0) {
                            const newEvents = [...events];
                            const existing = newEvents[idx] as {
                                type: "content";
                                text: string;
                            };
                            newEvents[idx] = {
                                type: "content",
                                text: existing.text
                                    ? `${existing.text}\n\nCancelled by user`
                                    : cancelText,
                            };
                            updated[updated.length - 1] = {
                                ...last,
                                events: newEvents,
                            };
                        } else {
                            updated[updated.length - 1] = {
                                ...last,
                                events: [
                                    ...events,
                                    { type: "content", text: cancelText },
                                ],
                            };
                        }
                        return updated;
                    }
                    return [
                        ...prev,
                        {
                            role: "assistant",
                            content: "",
                            events: [
                                { type: "content", text: "Cancelled by user" },
                            ],
                        },
                    ];
                });
            } else {
                stopDrip();
                const rawErrorMessage =
                    error instanceof Error && error.message
                        ? error.message
                        : "";
                const errorMessage =
                    /failed to fetch|networkerror|terminated|connection (?:was )?closed/i.test(
                        rawErrorMessage,
                    )
                        ? "The local backend connection closed before the response finished. It may have restarted; please retry the request."
                        : rawErrorMessage || "Sorry, something went wrong.";
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant") {
                        const updated = [...prev];
                        updated[updated.length - 1] = {
                            ...last,
                            error: errorMessage,
                        };
                        return updated;
                    }
                    return [
                        ...prev,
                        {
                            role: "assistant",
                            content: "",
                            error: errorMessage,
                        },
                    ];
                });
            }

            setIsResponseLoading(false);
            setIsLoadingCitations(false);
            if (!(error instanceof Error && error.name === "AbortError")) {
                const failedChatId = streamedChatId || chatId;
                const failedHref = failedChatId
                    ? projectId
                        ? `/projects/${projectId}/assistant/chat/${failedChatId}`
                        : `/assistant/chat/${failedChatId}`
                    : undefined;
                if (
                    failedHref &&
                    typeof window !== "undefined" &&
                    window.location.pathname !== failedHref
                ) {
                    notify({
                        title: "Answer failed",
                        body: error instanceof Error ? error.message : "Sorry, something went wrong.",
                        href: failedHref,
                        kind: "chat-error",
                    });
                }
            }
            const terminalStatus = error instanceof Error && error.name === "AbortError"
                ? "cancelled"
                : "failed";
            finishActiveChatSession(streamToken, terminalStatus);
            const queuedAfterTerminal = takeQueuedMessage(streamToken);
            if (queuedAfterTerminal) {
                if (terminalStatus === "failed") {
                    restoreChatDraft(streamToken, queuedAfterTerminal.message.content);
                    const failedSession = getSessionByToken(streamToken);
                    const failedChatId = failedSession?.chatId ?? chatId;
                    const failedHref = failedChatId
                        ? projectId
                            ? `/projects/${projectId}/assistant/chat/${failedChatId}`
                            : `/assistant/chat/${failedChatId}`
                        : undefined;
                    notify({
                        title: "Queued message was not sent",
                        body: "대기 중이던 메시지가 전송되지 않았습니다",
                        href: failedHref,
                        kind: "chat-error",
                        actionLabel: failedHref ? "Go to chat" : undefined,
                    });
                } else {
                    const terminal = getSessionByToken(streamToken);
                    void handleChat(
                        queuedAfterTerminal.message,
                        queuedAfterTerminal.opts,
                        terminal?.messages,
                        undefined,
                        terminal?.chatId,
                    );
                }
            }
            return null;
        } finally {
            stopDrip();
        }
    };

    const handleNewChat = async (
        message: DocketMessage,
        projectId?: string,
    ): Promise<string | null> => {
        if (!message.content.trim()) return null;

        setMessages([message]);
        setNewChatMessages([message]);

        const newChatId = await saveChat(projectId);
        if (newChatId) {
            setChatId(newChatId);
            setCurrentChatId(newChatId);
        }

        return newChatId;
    };

    return {
        messages,
        isResponseLoading,
        setIsResponseLoading,
        isLoadingCitations,
        handleChat,
        handleNewChat,
        setMessages,
        cancel,
        chatId,
        queuedMessage,
        restoreDraft,
        clearRestoreDraft: () => {
            const active = getActiveChatSession(chatId, projectId);
            if (active?.draft) updateActiveChatSession({ draft: undefined }, active.token);
        },
        queueMessage: (message: DocketMessage, opts?: {
            displayedDoc?: { filename: string; documentId: string } | null;
            selectedDocumentIds?: string[];
        }) => {
            const active = getActiveChatSession(chatId, projectId);
            return queueChatMessage(active?.token ?? null, { message, opts });
        },
        cancelQueuedMessage: () => {
            const active = getActiveChatSession(chatId, projectId);
            const queued = takeQueuedMessage(active?.token ?? null);
            if (queued) restoreChatDraft(active?.token ?? null, queued.message.content);
        },
    };
}
