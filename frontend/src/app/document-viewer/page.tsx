"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, MessageSquarePlus, Minus, X } from "lucide-react";
import { DocView } from "@/app/components/shared/DocView";
import { createChat, getDocumentUrl } from "@/app/lib/docketApi";

type ViewerBridge = {
    minimizeDocumentViewer?: () => Promise<unknown>;
    closeDocumentViewer?: () => Promise<unknown>;
    openMainRoute?: (payload: {
        path: string;
    }) => Promise<{ ok?: boolean; error?: string } | void>;
};

function viewerBridge(): ViewerBridge | undefined {
    if (typeof window === "undefined") return undefined;
    return window.docket as ViewerBridge | undefined;
}

function DocumentViewerContent() {
    const params = useSearchParams();
    const documentId = params.get("document_id") ?? "";
    const filename = params.get("filename") ?? "Document";
    const versionId = params.get("version_id");
    const versionLabel = params.get("version_label");
    const searchQuote = params.get("search_quote")?.trim() ?? "";
    const searchPageValue = params.get("search_page");
    const searchPage = searchPageValue ? Number(searchPageValue) : null;
    const annotationId = params.get("annotation_id")?.trim() || null;
    const projectId = params.get("project_id")?.trim() || null;
    const [renderProgress, setRenderProgress] = useState<number | null>(null);
    const [chatBusy, setChatBusy] = useState(false);
    const [chatError, setChatError] = useState<string | null>(null);

    const searchQuotes = searchQuote
        ? [
              {
                  quote: searchQuote,
                  page:
                      searchPage != null && Number.isFinite(searchPage)
                          ? searchPage
                          : undefined,
              },
          ]
        : undefined;

    async function handleDownload() {
        if (!documentId) return;
        const { url, filename: resolvedFilename } = await getDocumentUrl(
            documentId,
            versionId,
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = resolvedFilename;
        a.click();
    }

    // Create a fresh project chat and hand navigation to the main app
    // window; the viewer window stays open next to it.
    async function handleOpenChat() {
        if (!projectId || chatBusy) return;
        setChatBusy(true);
        setChatError(null);
        try {
            const { id } = await createChat({ project_id: projectId });
            const path = `/projects/${projectId}/assistant/chat/${id}`;
            const bridge = viewerBridge();
            if (bridge?.openMainRoute) {
                const result = await bridge.openMainRoute({ path });
                if (result && result.ok === false) {
                    throw new Error(result.error || "Failed to open chat.");
                }
                return;
            }
            window.open(path, "_blank");
        } catch (err) {
            console.error("Failed to open chat from viewer:", err);
            setChatError(
                err instanceof Error ? err.message : "Failed to open chat.",
            );
        } finally {
            setChatBusy(false);
        }
    }

    function handleMinimize() {
        void viewerBridge()?.minimizeDocumentViewer?.();
    }

    function handleClose() {
        const bridge = viewerBridge();
        if (bridge?.closeDocumentViewer) {
            void bridge.closeDocumentViewer();
            return;
        }
        window.close();
    }

    if (!documentId) {
        return (
            <main className="flex h-screen items-center justify-center bg-gray-50 text-sm text-gray-500">
                No document selected.
            </main>
        );
    }

    return (
        <main className="flex h-screen flex-col overflow-hidden bg-white">
            <header className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-3">
                <div className="flex min-w-0 items-center gap-2">
                    {renderProgress != null && renderProgress < 1 && (
                        // Clockwise-filling pie: pages render progressively,
                        // which reflows the scrollbar — show that it's
                        // loading, not glitching.
                        <span
                            title={`Rendering pages… ${Math.round(renderProgress * 100)}%`}
                            className="h-3.5 w-3.5 shrink-0 rounded-full"
                            style={{
                                background: `conic-gradient(#2563eb ${renderProgress * 360}deg, #e5e7eb 0deg)`,
                            }}
                        />
                    )}
                    <div className="truncate font-serif text-base font-medium text-gray-800">
                        {filename}
                        {versionLabel && (
                            <span className="ml-2 text-xs font-normal text-gray-500">
                                {versionLabel}
                            </span>
                        )}
                    </div>
                </div>
                <div className="ml-4 flex shrink-0 items-center gap-1">
                    {chatError && (
                        <span
                            className="max-w-[220px] truncate text-xs text-red-600"
                            title={chatError}
                        >
                            {chatError}
                        </span>
                    )}
                    {projectId && (
                        <button
                            type="button"
                            data-session-check="viewer-open-chat"
                            onClick={() => {
                                void handleOpenChat();
                            }}
                            disabled={chatBusy}
                            className="flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40"
                            title="Start a new project chat"
                        >
                            <MessageSquarePlus className="h-4 w-4" />
                            Chat
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={handleDownload}
                        className="flex h-7 w-7 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                        title="Download"
                    >
                        <Download className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={handleMinimize}
                        className="flex h-7 w-7 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                        title="Minimize"
                    >
                        <Minus className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={handleClose}
                        className="flex h-7 w-7 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                        title="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            </header>
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
                <DocView
                    key={`${versionId ?? "current"}:${params.get("search_key") ?? ""}`}
                    doc={{
                        document_id: documentId,
                        version_id: versionId ?? null,
                    }}
                    quotes={searchQuotes}
                    quote={searchQuote || undefined}
                    focusAnnotationId={annotationId}
                    onRenderProgress={(rendered, total) =>
                        setRenderProgress(total > 0 ? rendered / total : 1)
                    }
                    fallbackPage={
                        searchPage != null && Number.isFinite(searchPage)
                            ? searchPage
                            : undefined
                    }
                />
            </section>
        </main>
    );
}

export default function DocumentViewerPage() {
    return (
        <Suspense
            fallback={
                <main className="flex h-screen items-center justify-center bg-gray-50 text-sm text-gray-500">
                    Loading document...
                </main>
            }
        >
            <DocumentViewerContent />
        </Suspense>
    );
}
