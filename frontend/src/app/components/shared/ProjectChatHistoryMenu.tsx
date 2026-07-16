"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
    Check,
    ChevronDown,
    Loader2,
    MessageSquarePlus,
    Pencil,
    Trash2,
    X,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DocketChat } from "@/app/components/shared/types";
import {
    EMPTY_SESSIONS,
    getChatSessionsSnapshot,
    subscribeToChatSession,
} from "@/app/contexts/ChatSessionContext";
import { chatSessionKey, streamingChatKeys } from "@/app/lib/chatSession.logic";

interface ProjectChatHistoryMenuProps {
    chats: DocketChat[];
    currentChatId: string;
    projectId: string;
    currentTitle: string;
    currentUserId?: string;
    creatingChat: boolean;
    onNewChat: () => Promise<void>;
    onOpenChat: (chatId: string) => void;
    onRenameChat: (chatId: string, title: string) => Promise<void>;
    onDeleteChats: (chatIds: string[]) => Promise<void>;
}

export function ProjectChatHistoryMenu({
    chats,
    currentChatId,
    projectId,
    currentTitle,
    currentUserId,
    creatingChat,
    onNewChat,
    onOpenChat,
    onRenameChat,
    onDeleteChats,
}: ProjectChatHistoryMenuProps) {
    const sessions = useSyncExternalStore(
        subscribeToChatSession,
        getChatSessionsSnapshot,
        () => EMPTY_SESSIONS,
    );
    const activeChatKeys = streamingChatKeys(sessions);
    const [open, setOpen] = useState(false);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editTitle, setEditTitle] = useState("");
    const [busyChatIds, setBusyChatIds] = useState<Set<string>>(() => new Set());
    const renameInputRef = useRef<HTMLInputElement>(null);

    const ownedChats = chats.filter(
        (chat) => !!currentUserId && chat.user_id === currentUserId,
    );
    const allOwnedSelected =
        ownedChats.length > 0 && ownedChats.every((chat) => selectedIds.has(chat.id));

    useEffect(() => {
        if (editingId) renameInputRef.current?.focus();
    }, [editingId]);

    useEffect(() => {
        const visibleIds = new Set(chats.map((chat) => chat.id));
        setSelectedIds((previous) => {
            const next = new Set([...previous].filter((id) => visibleIds.has(id)));
            return next.size === previous.size ? previous : next;
        });
    }, [chats]);

    const leaveSelectionMode = () => {
        setSelectionMode(false);
        setSelectedIds(new Set());
    };

    const markBusy = (chatIds: string[], busy: boolean) => {
        setBusyChatIds((previous) => {
            const next = new Set(previous);
            for (const id of chatIds) {
                if (busy) next.add(id);
                else next.delete(id);
            }
            return next;
        });
    };

    const saveRename = async (chatId: string) => {
        const title = editTitle.trim();
        if (!title) return;
        markBusy([chatId], true);
        try {
            await onRenameChat(chatId, title);
            setEditingId(null);
        } finally {
            markBusy([chatId], false);
        }
    };

    const deleteChats = async (chatIds: string[]) => {
        if (
            chatIds.length === 0 ||
            !window.confirm(
                `Delete ${chatIds.length === 1 ? "this chat" : `${chatIds.length} selected chats`}? This cannot be undone.`,
            )
        ) {
            return;
        }
        markBusy(chatIds, true);
        try {
            await onDeleteChats(chatIds);
            setSelectedIds((previous) => {
                const next = new Set(previous);
                chatIds.forEach((id) => next.delete(id));
                return next;
            });
            if (chatIds.length > 1) leaveSelectionMode();
        } finally {
            markBusy(chatIds, false);
        }
    };

    return (
        <DropdownMenu
            open={open}
            onOpenChange={(nextOpen) => {
                setOpen(nextOpen);
                if (!nextOpen) {
                    setEditingId(null);
                    leaveSelectionMode();
                }
            }}
        >
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    data-session-check="project-chat-history-picker"
                    aria-label="Choose or manage a project chat"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1 text-left text-xs text-gray-700 outline-none transition-colors hover:border-gray-300 focus-visible:border-gray-400 focus-visible:ring-2 focus-visible:ring-gray-200"
                >
                    <span className="min-w-0 flex-1 truncate">{currentTitle}</span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                side="bottom"
                align="end"
                sideOffset={6}
                avoidCollisions={false}
                onCloseAutoFocus={(event) => event.preventDefault()}
                className="z-[120] w-[var(--radix-dropdown-menu-trigger-width)] min-w-72 overflow-hidden rounded-lg border border-gray-200 bg-white p-0 shadow-xl"
            >
                <div className="border-b border-gray-100 p-2">
                    <button
                        type="button"
                        disabled={creatingChat}
                        onClick={() => void onNewChat()}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {creatingChat ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <MessageSquarePlus className="h-4 w-4" />
                        )}
                        New Chat
                    </button>
                </div>

                <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 text-[11px] text-gray-500">
                    <span className="font-medium uppercase tracking-wide">Chat history</span>
                    {ownedChats.length > 0 && (
                        <button
                            type="button"
                            onClick={() => {
                                if (selectionMode) leaveSelectionMode();
                                else setSelectionMode(true);
                            }}
                            className="ml-auto font-medium text-gray-600 hover:text-gray-900"
                        >
                            {selectionMode ? "Cancel" : "Select"}
                        </button>
                    )}
                </div>

                {selectionMode && (
                    <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2 text-[11px]">
                        <button
                            type="button"
                            onClick={() =>
                                setSelectedIds(
                                    allOwnedSelected
                                        ? new Set()
                                        : new Set(ownedChats.map((chat) => chat.id)),
                                )
                            }
                            className="text-gray-600 hover:text-gray-900"
                        >
                            {allOwnedSelected ? "Clear all" : "Select all"}
                        </button>
                        <span className="ml-auto text-gray-400">
                            {selectedIds.size} selected
                        </span>
                        <button
                            type="button"
                            aria-label="Delete selected chats"
                            title="Delete selected chats"
                            disabled={selectedIds.size === 0}
                            onClick={() => void deleteChats([...selectedIds])}
                            className="rounded p-1 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}

                <div className="max-h-72 overflow-y-auto p-1.5">
                    {chats.length === 0 ? (
                        <p className="px-2.5 py-3 text-xs text-gray-400">No chats yet</p>
                    ) : (
                        chats.map((chat) => {
                            const title = chat.title ?? "Untitled chat";
                            const isOwner = !!currentUserId && chat.user_id === currentUserId;
                            const isBusy = busyChatIds.has(chat.id);
                            const isCurrent = chat.id === currentChatId;
                            const isStreaming = activeChatKeys.has(
                                chatSessionKey(chat.id, projectId),
                            );

                            return (
                                <div
                                    key={chat.id}
                                    className={`group flex min-h-9 items-center gap-1 rounded-md px-1.5 ${
                                        isCurrent ? "bg-gray-100" : "hover:bg-gray-50"
                                    }`}
                                >
                                    {selectionMode && (
                                        <input
                                            type="checkbox"
                                            checked={selectedIds.has(chat.id)}
                                            disabled={!isOwner || isBusy}
                                            onChange={() =>
                                                setSelectedIds((previous) => {
                                                    const next = new Set(previous);
                                                    if (next.has(chat.id)) next.delete(chat.id);
                                                    else next.add(chat.id);
                                                    return next;
                                                })
                                            }
                                            aria-label={`Select ${title}`}
                                            className="ml-1 h-3.5 w-3.5 shrink-0 accent-gray-900 disabled:opacity-30"
                                        />
                                    )}

                                    {editingId === chat.id ? (
                                        <div className="flex min-w-0 flex-1 items-center gap-1 py-1">
                                            <input
                                                ref={renameInputRef}
                                                value={editTitle}
                                                disabled={isBusy}
                                                onChange={(event) => setEditTitle(event.target.value)}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter") void saveRename(chat.id);
                                                    if (event.key === "Escape") setEditingId(null);
                                                }}
                                                aria-label="Chat title"
                                                className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs outline-none focus:border-gray-500"
                                            />
                                            <button
                                                type="button"
                                                aria-label="Save chat title"
                                                onClick={() => void saveRename(chat.id)}
                                                className="rounded p-1 text-emerald-600 hover:bg-emerald-50"
                                            >
                                                {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                            </button>
                                            <button
                                                type="button"
                                                aria-label="Cancel rename"
                                                onClick={() => setEditingId(null)}
                                                className="rounded p-1 text-gray-500 hover:bg-gray-100"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <button
                                                type="button"
                                                disabled={selectionMode && !isOwner}
                                                onClick={() => {
                                                    if (selectionMode) {
                                                        setSelectedIds((previous) => {
                                                            const next = new Set(previous);
                                                            if (next.has(chat.id)) next.delete(chat.id);
                                                            else next.add(chat.id);
                                                            return next;
                                                        });
                                                    } else if (!isCurrent) {
                                                        onOpenChat(chat.id);
                                                        setOpen(false);
                                                    }
                                                }}
                                                title={title}
                                                className={`min-w-0 flex-1 truncate px-1.5 py-2 text-left text-xs ${
                                                    isCurrent ? "font-medium text-gray-900" : "text-gray-700"
                                                } ${selectionMode && !isOwner ? "cursor-not-allowed opacity-50" : ""}`}
                                            >
                                                {title}
                                            </button>
                                            {isStreaming && (
                                                <span
                                                    role="status"
                                                    aria-label="Answer in progress"
                                                    title="Answer in progress"
                                                    className="shrink-0 text-gray-400"
                                                >
                                                    <Loader2
                                                        aria-hidden="true"
                                                        className="h-3.5 w-3.5 animate-spin"
                                                    />
                                                </span>
                                            )}
                                            {!selectionMode && isOwner && (
                                                <div className="flex shrink-0 items-center opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                                    <button
                                                        type="button"
                                                        aria-label={`Rename ${title}`}
                                                        title="Rename chat"
                                                        disabled={isBusy}
                                                        onClick={() => {
                                                            setEditTitle(chat.title ?? "");
                                                            setEditingId(chat.id);
                                                        }}
                                                        className="rounded p-1.5 text-gray-500 hover:bg-white hover:text-gray-900 disabled:opacity-40"
                                                    >
                                                        <Pencil className="h-3.5 w-3.5" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        aria-label={`Delete ${title}`}
                                                        title="Delete chat"
                                                        disabled={isBusy}
                                                        onClick={() => void deleteChats([chat.id])}
                                                        className="rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                                                    >
                                                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
