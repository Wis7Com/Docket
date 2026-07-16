"use client";

import { useState, useEffect, useSyncExternalStore } from "react";
import {
  PanelLeft,
  MessageSquare,
  FolderOpen,
  Library,
  Settings,
  ChevronDown,
  Trash2,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { DocketIcon } from "@/components/chat/docket-icon";
import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
import { listProjects } from "@/app/lib/docketApi";
import {
  EMPTY_SESSIONS,
  getChatSessionsSnapshot,
  subscribeToChatSession,
} from "@/app/contexts/ChatSessionContext";
import { chatSessionKey, streamingChatKeys } from "@/app/lib/chatSession.logic";

const NAV_ITEMS = [
  { href: "/assistant", label: "Assistant", icon: MessageSquare },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/workflows", label: "Workflows", icon: Library },
  { href: "/account", label: "Settings", icon: Settings },
];

interface AppSidebarProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function AppSidebar({ isOpen, onToggle }: AppSidebarProps) {
  const { user } = useAuth();
  const { chats, currentChatId, setCurrentChatId, deleteChat } =
    useChatHistoryContext();
  const router = useRouter();
  const pathname = usePathname();
  const [shouldAnimate, setShouldAnimate] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [historySelectionMode, setHistorySelectionMode] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingSelectedChats, setDeletingSelectedChats] = useState(false);
  const sessions = useSyncExternalStore(
    subscribeToChatSession,
    getChatSessionsSnapshot,
    () => EMPTY_SESSIONS,
  );
  const activeChatKeys = streamingChatKeys(sessions);

  const selectableChats = (chats ?? []).filter(
    (chat) => !!user?.id && chat.user_id === user.id,
  );
  const allSelectableChatsSelected =
    selectableChats.length > 0 &&
    selectableChats.every((chat) => selectedChatIds.has(chat.id));

  useEffect(() => {
    if (!user) return;
    listProjects()
      .then((projects) => {
        const map: Record<string, string> = {};
        for (const p of projects) map[p.id] = p.name;
        setProjectNames(map);
      })
      .catch(() => {});
  }, [user]);

  useEffect(() => {
    if (!isOpen) setShouldAnimate(true);
  }, [isOpen]);

  useEffect(() => {
    const visibleIds = new Set((chats ?? []).map((chat) => chat.id));
    setSelectedChatIds((previous) => {
      const next = new Set([...previous].filter((id) => visibleIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [chats]);

  useEffect(() => {
    if (pathname.startsWith("/assistant/chat/")) {
      const chatId = pathname.split("/").pop() ?? null;
      setCurrentChatId(chatId);
      return;
    }

    const projectChatMatch = pathname.match(
      /^\/projects\/[^/]+\/assistant\/chat\/([^/]+)/,
    );
    if (projectChatMatch) {
      setCurrentChatId(projectChatMatch[1]);
      return;
    }

    if (pathname === "/assistant") {
      setCurrentChatId(null);
    }
  }, [pathname, setCurrentChatId]);

  if (!user) return null;

  const leaveHistorySelectionMode = () => {
    setHistorySelectionMode(false);
    setSelectedChatIds(new Set());
  };

  const toggleChatSelected = (chatId: string) => {
    setSelectedChatIds((previous) => {
      const next = new Set(previous);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
  };

  const toggleAllChatsSelected = () => {
    setSelectedChatIds(
      allSelectableChatsSelected
        ? new Set()
        : new Set(selectableChats.map((chat) => chat.id)),
    );
  };

  const handleDeleteSelectedChats = async () => {
    const ids = [...selectedChatIds];
    if (
      ids.length === 0 ||
      !window.confirm(
        `Delete ${ids.length} selected chat${ids.length === 1 ? "" : "s"}? This cannot be undone.`,
      )
    ) {
      return;
    }

    setDeletingSelectedChats(true);
    try {
      await Promise.all(ids.map((id) => deleteChat(id)));
      leaveHistorySelectionMode();
      if (currentChatId && ids.includes(currentChatId)) {
        router.push("/assistant");
      }
    } finally {
      setDeletingSelectedChats(false);
    }
  };

  return (
    <div
      className={`${
        isOpen
          ? "w-64 h-dvh bg-gray-50 border-r"
          : "w-14 md:h-dvh md:bg-gray-50 md:border-r h-auto bg-transparent"
      } border-gray-200 flex flex-col transition-all duration-300 absolute md:relative z-99 overflow-visible`}
    >
      {/* Toggle + Logo */}
      <div
        className={`mb-3 items-center justify-between px-2.5 py-2 ${
          !isOpen ? "hidden md:flex" : "flex"
        }`}
      >
        {isOpen && (
          <div className="px-2.5">
            <Link
              href="/assistant"
              className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
            >
              <DocketIcon size={22} />
              <span
                className={`text-2xl font-light font-serif ${
                  shouldAnimate ? "sidebar-fade-in" : ""
                }`}
              >
                Docket
              </span>
            </Link>
          </div>
        )}
        <button
          onClick={onToggle}
          className="h-9 w-9 p-2.5 items-center flex hover:bg-gray-100 rounded-md transition-colors"
          title={isOpen ? "Close sidebar" : "Open sidebar"}
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      </div>

      {/* Nav items */}
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const isActive = pathname === href || pathname.startsWith(href + "/");
        return (
          <div key={href} className="py-1 px-2.5">
            <button
              onClick={() => router.push(href)}
              title={!isOpen ? label : ""}
              className={`w-full h-9 flex items-center gap-3 px-2.5 py-2 rounded-md transition-colors text-left ${
                isActive
                  ? "bg-gray-100 text-gray-900"
                  : "hover:bg-gray-100 text-gray-700"
              } ${!isOpen ? "hidden md:flex" : "flex"}`}
            >
              <Icon
                className={`h-4 w-4 flex-shrink-0 ${
                  isActive ? "text-gray-900" : "text-black"
                }`}
              />
              {isOpen && (
                <span
                  className={`text-sm font-medium ${
                    shouldAnimate ? "sidebar-fade-in-2" : ""
                  }`}
                >
                  {label}
                </span>
              )}
            </button>
          </div>
        );
      })}

      {/* Assistant History */}
      {isOpen && pathname.startsWith("/assistant") && (
        <div className="mt-4 flex-1 min-h-0 flex flex-col">
          <div
            className={`mb-2 px-5 flex items-center gap-2 text-xs font-semibold text-gray-500 ${
              shouldAnimate ? "sidebar-fade-in" : ""
            }`}
          >
            <button
              onClick={() => setHistoryCollapsed((v) => !v)}
              className="min-w-0 flex-1 text-left hover:text-gray-700 transition-colors"
              aria-expanded={!historyCollapsed}
            >
              <span>Assistant History</span>
            </button>
            {chats && chats.length > 0 && (
              <button
                onClick={() => {
                  if (historySelectionMode) leaveHistorySelectionMode();
                  else {
                    setHistoryCollapsed(false);
                    setHistorySelectionMode(true);
                  }
                }}
                className="font-medium text-gray-500 hover:text-gray-900 transition-colors"
              >
                {historySelectionMode ? "Cancel" : "Select"}
              </button>
            )}
            <button
              onClick={() => setHistoryCollapsed((v) => !v)}
              className="hover:text-gray-700 transition-colors"
              aria-label={
                historyCollapsed
                  ? "Expand assistant history"
                  : "Collapse assistant history"
              }
            >
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${historyCollapsed ? "-rotate-90" : ""}`}
              />
            </button>
          </div>
          {historySelectionMode && !historyCollapsed && (
            <div className="mb-1 flex h-8 items-center gap-2 border-y border-gray-200 px-5 text-xs">
              <button
                onClick={toggleAllChatsSelected}
                disabled={selectableChats.length === 0}
                className="text-gray-600 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {allSelectableChatsSelected ? "Clear all" : "Select all"}
              </button>
              <span className="ml-auto text-gray-400">
                {selectedChatIds.size} selected
              </span>
              <button
                onClick={() => void handleDeleteSelectedChats()}
                disabled={selectedChatIds.size === 0 || deletingSelectedChats}
                className="rounded p-1 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-30"
                title="Delete selected chats"
                aria-label="Delete selected chats"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div
            className={`overflow-y-auto flex-1 ${historyCollapsed ? "hidden" : ""}`}
          >
            {!chats ? (
              <div className="space-y-1 px-2.5">
                {[40, 60, 50, 70, 45].map((w, i) => (
                  <div
                    key={i}
                    className="h-9 flex items-center px-3 rounded-md"
                  >
                    <div
                      className="h-3 bg-gray-200 rounded animate-pulse"
                      style={{ width: `${w}%` }}
                    />
                  </div>
                ))}
              </div>
            ) : chats.length === 0 ? (
              <div
                className={`text-xs text-gray-500 py-2 px-5 ${
                  shouldAnimate ? "sidebar-fade-in-2" : ""
                }`}
              >
                No chats yet
              </div>
            ) : (
              <div
                className={`space-y-1 px-2.5 ${
                  shouldAnimate ? "sidebar-fade-in-2" : ""
                }`}
              >
                {chats.map((chat) => (
                  <SidebarChatItem
                    key={chat.id}
                    chat={chat}
                    isActive={currentChatId === chat.id}
                    projectName={
                      chat.project_id
                        ? projectNames[chat.project_id]
                        : undefined
                    }
                    onSelect={() => {
                      setCurrentChatId(chat.id);
                      router.push(
                        chat.project_id
                          ? `/projects/${chat.project_id}/assistant/chat/${chat.id}`
                          : `/assistant/chat/${chat.id}`,
                      );
                    }}
                    selectionMode={historySelectionMode}
                    isSelected={selectedChatIds.has(chat.id)}
                    onToggleSelected={() => toggleChatSelected(chat.id)}
                    isStreaming={activeChatKeys.has(
                      chatSessionKey(chat.id, chat.project_id),
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
