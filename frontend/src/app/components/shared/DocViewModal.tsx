"use client";

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Download, Maximize2, Minus, Trash2, X } from "lucide-react";
import { DocView } from "./DocView";
import { getDocumentUrl } from "@/app/lib/docketApi";
import type { DocketDocument } from "./types";

interface Props {
    doc: DocketDocument | null;
    /** Optional specific version to display. Only honoured for DOCX. */
    versionId?: string | null;
    /** Optional label suffix for the header (e.g. "V3"). */
    versionLabel?: string | null;
    /** Optional quote/page target to reveal when opening from search. */
    initialSearchQuote?: string | null;
    initialSearchPage?: number | null;
    initialSearchKey?: string | null;
    onClose: () => void;
    onDelete?: (doc: DocketDocument) => void;
}

export function DocViewModal({
    doc,
    versionId,
    versionLabel,
    initialSearchQuote,
    initialSearchPage,
    initialSearchKey,
    onClose,
    onDelete,
}: Props) {
    const [mounted, setMounted] = useState(false);
    const [position, setPosition] = useState<{ x: number; y: number } | null>(
        null,
    );
    const viewKey = `${doc?.id ?? ""}:${versionId ?? "current"}:${initialSearchKey ?? ""}`;
    const [minimizedViewKey, setMinimizedViewKey] = useState<string | null>(null);
    const isMinimized = minimizedViewKey === viewKey;
    const panelRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
    } | null>(null);

    useEffect(() => {
        const id = window.requestAnimationFrame(() => setMounted(true));
        return () => window.cancelAnimationFrame(id);
    }, []);

    const handleHeaderPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            const rect = panelRef.current?.getBoundingClientRect();
            if (!rect) return;
            event.preventDefault();
            const origin = { x: rect.left, y: rect.top };
            setPosition(origin);
            dragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originX: origin.x,
                originY: origin.y,
            };

            const handlePointerMove = (moveEvent: PointerEvent) => {
                const drag = dragRef.current;
                if (!drag || moveEvent.pointerId !== drag.pointerId) return;
                setPosition({
                    x: drag.originX + moveEvent.clientX - drag.startX,
                    y: drag.originY + moveEvent.clientY - drag.startY,
                });
            };
            const handlePointerUp = (upEvent: PointerEvent) => {
                const drag = dragRef.current;
                if (drag && upEvent.pointerId !== drag.pointerId) return;
                dragRef.current = null;
                window.removeEventListener("pointermove", handlePointerMove);
                window.removeEventListener("pointerup", handlePointerUp);
                window.removeEventListener("pointercancel", handlePointerUp);
            };

            window.addEventListener("pointermove", handlePointerMove);
            window.addEventListener("pointerup", handlePointerUp);
            window.addEventListener("pointercancel", handlePointerUp);
        },
        [],
    );

    if (!doc || !mounted) return null;

    const normalizedSearchQuote = initialSearchQuote?.trim() ?? "";
    const searchQuotes = normalizedSearchQuote
        ? [
              {
                  quote: normalizedSearchQuote,
                  page: initialSearchPage ?? undefined,
              },
          ]
        : undefined;

    async function handleDownload() {
        if (!doc) return;
        const { url, filename } = await getDocumentUrl(doc.id, versionId ?? null);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
    }

    return createPortal(
        <div
            data-session-check="doc-view-modal"
            className="pointer-events-none fixed inset-0 z-100"
        >
            <div
                ref={panelRef}
                className={`pointer-events-auto fixed flex flex-col bg-white rounded-xl shadow-2xl border border-gray-200 ${
                    isMinimized
                        ? "w-[420px] max-w-[calc(100vw-16px)]"
                        : "w-[800px] max-w-[90vw] h-[90vh]"
                }`}
                style={
                    position
                        ? { left: position.x, top: position.y }
                        : { left: "50%", top: "5vh", transform: "translateX(-50%)" }
                }
            >
                {/* Header */}
                <div
                    className="flex cursor-move touch-none select-none items-center justify-between px-5 py-3 shrink-0"
                    onPointerDown={handleHeaderPointerDown}
                >
                    <span className="text-base font-medium font-serif text-gray-800 truncate pr-4">
                        {doc.filename}
                        {versionLabel && (
                            <span className="ml-2 text-xs font-normal text-gray-500">
                                {versionLabel}
                            </span>
                        )}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                        <button
                            onClick={handleDownload}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="flex items-center justify-center w-6 h-6 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
                            title="Download"
                        >
                            <Download className="h-4 w-4" />
                        </button>
                        {onDelete && (
                            <button
                                onClick={() => { onDelete(doc); onClose(); }}
                                onPointerDown={(e) => e.stopPropagation()}
                                className="flex items-center justify-center w-6 h-6 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                                title="Delete"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        )}
                        <button
                            onClick={() =>
                                setMinimizedViewKey((value) =>
                                    value === viewKey ? null : viewKey,
                                )
                            }
                            onPointerDown={(e) => e.stopPropagation()}
                            className="flex items-center justify-center w-6 h-6 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
                            title={isMinimized ? "Restore" : "Minimize"}
                        >
                            {isMinimized ? (
                                <Maximize2 className="h-4 w-4" />
                            ) : (
                                <Minus className="h-4 w-4" />
                            )}
                        </button>
                        <button
                            onClick={onClose}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="flex items-center justify-center w-6 h-6 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
                            title="Close"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* DocView serves PDF when available and falls back to
                    docx-preview internally if the active version has no
                    PDF rendition. Passing no versionId tells the backend
                    to resolve the latest tracked-changes version. */}
                <div
                    className={`flex flex-col flex-1 overflow-hidden px-3 pb-3 ${
                        isMinimized ? "hidden" : ""
                    }`}
                >
                    <DocView
                        key={`${versionId ?? "current"}:${initialSearchKey ?? ""}`}
                        doc={{
                            document_id: doc.id,
                            version_id: versionId ?? null,
                        }}
                        quotes={searchQuotes}
                        quote={normalizedSearchQuote || undefined}
                        fallbackPage={initialSearchPage ?? undefined}
                    />
                </div>
            </div>
        </div>,
        document.body,
    );
}
