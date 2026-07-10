"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { createChat } from "@/app/lib/docketApi";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useDirectoryData } from "../shared/useDirectoryData";
import { ProjectPicker } from "../shared/ProjectPicker";

interface Props {
    open: boolean;
    onClose: () => void;
}

export function SelectAssistantProjectModal({ open, onClose }: Props) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();
    const { loadChats } = useChatHistoryContext();
    const {
        loading,
        projects,
        error: directoryError,
        refresh,
    } = useDirectoryData(open);

    useEffect(() => {
        if (!open) return;
        setSelectedId(null);
        setError(null);
    }, [open]);

    if (!open) return null;

    // Clicking a project creates a fresh chat there and jumps straight to
    // the project assistant screen — no separate confirm step. Calls the
    // API directly (not context saveChat, which swallows the failure
    // reason) so the server's error detail can be shown.
    async function startChatInProject(projectId: string) {
        if (creating) return;
        setSelectedId(projectId);
        setCreating(true);
        setError(null);
        try {
            const { id: chatId } = await createChat({
                project_id: projectId,
            });
            void loadChats();
            onClose();
            router.push(`/projects/${projectId}/assistant/chat/${chatId}`);
        } catch (e) {
            const detail =
                e instanceof Error && e.message
                    ? e.message
                    : "Failed to start a chat in this project.";
            setError(detail);
        } finally {
            setCreating(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/10 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <span>Assistant</span>
                        <span>›</span>
                        <span>Start Chat in a Project</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {directoryError && !loading ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4">
                        <p className="text-sm text-red-600">
                            {directoryError}
                        </p>
                        <button
                            type="button"
                            onClick={refresh}
                            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
                        >
                            Retry
                        </button>
                    </div>
                ) : (
                    <ProjectPicker
                        projects={projects}
                        loading={loading}
                        selectedId={selectedId}
                        onSelect={(id) => {
                            if (id) void startChatInProject(id);
                        }}
                    />
                )}

                {/* Footer */}
                <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-end gap-2">
                    {error && (
                        <span className="mr-auto text-sm text-red-600">
                            {error}
                        </span>
                    )}
                    {creating && (
                        <span className="flex items-center gap-2 text-sm text-gray-500">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Opening project chat…
                        </span>
                    )}
                    <button
                        onClick={onClose}
                        disabled={creating}
                        className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
