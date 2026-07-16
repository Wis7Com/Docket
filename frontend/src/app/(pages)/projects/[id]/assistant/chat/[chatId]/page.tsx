"use client";

import {
    use,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    ChevronLeft,
    ChevronRight,
    File,
    FileText,
    Loader2,
    Plus,
    Search,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import {
    deleteDocument,
    getChat,
    getProject,
    listProjectChats,
    uploadProjectDocument,
    createProjectFolder,
    renameProjectFolder,
    deleteProjectFolder,
    moveDocumentToFolder,
    moveSubfolderToFolder,
    searchProjectDocuments,
    type ProjectSearchResult,
} from "@/app/lib/docketApi";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { UserMessage } from "@/app/components/assistant/UserMessage";
import { AssistantMessage } from "@/app/components/assistant/AssistantMessage";
import { ChatInput } from "@/app/components/assistant/ChatInput";
import type { ChatInputHandle } from "@/app/components/assistant/ChatInput";
import {
    ProjectExplorer,
    ProjectSourceSelector,
} from "@/app/components/projects/ProjectExplorer";
import { buildDocumentSourceSelection } from "@/app/components/projects/documentSourceSelection";
import {
    collectDescendantDocIds,
    evidenceDocumentIds,
} from "@/app/components/projects/folderDocScope";
import { RenameableTitle } from "@/app/components/shared/RenameableTitle";
import { DocView } from "@/app/components/shared/DocView";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { ProjectChatHistoryMenu } from "@/app/components/shared/ProjectChatHistoryMenu";
import { DocxView } from "@/app/components/shared/DocxView";
import { DocketIcon } from "@/components/chat/docket-icon";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { useSidebar } from "@/app/contexts/SidebarContext";
import type {
    CitationQuote,
    DocketCitationAnnotation,
    DocketDocument,
    DocketEditAnnotation,
    DocketChat,
    DocketMessage,
    DocketProject,
} from "@/app/components/shared/types";
import { expandCitationToEntries } from "@/app/components/shared/types";
import { buildCitationNavigationKey } from "@/app/components/shared/citationNavigation";

interface Props {
    params: Promise<{ id: string; chatId: string }>;
}

type DocTab = {
    documentId: string;
    filename: string;
    quotes?: CitationQuote[];
    versionId?: string | null;
    refetchKey?: number;
    warning?: string | null;
    scrollTop?: number;
    focusAnnotationId?: string | null;
    focusAnnotationKey?: number;
    /** 0..1 progressive PDF render progress; undefined = not a PDF render. */
    renderProgress?: number;
};

type EditScrollTarget = {
    key: string;
    documentId: string;
    inserted_text?: string;
    deleted_text?: string;
    ins_w_id?: string | null;
    del_w_id?: string | null;
};

type PersistedViewerState = {
    tabs: DocTab[];
    activeTabId: string | null;
};

function viewerStateStorageKey(projectId: string) {
    return `docket:project-viewer:${projectId}`;
}

function HeaderActionTooltip({
    id,
    text,
    children,
}: {
    id: string;
    text: string;
    children: ReactNode;
}) {
    return (
        <span className="group relative inline-flex">
            {children}
            <span
                id={id}
                role="tooltip"
                className="pointer-events-none invisible absolute right-0 top-full z-[130] mt-2 w-max rounded-md bg-gray-900 px-2.5 py-1.5 text-[11px] font-normal text-white opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
            >
                <span className="absolute -top-1 right-3 h-2 w-2 rotate-45 bg-gray-900" />
                {text}
            </span>
        </span>
    );
}

function isDocxTab(filename: string) {
    const ext = filename.split(".").pop()?.toLowerCase();
    return ext === "docx" || ext === "doc";
}

function looksLikeUuid(value: string | null | undefined) {
    return Boolean(
        value?.match(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        ),
    );
}

const ICON_SIZE = 30;
const GAP = 14;
const EXPLORER_MIN = 160;
const EXPLORER_DEFAULT = 280;
const CHAT_MIN = 320;
const CHAT_DEFAULT = 420;
const CHAT_SEARCH_RESULT_LIMIT = 200;
const CHAT_SEARCH_PAGE_SIZES = [10, 25, 50] as const;

function AssistantSearchDocIcon({ fileType }: { fileType: string | null }) {
    if (fileType === "pdf") {
        return <FileText className="h-4 w-4 shrink-0 text-red-600" />;
    }
    if (fileType === "docx" || fileType === "doc") {
        return <File className="h-4 w-4 shrink-0 text-blue-600" />;
    }
    if (fileType === "md" || fileType === "txt") {
        return <FileText className="h-4 w-4 shrink-0 text-emerald-600" />;
    }
    return <File className="h-4 w-4 shrink-0 text-gray-500" />;
}

function escapeSearchRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimSearchTerm(value: string) {
    return value.replace(
        /^[\s"'“”‘’.,;:!?()[\]{}<>/\\|`~@#$%^&*_+=-]+|[\s"'“”‘’.,;:!?()[\]{}<>/\\|`~@#$%^&*_+=-]+$/g,
        "",
    );
}

function normalizeSearchTerms(query: string) {
    return Array.from(
        new Set(
            query
                .trim()
                .replace(/([\p{L}\p{N}_])['’]s\b/giu, "$1")
                .replace(/[^\p{L}\p{N}_]+/gu, " ")
                .split(" ")
                .map(trimSearchTerm)
                .filter((part) => part.length > 0)
                .filter((part) => !/^[A-Za-z]$/.test(part)),
        ),
    );
}

function addSearchHighlightRange(
    ranges: { start: number; end: number }[],
    start: number,
    end: number,
) {
    if (end <= start) return;
    if (ranges.some((range) => start < range.end && end > range.start)) return;
    ranges.push({ start, end });
}

function findSearchHighlightRanges(text: string, query: string) {
    const terms = normalizeSearchTerms(query);
    if (terms.length === 0) return [];

    const ranges: { start: number; end: number }[] = [];
    if (terms.length > 1) {
        const phrasePattern = terms
            .map((term) => `${escapeSearchRegExp(term)}(?:['’]s)?`)
            .join("[\\s\\W_]+");
        const phraseRegex = new RegExp(phrasePattern, "gi");
        let match: RegExpExecArray | null;
        while ((match = phraseRegex.exec(text)) != null) {
            addSearchHighlightRange(
                ranges,
                match.index ?? 0,
                (match.index ?? 0) + match[0].length,
            );
        }
        if (ranges.length > 0) return ranges.sort((a, b) => a.start - b.start);
    }

    const highlightTerms = terms
        .filter((part) => part.length >= 2)
        .sort((a, b) => b.length - a.length);

    for (const term of highlightTerms) {
        const termRegex = new RegExp(escapeSearchRegExp(term), "gi");
        let match: RegExpExecArray | null;
        while ((match = termRegex.exec(text)) != null) {
            addSearchHighlightRange(
                ranges,
                match.index ?? 0,
                (match.index ?? 0) + match[0].length,
            );
        }
    }

    return ranges.sort((a, b) => a.start - b.start);
}

function renderHighlightedSearchText(
    text: string,
    query: string,
    keyPrefix: string,
) {
    const ranges = findSearchHighlightRanges(text, query);
    if (ranges.length === 0) return <span key={keyPrefix}>{text}</span>;

    const nodes: ReactNode[] = [];
    let cursor = 0;
    ranges.forEach((range, index) => {
        if (range.start > cursor) {
            nodes.push(
                <span key={`${keyPrefix}-text-${index}`}>
                    {text.slice(cursor, range.start)}
                </span>,
            );
        }
        nodes.push(
            <mark
                key={`${keyPrefix}-match-${index}`}
                className="rounded bg-yellow-100 px-0.5 font-medium text-gray-900"
            >
                {text.slice(range.start, range.end)}
            </mark>,
        );
        cursor = range.end;
    });
    if (cursor < text.length) {
        nodes.push(<span key={`${keyPrefix}-tail`}>{text.slice(cursor)}</span>);
    }
    return nodes;
}

function renderAssistantSearchSnippet(snippet: string, query: string) {
    const parts = snippet.split(/(\[\[HL\]\]|\[\[\/HL\]\])/g);
    let highlighted = false;
    const hasServerHighlights = parts.length > 1;
    if (!hasServerHighlights) {
        return renderHighlightedSearchText(
            snippet,
            query,
            "chat-search-snippet",
        );
    }

    return parts.map((part, index) => {
        if (part === "[[HL]]") {
            highlighted = true;
            return null;
        }
        if (part === "[[/HL]]") {
            highlighted = false;
            return null;
        }
        if (!part) return null;
        return highlighted ? (
            <mark
                key={index}
                className="rounded bg-yellow-100 px-0.5 text-gray-900"
            >
                {part}
            </mark>
        ) : (
            <span key={index}>{part}</span>
        );
    });
}

function stripSearchHighlightMarkers(value: string) {
    return value.replace(/\[\[\/?HL\]\]/g, "").trim();
}

function buildAssistantSearchQuote(result: ProjectSearchResult, query: string) {
    const fileType = result.file_type?.toLowerCase();
    const opener = stripSearchHighlightMarkers(
        result.snippet || result.quote || result.content || query,
    );
    if (fileType === "md" || fileType === "txt") return opener;
    return opener || query;
}

function searchReasonLabel(reason: string): string {
    if (reason === "keyword") return "keyword";
    if (reason === "substring") return "substring";
    if (reason === "semantic") return "semantic";
    if (reason === "filename") return "filename";
    if (reason === "exact") return "exact";
    if (reason === "basic") return "basic";
    return reason;
}

function searchReasonClass(reason: string): string {
    if (reason === "semantic") return "bg-blue-50 text-blue-700";
    if (reason === "substring") return "bg-purple-50 text-purple-700";
    if (reason === "exact") return "bg-emerald-50 text-emerald-700";
    if (reason === "filename") return "bg-gray-100 text-gray-600";
    if (reason === "basic") return "bg-yellow-50 text-yellow-700";
    return "bg-amber-50 text-amber-700";
}

function AssistantGreeting({ username }: { username: string }) {
    const [loaded, setLoaded] = useState(false);
    const [iconOffset, setIconOffset] = useState(0);
    const [textOffset, setTextOffset] = useState(0);
    const textRef = useRef<HTMLHeadingElement>(null);

    useLayoutEffect(() => {
        if (!textRef.current) return;
        const h1Width = textRef.current.offsetWidth;
        setIconOffset((h1Width + GAP) / 2);
        setTextOffset((ICON_SIZE + GAP) / 2);
    }, [username]);

    useEffect(() => {
        if (!iconOffset) return;
        const t = setTimeout(() => setLoaded(true), 100);
        return () => clearTimeout(t);
    }, [iconOffset]);

    return (
        <div className="flex-1 flex items-center justify-center">
            <div className="relative flex items-center justify-center h-[30px]">
                <div
                    className="absolute h-[30px]"
                    style={{
                        left: "50%",
                        transform: loaded
                            ? `translateX(calc(-50% - ${iconOffset}px))`
                            : "translateX(-50%)",
                        transition:
                            "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                    }}
                >
                    <DocketIcon size={ICON_SIZE} />
                </div>
                <h1
                    ref={textRef}
                    className="absolute text-2xl font-serif font-light text-gray-900 whitespace-nowrap"
                    style={{
                        left: "50%",
                        transform: loaded
                            ? `translateX(calc(-50% + ${textOffset}px))`
                            : "translateX(-50%)",
                        opacity: loaded ? 1 : 0,
                        transition:
                            "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 800ms ease-in-out 300ms",
                    }}
                >
                    Hi, {username}
                </h1>
            </div>
        </div>
    );
}

/** Drag-handle divider for resizing panels */
function Divider({ onDrag }: { onDrag: (dx: number) => void }) {
    const dragging = useRef(false);
    const lastX = useRef(0);
    const [isDragging, setIsDragging] = useState(false);

    const onMouseDown = (e: React.MouseEvent) => {
        dragging.current = true;
        setIsDragging(true);
        lastX.current = e.clientX;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    useEffect(() => {
        function onMouseMove(e: MouseEvent) {
            if (!dragging.current) return;
            onDrag(e.clientX - lastX.current);
            lastX.current = e.clientX;
        }
        function onMouseUp() {
            if (!dragging.current) return;
            dragging.current = false;
            setIsDragging(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        }
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };
    }, [onDrag]);

    return (
        <div className="relative w-0 shrink-0 z-10">
            <div
                onMouseDown={onMouseDown}
                className="absolute inset-y-0 -left-2 -right-2 cursor-col-resize flex items-stretch justify-center"
            >
                {isDragging && (
                    <div className="w-1 bg-blue-500 transition-colors" />
                )}
            </div>
        </div>
    );
}

export default function ProjectAssistantChatPage({ params }: Props) {
    const { id: projectId, chatId } = use(params);
    const router = useRouter();
    const searchParams = useSearchParams();
    const initialExplorerSearchQuery =
        searchParams.get("q") || searchParams.get("search") || "";
    const initialExplorerSearchType = searchParams.get("type") || "all";

    const { setSidebarOpen } = useSidebar();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";

    const [project, setProject] = useState<DocketProject | null>(null);
    const [chatTitle, setChatTitle] = useState<string | null>(null);
    const [chatOwnerId, setChatOwnerId] = useState<string | null>(null);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [chatLoaded, setChatLoaded] = useState(false);
    const [creatingChat, setCreatingChat] = useState(false);
    const [deletingChat, setDeletingChat] = useState(false);

    // Panel widths
    const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
    const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT);
    const [explorerCollapsed, setExplorerCollapsed] = useState(false);
    const [explorerSearchQuery, setExplorerSearchQuery] = useState(
        initialExplorerSearchQuery,
    );
    const [explorerSearchActiveQuery, setExplorerSearchActiveQuery] =
        useState("");
    const [explorerSearchResults, setExplorerSearchResults] = useState<
        ProjectSearchResult[]
    >([]);
    const [explorerSearchLoading, setExplorerSearchLoading] = useState(false);
    const [explorerSearchError, setExplorerSearchError] = useState<
        string | null
    >(null);
    const [explorerSearchType, setExplorerSearchType] = useState(
        initialExplorerSearchType,
    );
    const [explorerSearchPageSize, setExplorerSearchPageSize] =
        useState<number>(CHAT_SEARCH_PAGE_SIZES[0]);
    const [explorerSearchPage, setExplorerSearchPage] = useState(1);

    // Upload state
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [explorerDragOver, setExplorerDragOver] = useState(false);

    // Tabs
    const [tabs, setTabs] = useState<DocTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [activeQuotes, setActiveQuotes] = useState<CitationQuote[] | null>(
        null,
    );
    const [activeCitationNavigationKey, setActiveCitationNavigationKey] =
        useState<string | null>(null);
    const citationNavigationNonceRef = useRef(0);
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const [viewerStateRestored, setViewerStateRestored] = useState(false);
    const [deselectedDocIds, setDeselectedDocIds] = useState<Set<string>>(
        new Set(),
    );
    const [editScrollTarget, setEditScrollTarget] =
        useState<EditScrollTarget | null>(null);
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );

    const activeTab = tabs.find((t) => t.documentId === activeTabId) ?? null;
    const tabBarRef = useRef<HTMLDivElement | null>(null);
    const tabItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

    useLayoutEffect(() => {
        setViewerStateRestored(false);
        try {
            const raw = sessionStorage.getItem(
                viewerStateStorageKey(projectId),
            );
            if (!raw) return;
            const saved = JSON.parse(raw) as Partial<PersistedViewerState>;
            if (!Array.isArray(saved.tabs)) return;
            const restoredTabs = saved.tabs.filter(
                (tab): tab is DocTab =>
                    !!tab &&
                    typeof tab.documentId === "string" &&
                    typeof tab.filename === "string",
            );
            const restoredActiveTab =
                restoredTabs.find(
                    (tab) => tab.documentId === saved.activeTabId,
                ) ??
                restoredTabs[0] ??
                null;
            setTabs(restoredTabs);
            setActiveTabId(restoredActiveTab?.documentId ?? null);
            setActiveQuotes(restoredActiveTab?.quotes ?? null);
            setSelectedDocId(restoredActiveTab?.documentId ?? null);
        } catch {
            try {
                sessionStorage.removeItem(viewerStateStorageKey(projectId));
            } catch {
                // Ignore browsers that disable session storage entirely.
            }
        } finally {
            setViewerStateRestored(true);
        }
    }, [projectId]);

    useEffect(() => {
        if (!viewerStateRestored) return;
        const state: PersistedViewerState = { tabs, activeTabId };
        try {
            sessionStorage.setItem(
                viewerStateStorageKey(projectId),
                JSON.stringify(state),
            );
        } catch {
            // Viewer persistence is best-effort; storage policy or quota must
            // never prevent the document itself from rendering.
        }
    }, [activeTabId, projectId, tabs, viewerStateRestored]);

    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const [minHeight, setMinHeight] = useState("0px");

    const {
        setCurrentChatId,
        newChatMessages,
        setNewChatMessages,
        chats,
        saveChat,
        renameChat,
        deleteChat: deleteChatFromHistory,
    } = useChatHistoryContext();
    const [projectChats, setProjectChats] = useState<DocketChat[]>([]);
    const [initialMessages] = useState<DocketMessage[]>(newChatMessages ?? []);
    const { messages, isResponseLoading, handleChat, setMessages, cancel } =
        useAssistantChat({ initialMessages, chatId, projectId });

    const hasLoaded = useRef(false);
    const hasAutoSent = useRef(false);
    const hasInitialScrolled = useRef(false);
    const hasRunInitialExplorerSearch = useRef(false);

    useEffect(() => {
        setSidebarOpen(false);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        getProject(projectId)
            .then(setProject)
            .catch(() => {});
    }, [projectId]);

    const submitExplorerSearch = useCallback(
        async (nextQuery?: string, nextType?: string) => {
            const q = (nextQuery ?? explorerSearchQuery).trim();
            const type = nextType ?? explorerSearchType;
            if (!q) {
                setExplorerSearchResults([]);
                setExplorerSearchActiveQuery("");
                setExplorerSearchError(null);
                setExplorerSearchPage(1);
                return;
            }
            setExplorerSearchLoading(true);
            setExplorerSearchError(null);
            try {
                const result = await searchProjectDocuments(projectId, {
                    q,
                    limit: CHAT_SEARCH_RESULT_LIMIT,
                    types: type === "all" ? undefined : [type],
                    group: "documents",
                });
                setExplorerSearchResults(result.results);
                setExplorerSearchActiveQuery(q);
                setExplorerSearchPage(1);
            } catch (err) {
                setExplorerSearchError(
                    (err as Error).message || "Search failed",
                );
            } finally {
                setExplorerSearchLoading(false);
            }
        },
        [explorerSearchQuery, explorerSearchType, projectId],
    );

    useEffect(() => {
        if (hasRunInitialExplorerSearch.current) return;
        const q = initialExplorerSearchQuery.trim();
        if (!q) return;
        hasRunInitialExplorerSearch.current = true;
        void submitExplorerSearch(q, initialExplorerSearchType);
    }, [
        initialExplorerSearchQuery,
        initialExplorerSearchType,
        submitExplorerSearch,
    ]);

    const refreshProjectChats = useCallback(() => {
        listProjectChats(projectId)
            .then((rows) => setProjectChats(rows))
            .catch(() => setProjectChats([]));
    }, [projectId]);

    useEffect(() => {
        refreshProjectChats();
    }, [refreshProjectChats, chatId, chatTitle]);

    // Whenever the assistant mutates project documents — creating a new
    // doc, creating a new version via edit_document, or replicating a doc —
    // refresh the project so the explorer picks up the new/changed files
    // without a manual reload. Keyed by completed mutation events only, so
    // we refetch once the backend has finished persisting the change.
    const projectMutationSignature = useMemo(() => {
        const created: string[] = [];
        const replicated: string[] = [];
        const editedPerDoc: Record<string, number> = {};
        for (const msg of messages) {
            for (const ev of msg.events ?? []) {
                if ("isStreaming" in ev && ev.isStreaming) continue;
                if (ev.type === "doc_created" && ev.document_id) {
                    created.push(
                        `${ev.document_id}:${ev.version_id ?? ""}:${ev.filename}`,
                    );
                    continue;
                }
                if (ev.type === "doc_replicated") {
                    for (const c of ev.copies ?? []) {
                        replicated.push(
                            `${c.document_id}:${c.version_id}:${c.new_filename}`,
                        );
                    }
                    continue;
                }
                if (ev.type === "doc_edited") {
                    editedPerDoc[ev.document_id] = Math.max(
                        editedPerDoc[ev.document_id] ?? 0,
                        (ev.version_number as number | null | undefined) ?? 0,
                    );
                }
            }
        }
        return [
            `created=${created.sort().join(",")}`,
            `replicated=${replicated.sort().join(",")}`,
            `edited=${Object.entries(editedPerDoc)
                .map(([k, v]) => `${k}=${v}`)
                .sort()
                .join(",")}`,
        ].join("|");
    }, [messages]);

    useEffect(() => {
        if (!projectMutationSignature) return;
        getProject(projectId)
            .then(setProject)
            .catch(() => {});
    }, [projectMutationSignature, projectId]);

    useEffect(() => {
        setCurrentChatId(chatId);
    }, [chatId, setCurrentChatId]);

    useEffect(() => {
        if (hasLoaded.current) return;
        hasLoaded.current = true;
        getChat(chatId)
            .then(({ chat, messages: loaded }) => {
                setChatTitle(chat.title);
                setChatOwnerId(chat.user_id ?? null);
                if (loaded.length > 0) setMessages(loaded);
            })
            .catch(() => router.replace(`/projects/${projectId}?tab=assistant`))
            .finally(() => setChatLoaded(true));
    }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const match = chats?.find((c) => c.id === chatId);
        if (match?.title) setChatTitle(match.title);
    }, [chats, chatId]);

    useEffect(() => {
        if (
            newChatMessages &&
            newChatMessages.length === 1 &&
            newChatMessages[0].role === "user" &&
            !hasAutoSent.current &&
            !isResponseLoading &&
            messages.length === 1
        ) {
            hasAutoSent.current = true;
            setNewChatMessages(null);
            void handleChat(newChatMessages[0]);
        }
    }, [newChatMessages, messages.length, isResponseLoading]); // eslint-disable-line react-hooks/exhaustive-deps

    const scrollLatestUserToTop = useCallback(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const container = messagesContainerRef.current;
                const element = latestUserMessageRef.current;
                if (!container || !element) return;
                container.scrollTo({
                    top: element.offsetTop - 24,
                    behavior: "smooth",
                });
            });
        });
    }, []);

    useEffect(() => {
        const last = messages[messages.length - 1];
        if (last?.role === "user") scrollLatestUserToTop();
    }, [messages, scrollLatestUserToTop]);

    useEffect(() => {
        if (!chatLoaded || hasInitialScrolled.current || messages.length === 0)
            return;
        const container = messagesContainerRef.current;
        const el = latestUserMessageRef.current;
        if (!container || !el) return;
        hasInitialScrolled.current = true;
        setTimeout(() => {
            container.scrollTo({
                top: el.offsetTop - 16,
                behavior: "auto",
            });
        }, 100);
    }, [chatLoaded, messages.length]);

    useEffect(() => {
        if (isResponseLoading) scrollLatestUserToTop();
    }, [isResponseLoading, scrollLatestUserToTop]);

    useEffect(() => {
        const userEl = latestUserMessageRef.current;
        const containerEl = messagesContainerRef.current;
        if (!userEl || !containerEl) return;
        setMinHeight(
            `${Math.max(0, containerEl.clientHeight - 48 - userEl.offsetHeight - 16)}px`,
        );
    }, [messages.length]);

    useEffect(() => {
        if (!activeTabId) return;
        const el = tabItemRefs.current[activeTabId];
        if (!el) return;
        el.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
            inline: "nearest",
        });
    }, [activeTabId, tabs.length]);

    // ── Tabs ──────────────────────────────────────────────────────────────────
    function openTab(
        docId: string,
        filename: string,
        quotes?: CitationQuote[],
        versionId?: string | null,
        citationNavigationKey?: string | null,
    ) {
        setTabs((prev) => {
            const existing = prev.find((t) => t.documentId === docId);
            if (existing) {
                return prev.map((t) =>
                    t.documentId === docId
                        ? {
                              ...t,
                              filename,
                              quotes:
                                  quotes && quotes.length ? quotes : t.quotes,
                              versionId:
                                  versionId !== undefined
                                      ? versionId
                                      : t.versionId,
                          }
                        : t,
                );
            }
            return [
                ...prev,
                { documentId: docId, filename, quotes, versionId },
            ];
        });
        setActiveTabId(docId);
        setActiveQuotes(quotes && quotes.length ? quotes : null);
        setActiveCitationNavigationKey(citationNavigationKey ?? null);
        setSelectedDocId(docId);
    }

    function closeTab(docId: string) {
        setTabs((prev) => {
            const next = prev.filter((t) => t.documentId !== docId);
            if (activeTabId === docId) {
                const idx = prev.findIndex((t) => t.documentId === docId);
                const fallback = next[idx] ?? next[idx - 1] ?? null;
                setActiveTabId(fallback?.documentId ?? null);
                setActiveQuotes(null);
                setSelectedDocId(fallback?.documentId ?? null);
            }
            return next;
        });
    }

    function switchTab(docId: string) {
        setActiveTabId(docId);
        const tab = tabs.find((t) => t.documentId === docId);
        setActiveQuotes(tab?.quotes && tab.quotes.length ? tab.quotes : null);
        setSelectedDocId(docId);
    }

    const activeTabIndex = tabs.findIndex(
        (tab) => tab.documentId === activeTabId,
    );

    function switchTabByOffset(offset: number) {
        const next = tabs[activeTabIndex + offset];
        if (next) switchTab(next.documentId);
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handleSubmit = useCallback(
        (message: DocketMessage) => {
            const attachedDocumentIds = (message.files ?? [])
                .map((file) => file.document_id)
                .filter((id): id is string => Boolean(id));
            const sourceSelection = buildDocumentSourceSelection(
                project?.documents ?? [],
                deselectedDocIds,
                attachedDocumentIds,
            );
            setDeselectedDocIds(sourceSelection.deselectedDocIds);
            return handleChat(message, {
                displayedDoc: activeTab
                    ? {
                          filename: activeTab.filename,
                          documentId: activeTab.documentId,
                      }
                    : null,
                selectedDocumentIds: sourceSelection.selectedDocumentIds,
            });
        },
        [activeTab, deselectedDocIds, handleChat, project?.documents],
    );

    const handleToggleSourceDocument = useCallback(
        (docId: string, selected: boolean) => {
            setDeselectedDocIds((current) => {
                const next = new Set(current);
                if (selected) next.delete(docId);
                else next.add(docId);
                return next;
            });
        },
        [],
    );

    const handleToggleAllSourceDocuments = useCallback(
        (selected: boolean) => {
            setDeselectedDocIds(
                selected
                    ? new Set()
                    : new Set(
                          (project?.documents ?? []).map(
                              (document) => document.id,
                          ),
                      ),
            );
        },
        [project?.documents],
    );

    const handleToggleFolderSourceDocuments = useCallback(
        (folderId: string, selected: boolean) => {
            const documentIds = collectDescendantDocIds(
                project?.folders ?? [],
                project?.documents ?? [],
                folderId,
            );
            setDeselectedDocIds((current) => {
                const next = new Set(current);
                for (const documentId of documentIds) {
                    if (selected) next.delete(documentId);
                    else next.add(documentId);
                }
                return next;
            });
        },
        [project?.documents, project?.folders],
    );

    const handleSelectBriefSources = useCallback(() => {
        const evidenceIds = evidenceDocumentIds(project?.documents ?? []);
        setDeselectedDocIds((current) => {
            const next = new Set(current);
            for (const documentId of evidenceIds) next.add(documentId);
            return next;
        });
    }, [project?.documents]);

    // True when the project has documents but the user has unchecked every
    // one as a chat source. In that state a message with no direct
    // attachment has nothing to answer from, so the input blocks submission
    // instead of silently falling back to the whole project.
    const noSourcesSelected = useMemo(() => {
        const docs = project?.documents ?? [];
        if (docs.length === 0) return false;
        return docs.every((document) => deselectedDocIds.has(document.id));
    }, [project?.documents, deselectedDocIds]);

    const handleDocClick = (doc: DocketDocument) => {
        openTab(doc.id, doc.filename);
    };

    const handleSearchResultClick = (result: ProjectSearchResult) => {
        const doc = project?.documents?.find(
            (d) => d.id === result.document_id,
        );
        const quote = buildAssistantSearchQuote(
            result,
            explorerSearchActiveQuery || explorerSearchQuery,
        );
        openTab(
            result.document_id,
            result.filename || doc?.filename || result.document_id,
            [
                {
                    quote,
                    page: result.page_number ?? undefined,
                },
            ],
            result.version_id || doc?.current_version_id || null,
        );
    };

    const handleCitationClick = (citation: DocketCitationAnnotation) => {
        const docs = project?.documents ?? [];
        const docLabelMatch =
            typeof citation.doc_id === "string"
                ? citation.doc_id.match(/^doc-(\d+)$/)
                : null;
        const docFromLabel = docLabelMatch
            ? docs[Number(docLabelMatch[1])]
            : undefined;
        const rawDocumentId =
            typeof citation.document_id === "string" &&
            citation.document_id.trim()
                ? citation.document_id
                : citation.doc_id;
        const docMatch =
            docs.find((doc) => doc.id === rawDocumentId) ??
            docs.find((doc) => doc.filename === citation.filename) ??
            docFromLabel;
        const usableDirectId =
            typeof citation.document_id === "string" &&
            citation.document_id.trim() &&
            citation.document_id !== citation.doc_id
                ? citation.document_id
                : null;
        const documentId = docMatch?.id ?? usableDirectId;
        if (!documentId) {
            console.warn(
                "Cannot open citation without a document id",
                citation,
            );
            return;
        }
        const filename =
            docMatch?.filename ??
            (citation.filename && !looksLikeUuid(citation.filename)
                ? citation.filename
                : documentId);
        const normalizedCitation: DocketCitationAnnotation = {
            ...citation,
            document_id: documentId,
            filename,
            version_id:
                citation.version_id ?? docMatch?.current_version_id ?? null,
            version_number:
                citation.version_number ??
                docMatch?.latest_version_number ??
                null,
        };
        openTab(
            normalizedCitation.document_id,
            normalizedCitation.filename,
            expandCitationToEntries(normalizedCitation),
            normalizedCitation.version_id ?? null,
            buildCitationNavigationKey(
                normalizedCitation,
                ++citationNavigationNonceRef.current,
            ),
        );
    };

    const handleOpenDocument = (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => {
        openTab(args.documentId, args.filename, undefined, args.versionId);
    };

    const handleEditViewClick = (
        ann: DocketEditAnnotation,
        filename: string,
    ) => {
        openTab(ann.document_id, filename, undefined, ann.version_id ?? null);
        setEditScrollTarget({
            key: `${ann.edit_id}-${Date.now()}`,
            documentId: ann.document_id,
            inserted_text: ann.inserted_text,
            deleted_text: ann.deleted_text,
            ins_w_id: ann.ins_w_id ?? null,
            del_w_id: ann.del_w_id ?? null,
        });
    };

    const handleEditResolved = (_args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => {
        // Re-render after accept/reject is disabled while we verify the
        // client-side optimistic mutation works on its own. Re-enable by
        // bumping versionId + refetchKey on the matching tab and marking
        // it reloading like before.
        void _args;
    };

    const patchTab = (documentId: string, patch: Partial<DocTab>) => {
        setTabs((prev) =>
            prev.map((t) =>
                t.documentId === documentId ? { ...t, ...patch } : t,
            ),
        );
    };

    const handleEditError = (args: { documentId: string; message: string }) => {
        patchTab(args.documentId, { warning: args.message });
    };

    const dismissTabWarning = (documentId: string) => {
        patchTab(documentId, { warning: null });
    };

    const handleTabScrollChange = (documentId: string, scrollTop: number) => {
        patchTab(documentId, { scrollTop });
    };

    const handleDocxReady = (documentId: string) => {
        setReloadingDocIds((prev) => {
            if (!prev.has(documentId)) return prev;
            const next = new Set(prev);
            next.delete(documentId);
            return next;
        });
    };

    const handleChatDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const docId = e.dataTransfer.getData("application/docket-doc");
        if (!docId) return;
        const doc = project?.documents?.find((d) => d.id === docId);
        if (doc) chatInputRef.current?.addDoc(doc);
    };

    // ── Chat actions ──────────────────────────────────────────────────────────
    async function handleNewChat() {
        setCreatingChat(true);
        try {
            const id = await saveChat(projectId);
            if (id) router.push(`/projects/${projectId}/assistant/chat/${id}`);
        } finally {
            setCreatingChat(false);
        }
    }

    async function handleRenameChat(newTitle: string) {
        if (!newTitle || newTitle === chatTitle) return;
        setChatTitle(newTitle);
        setProjectChats((prev) =>
            prev.map((c) => (c.id === chatId ? { ...c, title: newTitle } : c)),
        );
        await renameChat(chatId, newTitle);
    }

    async function handleRenameProjectChat(
        targetChatId: string,
        newTitle: string,
    ) {
        if (targetChatId === chatId) {
            await handleRenameChat(newTitle);
            return;
        }
        setProjectChats((prev) =>
            prev.map((chat) =>
                chat.id === targetChatId ? { ...chat, title: newTitle } : chat,
            ),
        );
        await renameChat(targetChatId, newTitle);
    }

    async function handleDeleteProjectChats(chatIds: string[]) {
        await Promise.all(chatIds.map((id) => deleteChatFromHistory(id)));
        setProjectChats((prev) =>
            prev.filter((chat) => !chatIds.includes(chat.id)),
        );
        if (chatIds.includes(chatId)) {
            router.push(`/projects/${projectId}?tab=assistant`);
        }
    }

    async function handleDeleteChat() {
        if (chatOwnerId && user?.id && chatOwnerId !== user.id) {
            setOwnerOnlyAction("delete this chat");
            return;
        }
        setDeletingChat(true);
        try {
            await handleDeleteProjectChats([chatId]);
        } finally {
            setDeletingChat(false);
        }
    }

    // ── Upload ────────────────────────────────────────────────────────────────
    async function uploadFiles(files: File[]) {
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                files.map((f) => uploadProjectDocument(projectId, f)),
            );
            setProject((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    documents: [...(prev.documents ?? []), ...uploaded],
                };
            });
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    const handleExplorerFileDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setExplorerDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) {
            await uploadFiles(files);
        }
        // Internal doc/folder moves are handled inside ProjectExplorer (stopPropagation)
    };

    // ── Folder handlers ───────────────────────────────────────────────────────
    const handleCreateFolder = async (
        parentId: string | null,
        name: string,
    ) => {
        const folder = await createProjectFolder(
            projectId,
            name,
            parentId ?? undefined,
        );
        setProject((prev) =>
            prev
                ? { ...prev, folders: [...(prev.folders ?? []), folder] }
                : prev,
        );
    };

    const handleRenameFolder = async (folderId: string, name: string) => {
        await renameProjectFolder(projectId, folderId, name);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).map((f) =>
                          f.id === folderId ? { ...f, name } : f,
                      ),
                  }
                : prev,
        );
    };

    const handleDeleteFolder = async (folderId: string) => {
        const toDelete = new Set<string>();
        function collectIds(id: string) {
            toDelete.add(id);
            (project?.folders ?? [])
                .filter((f) => f.parent_folder_id === id)
                .forEach((f) => collectIds(f.id));
        }
        collectIds(folderId);
        await deleteProjectFolder(projectId, folderId);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).filter(
                          (f) => !toDelete.has(f.id),
                      ),
                      documents: (prev.documents ?? []).map((d) =>
                          d.folder_id && toDelete.has(d.folder_id)
                              ? { ...d, folder_id: null }
                              : d,
                      ),
                  }
                : prev,
        );
    };

    const handleMoveDoc = async (
        docId: string,
        targetFolderId: string | null,
    ) => {
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).map((d) =>
                          d.id === docId
                              ? { ...d, folder_id: targetFolderId }
                              : d,
                      ),
                  }
                : prev,
        );
        await moveDocumentToFolder(projectId, docId, targetFolderId);
    };

    const handleMoveFolder = async (
        folderId: string,
        targetFolderId: string | null,
    ) => {
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).map((f) =>
                          f.id === folderId
                              ? { ...f, parent_folder_id: targetFolderId }
                              : f,
                      ),
                  }
                : prev,
        );
        await moveSubfolderToFolder(projectId, folderId, targetFolderId);
    };

    const handleDeleteDoc = async (docId: string) => {
        await deleteDocument(docId);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).filter(
                          (d) => d.id !== docId,
                      ),
                  }
                : prev,
        );
        setTabs((prev) => prev.filter((t) => t.documentId !== docId));
        if (activeTabId === docId) {
            setActiveTabId(null);
            setActiveQuotes(null);
            setSelectedDocId(null);
            setEditScrollTarget(null);
        }
    };

    // ── Resize handlers ───────────────────────────────────────────────────────
    const onExplorerDividerDrag = useCallback((dx: number) => {
        setExplorerWidth((w) => Math.max(EXPLORER_MIN, w + dx));
    }, []);

    const onChatDividerDrag = useCallback((dx: number) => {
        setChatWidth((w) => Math.max(CHAT_MIN, w - dx));
    }, []);

    const explorerSearchDisplayQuery =
        explorerSearchActiveQuery || explorerSearchQuery;
    const explorerSearchPageCount = Math.max(
        1,
        Math.ceil(explorerSearchResults.length / explorerSearchPageSize),
    );
    const safeExplorerSearchPage = Math.min(
        explorerSearchPage,
        explorerSearchPageCount,
    );
    const explorerSearchStartIndex =
        (safeExplorerSearchPage - 1) * explorerSearchPageSize;
    const explorerSearchEndIndex = Math.min(
        explorerSearchStartIndex + explorerSearchPageSize,
        explorerSearchResults.length,
    );
    const explorerSearchVisibleResults = explorerSearchResults.slice(
        explorerSearchStartIndex,
        explorerSearchEndIndex,
    );
    const explorerSearchActive = Boolean(
        explorerSearchActiveQuery ||
        explorerSearchLoading ||
        explorerSearchError ||
        explorerSearchResults.length > 0,
    );

    return (
        <div className="flex flex-col h-full">
            {/* Page header */}
            <div className="flex items-center justify-between px-8 py-4 shrink-0">
                <div className="flex items-center gap-1.5 text-2xl font-medium font-serif">
                    <button
                        onClick={() => router.push("/projects")}
                        className="text-gray-500 hover:text-gray-700 transition-colors"
                    >
                        Projects
                    </button>
                    <span className="text-gray-300">›</span>
                    {project ? (
                        <button
                            onClick={() =>
                                router.push(`/projects/${projectId}`)
                            }
                            className="text-gray-500 hover:text-gray-700 transition-colors"
                        >
                            {project.name}
                            {project.cm_number && (
                                <span className="ml-1 text-gray-400">
                                    (#{project.cm_number})
                                </span>
                            )}
                        </button>
                    ) : (
                        <div className="h-6 w-32 rounded bg-gray-100 animate-pulse" />
                    )}
                    <span className="text-gray-300">›</span>
                    <button
                        onClick={() =>
                            router.push(`/projects/${projectId}?tab=assistant`)
                        }
                        className="text-gray-500 hover:text-gray-700 transition-colors"
                    >
                        Assistant
                    </button>
                    <span className="text-gray-300">›</span>
                    {chatLoaded ? (
                        // Rename is creator-only on the backend, so only
                        // offer inline editing to the chat owner.
                        !chatOwnerId || chatOwnerId === user?.id ? (
                            <span className="truncate max-w-xs">
                                <RenameableTitle
                                    value={chatTitle ?? "Untitled New Chat"}
                                    onCommit={(v) => void handleRenameChat(v)}
                                />
                            </span>
                        ) : (
                            <span className="text-gray-900 truncate max-w-xs">
                                {chatTitle ?? "Untitled New Chat"}
                            </span>
                        )
                    ) : (
                        <div className="h-6 w-40 rounded bg-gray-100 animate-pulse" />
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <HeaderActionTooltip
                        id="new-chat-tooltip"
                        text="Start a new chat"
                    >
                        <button
                            onClick={handleNewChat}
                            disabled={creatingChat}
                            aria-label="Start a new chat"
                            aria-describedby="new-chat-tooltip"
                            className="flex items-center justify-center rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 disabled:opacity-40"
                        >
                            {creatingChat ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Plus className="h-4 w-4" />
                            )}
                        </button>
                    </HeaderActionTooltip>
                    <HeaderActionTooltip
                        id="delete-chat-tooltip"
                        text="Delete this chat"
                    >
                        <button
                            onClick={handleDeleteChat}
                            disabled={deletingChat}
                            aria-label="Delete this chat"
                            aria-describedby="delete-chat-tooltip"
                            className="flex items-center justify-center rounded-md p-1.5 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 disabled:opacity-40"
                        >
                            {deletingChat ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Trash2 className="h-4 w-4" />
                            )}
                        </button>
                    </HeaderActionTooltip>
                </div>
            </div>

            {/* Three-panel body */}
            <div className="flex flex-1 min-h-0 border-t border-gray-200 overflow-hidden">
                {/* LEFT: Project Explorer */}
                {!explorerCollapsed && (
                    <>
                        <div
                            style={{ width: explorerWidth }}
                            className="shrink-0 flex flex-col border-r border-gray-200"
                            onDragOver={(e) => {
                                e.preventDefault();
                                // Only show the upload overlay for external file drags, not internal moves
                                const isInternal =
                                    Array.from(e.dataTransfer.types).includes(
                                        "application/docket-doc",
                                    ) ||
                                    Array.from(e.dataTransfer.types).includes(
                                        "application/docket-folder",
                                    );
                                if (!isInternal) setExplorerDragOver(true);
                            }}
                            onDragLeave={(e) => {
                                if (
                                    !e.currentTarget.contains(
                                        e.relatedTarget as Node,
                                    )
                                )
                                    setExplorerDragOver(false);
                            }}
                            onDrop={handleExplorerFileDrop}
                        >
                            {/* Explorer header */}
                            <div className="h-10 flex items-center justify-between px-3 border-b border-gray-200 shrink-0">
                                <span className="text-xs text-gray-700">
                                    Explorer
                                </span>
                                <div className="flex items-center gap-1">
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.tiff,.bmp,.webp"
                                        multiple
                                        className="hidden"
                                        onChange={(e) =>
                                            uploadFiles(
                                                Array.from(
                                                    e.target.files ?? [],
                                                ),
                                            )
                                        }
                                    />
                                    <button
                                        onClick={() =>
                                            fileInputRef.current?.click()
                                        }
                                        disabled={uploading}
                                        title="Upload documents"
                                        className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
                                    >
                                        {uploading ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Upload className="h-3.5 w-3.5" />
                                        )}
                                    </button>
                                    <button
                                        onClick={() =>
                                            setExplorerCollapsed(true)
                                        }
                                        title="Collapse explorer"
                                        className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                                    >
                                        <ChevronLeft className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>

                            <div className="border-b border-gray-100 bg-white p-2 space-y-2 shrink-0">
                                <div className="relative">
                                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                                    <input
                                        value={explorerSearchQuery}
                                        onChange={(e) =>
                                            setExplorerSearchQuery(
                                                e.target.value,
                                            )
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                void submitExplorerSearch();
                                            }
                                        }}
                                        placeholder="Search document text"
                                        className="h-8 w-full rounded-lg border border-gray-200 pl-8 pr-8 text-xs text-gray-800 outline-none focus:border-gray-400"
                                    />
                                    {explorerSearchActive && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setExplorerSearchQuery("");
                                                setExplorerSearchActiveQuery(
                                                    "",
                                                );
                                                setExplorerSearchResults([]);
                                                setExplorerSearchError(null);
                                                setExplorerSearchPage(1);
                                            }}
                                            title="Clear search"
                                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    <select
                                        value={explorerSearchType}
                                        onChange={(e) =>
                                            setExplorerSearchType(
                                                e.target.value,
                                            )
                                        }
                                        className="h-8 min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-600 outline-none focus:border-gray-400"
                                        aria-label="Search type"
                                    >
                                        <option value="all">All types</option>
                                        <option value="pdf">PDF</option>
                                        <option value="docx">DOCX</option>
                                        <option value="doc">DOC</option>
                                        <option value="txt">TXT</option>
                                        <option value="md">MD</option>
                                    </select>
                                    <button
                                        type="button"
                                        disabled={
                                            explorerSearchLoading ||
                                            !explorerSearchQuery.trim()
                                        }
                                        onClick={() =>
                                            void submitExplorerSearch()
                                        }
                                        className="flex h-8 items-center gap-1 rounded-lg bg-gray-900 px-2.5 text-xs font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                                    >
                                        {explorerSearchLoading ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Search className="h-3.5 w-3.5" />
                                        )}
                                        Search
                                    </button>
                                </div>
                                {explorerSearchError && (
                                    <div className="text-xs text-red-600">
                                        {explorerSearchError}
                                    </div>
                                )}
                            </div>

                            {/* Drop overlay */}
                            <div
                                className={`flex-1 overflow-y-auto relative h-full ${explorerDragOver ? "bg-blue-50" : ""}`}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                }}
                                onDrop={async (e) => {
                                    e.preventDefault();
                                    const docId = e.dataTransfer.getData(
                                        "application/docket-doc",
                                    );
                                    const folderId = e.dataTransfer.getData(
                                        "application/docket-folder",
                                    );
                                    if (docId) {
                                        e.stopPropagation();
                                        await handleMoveDoc(docId, null);
                                    } else if (folderId) {
                                        e.stopPropagation();
                                        await handleMoveFolder(folderId, null);
                                    }
                                    // External file drops are not stopped — they bubble to handleExplorerFileDrop
                                }}
                            >
                                {explorerDragOver && (
                                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                                        <p className="text-xs text-blue-500 font-medium">
                                            Drop to upload
                                        </p>
                                    </div>
                                )}
                                {explorerSearchActive ? (
                                    <div className="p-2">
                                        <ProjectSourceSelector
                                            documents={project?.documents ?? []}
                                            deselectedDocIds={deselectedDocIds}
                                            onToggleAll={
                                                handleToggleAllSourceDocuments
                                            }
                                            onSelectBriefs={
                                                handleSelectBriefSources
                                            }
                                        />
                                        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-gray-500">
                                            <span>
                                                {explorerSearchResults.length >
                                                0
                                                    ? `${explorerSearchStartIndex + 1}-${explorerSearchEndIndex} of ${explorerSearchResults.length}`
                                                    : explorerSearchLoading
                                                      ? "Searching..."
                                                      : "0 results"}
                                            </span>
                                            {explorerSearchResults.length >
                                                0 && (
                                                <select
                                                    value={
                                                        explorerSearchPageSize
                                                    }
                                                    onChange={(e) => {
                                                        setExplorerSearchPageSize(
                                                            Number(
                                                                e.target.value,
                                                            ),
                                                        );
                                                        setExplorerSearchPage(
                                                            1,
                                                        );
                                                    }}
                                                    className="h-7 rounded border border-gray-200 bg-white px-1.5 text-xs text-gray-600 outline-none focus:border-gray-400"
                                                    aria-label="Search results per page"
                                                >
                                                    {CHAT_SEARCH_PAGE_SIZES.map(
                                                        (size) => (
                                                            <option
                                                                key={size}
                                                                value={size}
                                                            >
                                                                {size}
                                                            </option>
                                                        ),
                                                    )}
                                                </select>
                                            )}
                                        </div>
                                        <div className="divide-y divide-gray-100">
                                            {explorerSearchVisibleResults.map(
                                                (result) => (
                                                    <button
                                                        type="button"
                                                        key={result.chunk_id}
                                                        onClick={() =>
                                                            handleSearchResultClick(
                                                                result,
                                                            )
                                                        }
                                                        className="flex w-full items-start gap-2 py-2 text-left hover:bg-gray-50"
                                                    >
                                                        <AssistantSearchDocIcon
                                                            fileType={
                                                                result.file_type
                                                            }
                                                        />
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex flex-wrap items-center gap-1.5">
                                                                <span className="truncate text-xs font-medium text-gray-800">
                                                                    {
                                                                        result.filename
                                                                    }
                                                                </span>
                                                                {result.page_number ? (
                                                                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                                                                        p.{" "}
                                                                        {
                                                                            result.page_number
                                                                        }
                                                                    </span>
                                                                ) : null}
                                                                {result.grouped_chunk_count &&
                                                                result.grouped_chunk_count >
                                                                    1 ? (
                                                                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                                                                        {
                                                                            result.grouped_chunk_count
                                                                        }{" "}
                                                                        hits
                                                                    </span>
                                                                ) : null}
                                                                {(result
                                                                    .match_reasons
                                                                    ?.length
                                                                    ? result.match_reasons
                                                                    : result.basic_match
                                                                      ? ([
                                                                            "basic",
                                                                        ] as const)
                                                                      : ([
                                                                            "keyword",
                                                                        ] as const)
                                                                ).map(
                                                                    (
                                                                        reason,
                                                                    ) => (
                                                                        <span
                                                                            key={
                                                                                reason
                                                                            }
                                                                            className={`rounded px-1.5 py-0.5 text-[10px] ${searchReasonClass(
                                                                                reason,
                                                                            )}`}
                                                                        >
                                                                            {searchReasonLabel(
                                                                                reason,
                                                                            )}
                                                                        </span>
                                                                    ),
                                                                )}
                                                            </div>
                                                            <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-gray-500">
                                                                {renderAssistantSearchSnippet(
                                                                    result.snippet,
                                                                    explorerSearchDisplayQuery,
                                                                )}
                                                            </p>
                                                        </div>
                                                    </button>
                                                ),
                                            )}
                                        </div>
                                        {explorerSearchPageCount > 1 && (
                                            <div
                                                className="flex flex-wrap items-center gap-1 py-2 text-xs"
                                                aria-label="Search results pages"
                                            >
                                                {Array.from(
                                                    {
                                                        length: explorerSearchPageCount,
                                                    },
                                                    (_, index) => index + 1,
                                                ).map((page) => (
                                                    <button
                                                        type="button"
                                                        key={page}
                                                        onClick={() =>
                                                            setExplorerSearchPage(
                                                                page,
                                                            )
                                                        }
                                                        className={`h-7 min-w-7 rounded px-2 ${
                                                            page ===
                                                            safeExplorerSearchPage
                                                                ? "bg-gray-900 text-white"
                                                                : "text-gray-600 hover:bg-gray-100"
                                                        }`}
                                                        aria-current={
                                                            page ===
                                                            safeExplorerSearchPage
                                                                ? "page"
                                                                : undefined
                                                        }
                                                    >
                                                        {page}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <ProjectExplorer
                                        projectName={project?.name}
                                        documents={project?.documents ?? []}
                                        folders={project?.folders ?? []}
                                        selectedDocId={selectedDocId}
                                        selectable
                                        deselectedDocIds={deselectedDocIds}
                                        onToggleDoc={handleToggleSourceDocument}
                                        onToggleAll={
                                            handleToggleAllSourceDocuments
                                        }
                                        onToggleFolder={
                                            handleToggleFolderSourceDocuments
                                        }
                                        onSelectBriefs={
                                            handleSelectBriefSources
                                        }
                                        onDocClick={handleDocClick}
                                        onAnnotationClick={(doc, ann) => {
                                            openTab(
                                                doc.id,
                                                doc.filename,
                                                ann.quote
                                                    ? [
                                                          {
                                                              quote: ann.quote,
                                                              page: ann.page_number,
                                                          },
                                                      ]
                                                    : undefined,
                                                ann.version_id ?? null,
                                            );
                                            patchTab(doc.id, {
                                                focusAnnotationId: ann.id,
                                                focusAnnotationKey: Date.now(),
                                            });
                                        }}
                                        onCreateFolder={handleCreateFolder}
                                        onRenameFolder={handleRenameFolder}
                                        onDeleteFolder={handleDeleteFolder}
                                        onDeleteDoc={handleDeleteDoc}
                                        onMoveDoc={handleMoveDoc}
                                        onMoveFolder={handleMoveFolder}
                                    />
                                )}
                            </div>
                        </div>
                        <Divider onDrag={onExplorerDividerDrag} />
                    </>
                )}

                {/* Collapsed explorer toggle */}
                {explorerCollapsed && (
                    <div className="shrink-0 flex flex-col border-r border-gray-200">
                        <div className="h-10 flex items-center justify-center border-b border-gray-200 shrink-0 px-1">
                            <button
                                onClick={() => setExplorerCollapsed(false)}
                                title="Expand explorer"
                                className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                            >
                                <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                )}

                {/* CENTER: Document Panel */}
                <div className="flex-1 flex flex-col min-w-0 border-r border-gray-200">
                    {/* Tab bar */}
                    <div className="h-10 flex items-stretch border-b border-gray-200 shrink-0 min-w-0">
                        {tabs.length > 1 && (
                            <button
                                type="button"
                                data-session-check="project-doc-prev-tab"
                                title="Previous document tab"
                                aria-label="Previous document tab"
                                disabled={activeTabIndex <= 0}
                                onClick={() => switchTabByOffset(-1)}
                                className="relative z-10 flex w-9 shrink-0 items-center justify-center border-r border-gray-300 bg-gray-50 text-gray-700 shadow-sm transition-colors hover:bg-gray-200 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-300 disabled:shadow-none"
                            >
                                <ChevronLeft className="h-4 w-4 stroke-[2.5]" />
                            </button>
                        )}
                        <div
                            ref={tabBarRef}
                            data-session-check="project-doc-tab-strip"
                            className="flex min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                        >
                            {tabs.length === 0 ? (
                                <span className="px-4 self-center text-xs text-gray-700">
                                    Document Viewer
                                </span>
                            ) : (
                                tabs.map((tab) => {
                                    const isActive =
                                        tab.documentId === activeTabId;
                                    const ext = tab.filename
                                        .split(".")
                                        .pop()
                                        ?.toLowerCase();
                                    const iconColor =
                                        ext === "pdf"
                                            ? "text-red-500"
                                            : ext === "doc" || ext === "docx"
                                              ? "text-blue-500"
                                              : "text-gray-400";
                                    // Pull the doc's latest_version_number out
                                    // of the project state so the tab shows V#
                                    // whenever the doc has been edited.
                                    const versionNumber = (
                                        project?.documents ?? []
                                    ).find((d) => d.id === tab.documentId)
                                        ?.latest_version_number as
                                        number | null | undefined;
                                    const showVersionBadge =
                                        typeof versionNumber === "number" &&
                                        Number.isFinite(versionNumber) &&
                                        versionNumber > 1;
                                    return (
                                        <div
                                            key={tab.documentId}
                                            role="tab"
                                            aria-selected={isActive}
                                            data-session-check="project-doc-tab"
                                            data-document-id={tab.documentId}
                                            ref={(el) => {
                                                tabItemRefs.current[
                                                    tab.documentId
                                                ] = el;
                                            }}
                                            onClick={() =>
                                                switchTab(tab.documentId)
                                            }
                                            className={`group flex items-center gap-1.5 px-3 h-full border-r border-gray-200 cursor-pointer shrink-0 max-w-[260px] transition-colors ${
                                                isActive
                                                    ? "bg-gray-100"
                                                    : "bg-white hover:bg-gray-50"
                                            }`}
                                        >
                                            {typeof tab.renderProgress ===
                                                "number" &&
                                            tab.renderProgress < 1 ? (
                                                // Clockwise-filling pie: pages render
                                                // progressively, which reflows the
                                                // scrollbar — show that it's loading,
                                                // not glitching.
                                                <span
                                                    data-session-check="doc-tab-render-progress"
                                                    title={`Rendering pages… ${Math.round(tab.renderProgress * 100)}%`}
                                                    className="h-3.5 w-3.5 shrink-0 rounded-full"
                                                    style={{
                                                        background: `conic-gradient(#2563eb ${tab.renderProgress * 360}deg, #e5e7eb 0deg)`,
                                                    }}
                                                />
                                            ) : (
                                                <FileText
                                                    className={`h-3.5 w-3.5 shrink-0 ${iconColor}`}
                                                />
                                            )}
                                            <span
                                                className={`text-xs truncate ${isActive ? "text-gray-900 font-medium" : "text-gray-500"}`}
                                            >
                                                {tab.filename}
                                            </span>
                                            {showVersionBadge && (
                                                <span
                                                    className={`shrink-0 inline-flex items-center rounded border px-1 py-px text-[9px] font-medium ${
                                                        isActive
                                                            ? "border-gray-200 bg-white text-gray-600"
                                                            : "border-gray-200 bg-gray-50 text-gray-500"
                                                    }`}
                                                >
                                                    V{versionNumber}
                                                </span>
                                            )}
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    closeTab(tab.documentId);
                                                }}
                                                className={`shrink-0 transition-colors ${isActive ? "text-gray-500 hover:text-gray-700" : "text-gray-300 hover:text-gray-600"}`}
                                            >
                                                <X className="h-3 w-3" />
                                            </button>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                        {tabs.length > 1 && (
                            <button
                                type="button"
                                data-session-check="project-doc-next-tab"
                                title="Next document tab"
                                aria-label="Next document tab"
                                disabled={activeTabIndex >= tabs.length - 1}
                                onClick={() => switchTabByOffset(1)}
                                className="relative z-10 flex w-9 shrink-0 items-center justify-center border-l border-gray-300 bg-gray-50 text-gray-700 shadow-sm transition-colors hover:bg-gray-200 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-300 disabled:shadow-none"
                            >
                                <ChevronRight className="h-4 w-4 stroke-[2.5]" />
                            </button>
                        )}
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                        {activeTab ? (
                            isDocxTab(activeTab.filename) ? (
                                <DocxView
                                    key={activeTab.documentId}
                                    documentId={activeTab.documentId}
                                    versionId={activeTab.versionId}
                                    refetchKey={activeTab.refetchKey}
                                    quotes={activeQuotes ?? undefined}
                                    highlightEdit={
                                        editScrollTarget &&
                                        editScrollTarget.documentId ===
                                            activeTab.documentId
                                            ? editScrollTarget
                                            : null
                                    }
                                    onReady={() =>
                                        handleDocxReady(activeTab.documentId)
                                    }
                                    warning={activeTab.warning ?? null}
                                    onWarningDismiss={() =>
                                        dismissTabWarning(activeTab.documentId)
                                    }
                                    initialScrollTop={
                                        activeTab.scrollTop ?? null
                                    }
                                    onScrollChange={(top) =>
                                        handleTabScrollChange(
                                            activeTab.documentId,
                                            top,
                                        )
                                    }
                                    rounded={false}
                                    bordered={false}
                                />
                            ) : (
                                <DocView
                                    key={`${activeTab.documentId}:${activeTab.versionId ?? "current"}`}
                                    doc={{
                                        document_id: activeTab.documentId,
                                        version_id: activeTab.versionId ?? null,
                                    }}
                                    quotes={activeQuotes ?? undefined}
                                    citationNavigationKey={
                                        activeCitationNavigationKey
                                    }
                                    focusAnnotationId={
                                        activeTab.focusAnnotationId ?? null
                                    }
                                    focusAnnotationKey={
                                        activeTab.focusAnnotationKey
                                    }
                                    onRenderProgress={(rendered, total) =>
                                        patchTab(activeTab.documentId, {
                                            renderProgress:
                                                total > 0
                                                    ? rendered / total
                                                    : 1,
                                        })
                                    }
                                    rounded={false}
                                    bordered={false}
                                />
                            )
                        ) : (
                            <div className="flex items-center justify-center h-full px-8 bg-gray-100">
                                <div className="text-center space-y-3">
                                    <p className="font-serif text-gray-700 text-xl">
                                        Click on a document to display here.
                                    </p>
                                    <p className="font-serif text-base text-gray-500">
                                        Pro tip: Drag a document from the
                                        Project Explorer to the Assistant to
                                        direct it to read or edit.
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <Divider onDrag={onChatDividerDrag} />

                {/* RIGHT: Assistant Panel */}
                <div
                    style={{ width: chatWidth }}
                    className="shrink-0 flex flex-col"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleChatDrop}
                >
                    <div className="h-10 flex items-center gap-2 px-4 border-b border-gray-200 shrink-0">
                        <DocketIcon size={16} />
                        <span className="shrink-0 text-xs text-gray-700">
                            Project Assistant
                        </span>
                        <ProjectChatHistoryMenu
                            chats={projectChats}
                            currentChatId={chatId}
                            projectId={projectId}
                            currentTitle={chatTitle ?? "Untitled chat"}
                            currentUserId={user?.id}
                            creatingChat={creatingChat}
                            onNewChat={handleNewChat}
                            onOpenChat={(selectedChatId) =>
                                router.push(
                                    `/projects/${projectId}/assistant/chat/${selectedChatId}`,
                                )
                            }
                            onRenameChat={handleRenameProjectChat}
                            onDeleteChats={handleDeleteProjectChats}
                        />
                    </div>

                    {/* Messages / greeting / shimmer */}
                    {!chatLoaded ? (
                        <div className="flex-1 px-4 py-4 space-y-4">
                            <div className="flex justify-end">
                                <div className="bg-gray-100 rounded-2xl p-4 w-3/4">
                                    <div className="h-3 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                                </div>
                            </div>
                            <div className="space-y-2">
                                {[1, 2, 3].map((i) => (
                                    <div
                                        key={i}
                                        className={`h-3 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-4/6" : "w-full"}`}
                                    />
                                ))}
                            </div>
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="flex-1 flex flex-col min-h-0">
                            <AssistantGreeting username={username} />
                        </div>
                    ) : (
                        <div
                            ref={messagesContainerRef}
                            className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0"
                            style={{ scrollbarGutter: "stable" }}
                        >
                            {(() => {
                                const lastUserIdx = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("user");
                                const lastAssistantIdx = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("assistant");
                                return messages.map((msg, i) =>
                                    msg.role === "user" ? (
                                        <div
                                            key={i}
                                            ref={
                                                i === lastUserIdx
                                                    ? latestUserMessageRef
                                                    : null
                                            }
                                        >
                                            <UserMessage
                                                content={msg.content ?? ""}
                                                files={msg.files}
                                            />
                                        </div>
                                    ) : (
                                        <AssistantMessage
                                            key={i}
                                            content={msg.content ?? ""}
                                            events={msg.events}
                                            isStreaming={
                                                i === messages.length - 1 &&
                                                isResponseLoading
                                            }
                                            isError={!!msg.error}
                                            errorMessage={
                                                typeof msg.error === "string"
                                                    ? msg.error
                                                    : undefined
                                            }
                                            annotations={msg.annotations}
                                            onCitationClick={
                                                handleCitationClick
                                            }
                                            minHeight={
                                                i === lastAssistantIdx
                                                    ? minHeight
                                                    : "0px"
                                            }
                                            onEditViewClick={
                                                handleEditViewClick
                                            }
                                            onOpenDocument={handleOpenDocument}
                                            onEditResolved={handleEditResolved}
                                            onEditError={handleEditError}
                                            isDocReloading={(docId) =>
                                                reloadingDocIds.has(docId)
                                            }
                                        />
                                    ),
                                );
                            })()}
                            <div ref={messagesEndRef} />
                        </div>
                    )}

                    {/* ChatInput */}
                    <div className="shrink-0 px-4 pb-4">
                        <ChatInput
                            ref={chatInputRef}
                            onSubmit={handleSubmit}
                            onCancel={cancel}
                            isLoading={isResponseLoading}
                            projectMode
                            chatId={chatId}
                            projectId={projectId}
                            noSourcesSelected={noSourcesSelected}
                        />
                    </div>
                </div>
            </div>
            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}
