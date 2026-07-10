"use client";

import { ListTree, Loader2, PanelLeftClose, PanelLeftOpen } from "lucide-react";

export type DocumentNavigationItem = {
    id: string;
    title: string;
    level: number;
    page?: number;
};

interface Props {
    items: DocumentNavigationItem[];
    open: boolean;
    activeId?: string | null;
    onOpenChange: (open: boolean) => void;
    onSelect: (item: DocumentNavigationItem) => void;
    /**
     * When the document has no built-in bookmarks, keeps the pane visible
     * with a button that builds an outline from the document structure.
     */
    onGenerate?: () => void;
    generating?: boolean;
    /** Feedback after a generate attempt (e.g. "No headings detected"). */
    generateMessage?: string | null;
}

export function DocumentNavigationPane({
    items,
    open,
    activeId,
    onOpenChange,
    onSelect,
    onGenerate,
    generating = false,
    generateMessage,
}: Props) {
    if (!items.length && !onGenerate) return null;

    return (
        <div className="relative flex shrink-0">
            {open ? (
                <aside
                    data-session-check="document-nav-pane"
                    className="flex w-56 shrink-0 flex-col border-r border-gray-200 bg-white"
                >
                    <div className="flex h-10 shrink-0 items-center justify-between border-b border-gray-100 px-3">
                        <span className="truncate text-xs font-medium text-gray-600">
                            Outline
                        </span>
                        <button
                            type="button"
                            data-session-check="document-nav-toggle-close"
                            onClick={() => onOpenChange(false)}
                            className="flex h-7 w-7 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                            title="Hide outline"
                            aria-label="Hide outline"
                        >
                            <PanelLeftClose className="h-4 w-4" />
                        </button>
                    </div>
                    {items.length === 0 && onGenerate && (
                        <div className="flex flex-col gap-2 px-3 py-4 text-xs text-gray-500">
                            <p>
                                {generateMessage ??
                                    "This document has no built-in bookmarks."}
                            </p>
                            <button
                                type="button"
                                data-session-check="document-nav-generate"
                                onClick={onGenerate}
                                disabled={generating}
                                className="flex items-center justify-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1.5 font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:cursor-default disabled:opacity-60"
                            >
                                {generating ? (
                                    <>
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Analyzing document…
                                    </>
                                ) : (
                                    <>
                                        <ListTree className="h-3.5 w-3.5" />
                                        Generate outline
                                    </>
                                )}
                            </button>
                        </div>
                    )}
                    <nav className="min-h-0 flex-1 overflow-auto px-2 py-2">
                        {items.map((item) => {
                            const active = item.id === activeId;
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    data-session-check="document-nav-item"
                                    data-nav-id={item.id}
                                    data-nav-title={item.title}
                                    onClick={() => onSelect(item)}
                                    className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs leading-snug transition-colors ${
                                        active
                                            ? "bg-gray-900 text-white"
                                            : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                                    }`}
                                    style={{
                                        paddingLeft: `${8 + Math.max(0, item.level - 1) * 12}px`,
                                    }}
                                    title={item.title}
                                >
                                    <span className="min-w-0 flex-1 truncate">
                                        {item.title}
                                    </span>
                                    {typeof item.page === "number" && (
                                        <span
                                            className={`shrink-0 tabular-nums ${
                                                active
                                                    ? "text-white/70"
                                                    : "text-gray-400"
                                            }`}
                                        >
                                            {item.page}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </nav>
                </aside>
            ) : (
                <button
                    type="button"
                    data-session-check="document-nav-toggle-open"
                    onClick={() => onOpenChange(true)}
                    className="absolute left-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white/95 text-gray-500 shadow-sm transition-colors hover:bg-white hover:text-gray-900"
                    title="Show outline"
                    aria-label="Show outline"
                >
                    <PanelLeftOpen className="h-4 w-4" />
                </button>
            )}
        </div>
    );
}
