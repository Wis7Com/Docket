"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderOpen, ChevronDown, Loader2 } from "lucide-react";
import { HeaderSearchBtn } from "@/app/components/shared/HeaderSearchBtn";
import {
    listProjects,
    updateProject,
    deleteProject,
    openProjectFolder,
} from "@/app/lib/docketApi";
import type { DocketProject } from "@/app/components/shared/types";
import { ToolbarTabs } from "@/app/components/shared/ToolbarTabs";
import { RowActions } from "@/app/components/shared/RowActions";

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

const CHECK_W = "w-8 shrink-0";
const NAME_COL_W = "w-[300px] shrink-0";

export function ProjectsOverview() {
    const [projects, setProjects] = useState<DocketProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [cmEditingId, setCmEditingId] = useState<string | null>(null);
    const [cmValue, setCmValue] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [openFolderBusy, setOpenFolderBusy] = useState(false);
    const [openFolderError, setOpenFolderError] = useState<string | null>(null);
    const actionsRef = useRef<HTMLDivElement>(null);
    const router = useRouter();

    useEffect(() => {
        listProjects()
            .then(setProjects)
            .catch(() => setProjects([]))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            )
                setActionsOpen(false);
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    const q = search.toLowerCase();
    const filtered = projects.filter(
        (p) =>
            !q ||
            p.name.toLowerCase().includes(q) ||
            (p.cm_number ?? "").toLowerCase().includes(q),
    );

    const allSelected =
        filtered.length > 0 &&
        filtered.every((p) => selectedIds.includes(p.id));
    const someSelected =
        !allSelected && filtered.some((p) => selectedIds.includes(p.id));

    function toggleAll() {
        if (allSelected) {
            setSelectedIds([]);
        } else {
            setSelectedIds(filtered.map((p) => p.id));
        }
    }

    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    async function handleRenameSubmit(projectId: string) {
        const trimmed = renameValue.trim();
        setRenamingId(null);
        if (!trimmed) return;
        setProjects((prev) =>
            prev.map((p) => (p.id === projectId ? { ...p, name: trimmed } : p)),
        );
        await updateProject(projectId, { name: trimmed });
    }

    async function handleCmSubmit(projectId: string) {
        const trimmed = cmValue.trim();
        setCmEditingId(null);
        setProjects((prev) =>
            prev.map((p) =>
                p.id === projectId ? { ...p, cm_number: trimmed || null } : p,
            ),
        );
        await updateProject(projectId, { cm_number: trimmed || undefined });
    }

    async function handleDeleteSelected() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        setSelectedIds([]);
        await Promise.all(ids.map((id) => deleteProject(id).catch(() => {})));
        setProjects((prev) => prev.filter((p) => !ids.includes(p.id)));
    }

    async function handleOpenFolder() {
        const bridge =
            typeof window !== "undefined"
                ? (window.docket as
                      | {
                            pickSourceFolder?: () => Promise<{
                                ok: boolean;
                                path?: string;
                                error?: string;
                            }>;
                        }
                      | undefined)
                : undefined;
        if (!bridge?.pickSourceFolder || openFolderBusy) return;
        setOpenFolderError(null);
        const picked = await bridge.pickSourceFolder();
        if (!picked.ok || !picked.path) {
            if (picked.error) setOpenFolderError(picked.error);
            return;
        }
        setOpenFolderBusy(true);
        try {
            const project = await openProjectFolder(picked.path);
            setProjects((prev) => [project, ...prev]);
            router.push(`/projects/${project.id}`);
        } catch (err) {
            setOpenFolderError(
                (err as Error).message || "Could not open project folder",
            );
        } finally {
            setOpenFolderBusy(false);
        }
    }

    const toolbarActions = (
        <div className="flex items-center gap-2">
            {selectedIds.length > 0 && (
                <div ref={actionsRef} className="relative">
                    <button
                        onClick={() => setActionsOpen((v) => !v)}
                        className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900 transition-colors"
                    >
                        Actions
                        <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    {actionsOpen && (
                        <div className="absolute top-full right-0 mt-1 w-36 rounded-lg border border-gray-100 bg-white shadow-lg z-50 overflow-hidden">
                            <button
                                onClick={handleDeleteSelected}
                                className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                            >
                                Delete
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );

    return (
        <div className="flex-1 overflow-y-auto bg-white">
            {/* Page header */}
            <div className="flex items-center justify-between px-8 py-4">
                <h1 className="text-2xl font-medium font-serif text-gray-900">
                    Projects
                </h1>
                <div className="flex items-center gap-2">
                    <HeaderSearchBtn
                        value={search}
                        onChange={setSearch}
                        placeholder="Search projects…"
                    />
                    <button
                        onClick={handleOpenFolder}
                        disabled={openFolderBusy}
                        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {openFolderBusy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <FolderOpen className="h-4 w-4" />
                        )}
                        Open Folder
                    </button>
                </div>
            </div>

            {/* This app is single-user; no All/Mine/Shared-with-me split.
                Keep the toolbar row for the bulk-actions dropdown. */}
            <ToolbarTabs
                tabs={[]}
                active=""
                onChange={() => {}}
                actions={toolbarActions}
            />

            {openFolderError && (
                <div className="px-8 py-2 text-xs text-red-600">
                    {openFolderError}
                </div>
            )}

            {/* Table */}
            <div className="w-full overflow-x-auto">
                <div className="min-w-max">
                    {/* Column headers */}
                    <div className="flex items-center h-8 pr-8 border-b border-gray-200 text-xs text-gray-500 font-medium select-none">
                        <div
                            className={`sticky left-0 z-[60] ${CHECK_W} relative bg-white flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-white`}
                        >
                            {!loading && (
                                <input
                                    type="checkbox"
                                    checked={allSelected}
                                    ref={(el) => {
                                        if (el) el.indeterminate = someSelected;
                                    }}
                                    onChange={toggleAll}
                                    className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                />
                            )}
                        </div>
                        <div
                            className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white pl-2 text-left`}
                        >
                            Name
                        </div>
                        <div className="ml-auto w-32 shrink-0 text-left">
                            CM
                        </div>
                        <div className="w-24 shrink-0 text-left">Files</div>
                        <div className="w-24 shrink-0 text-left">Chats</div>
                        <div className="w-36 shrink-0 text-left">
                            Tabular Reviews
                        </div>
                        <div className="w-32 shrink-0 text-left">Created</div>
                        <div className="w-8 shrink-0" />
                    </div>

                    {loading ? (
                        <div>
                            {[1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className="flex items-center h-10 pr-8 border-b border-gray-50"
                                >
                                    <div className="w-8 shrink-0" />
                                    <div className="flex-1 min-w-0 pl-3 pr-4">
                                        <div className="h-3.5 w-48 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                    <div className="w-32 shrink-0">
                                        <div className="h-3 w-20 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                    <div className="w-24 shrink-0">
                                        <div className="h-3 w-8 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                    <div className="w-24 shrink-0">
                                        <div className="h-3 w-8 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                    <div className="w-36 shrink-0">
                                        <div className="h-3 w-8 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                    <div className="w-32 shrink-0">
                                        <div className="h-3 w-20 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                    <div className="w-8 shrink-0" />
                                </div>
                            ))}
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                            <FolderOpen className="h-8 w-8 text-gray-300 mb-4" />
                            <p className="text-2xl font-medium font-serif text-gray-900">
                                Projects
                            </p>
                            <p className="mt-1 text-xs text-gray-400 max-w-xs">
                                Open a local folder to use it as a project.
                            </p>
                            <button
                                onClick={handleOpenFolder}
                                disabled={openFolderBusy}
                                className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-300 transition-colors shadow-md"
                            >
                                {openFolderBusy ? "Opening..." : "Open Folder"}
                            </button>
                        </div>
                    ) : (
                        <div>
                            {filtered.map((project) => {
                                const rowBg = selectedIds.includes(project.id)
                                    ? "bg-gray-50"
                                    : "bg-white";
                                return (
                                    <div
                                        key={project.id}
                                        onClick={() => {
                                            if (renamingId === project.id)
                                                return;
                                            router.push(
                                                `/projects/${project.id}`,
                                            );
                                        }}
                                        className="group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                                    >
                                        <div
                                            className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${rowBg} group-hover:bg-gray-50`}
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.includes(
                                                    project.id,
                                                )}
                                                onChange={() =>
                                                    toggleOne(project.id)
                                                }
                                                className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                            />
                                        </div>

                                        {/* Project Name */}
                                        <div
                                            className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${rowBg} group-hover:bg-gray-50`}
                                        >
                                            {renamingId === project.id ? (
                                                <input
                                                    autoFocus
                                                    value={renameValue}
                                                    onChange={(e) =>
                                                        setRenameValue(
                                                            e.target.value,
                                                        )
                                                    }
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter")
                                                            handleRenameSubmit(
                                                                project.id,
                                                            );
                                                        if (e.key === "Escape")
                                                            setRenamingId(null);
                                                    }}
                                                    onBlur={() =>
                                                        handleRenameSubmit(
                                                            project.id,
                                                        )
                                                    }
                                                    onClick={(e) =>
                                                        e.stopPropagation()
                                                    }
                                                    className="w-full text-sm text-gray-800 bg-transparent outline-none"
                                                />
                                            ) : (
                                                <span className="text-sm text-gray-800 truncate block">
                                                    {project.name}
                                                </span>
                                            )}
                                        </div>

                                        <div
                                            className="ml-auto w-32 shrink-0 text-sm text-gray-500 truncate"
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            {cmEditingId === project.id ? (
                                                <input
                                                    autoFocus
                                                    value={cmValue}
                                                    onChange={(e) =>
                                                        setCmValue(
                                                            e.target.value,
                                                        )
                                                    }
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter")
                                                            handleCmSubmit(
                                                                project.id,
                                                            );
                                                        if (e.key === "Escape")
                                                            setCmEditingId(
                                                                null,
                                                            );
                                                    }}
                                                    onBlur={() =>
                                                        handleCmSubmit(
                                                            project.id,
                                                        )
                                                    }
                                                    placeholder="CM #"
                                                    className="w-full text-sm text-gray-800 bg-transparent outline-none"
                                                />
                                            ) : (
                                                (project.cm_number ?? (
                                                    <span className="text-gray-300">
                                                        —
                                                    </span>
                                                ))
                                            )}
                                        </div>
                                        <div className="w-24 shrink-0 text-sm text-gray-500 truncate">
                                            {project.document_count ?? 0}
                                        </div>
                                        <div className="w-24 shrink-0 text-sm text-gray-500 truncate">
                                            {project.chat_count ?? 0}
                                        </div>
                                        <div className="w-36 shrink-0 text-sm text-gray-500 truncate">
                                            {project.review_count ?? 0}
                                        </div>
                                        <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                                            {formatDate(project.created_at)}
                                        </div>

                                        <div
                                            className="w-8 shrink-0 flex justify-end"
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            <RowActions
                                                onRename={() => {
                                                    setRenameValue(
                                                        project.name,
                                                    );
                                                    setRenamingId(project.id);
                                                }}
                                                onUpdateCmNumber={() => {
                                                    setCmValue(
                                                        project.cm_number ?? "",
                                                    );
                                                    setCmEditingId(project.id);
                                                }}
                                                onDelete={async () => {
                                                    await deleteProject(
                                                        project.id,
                                                    );
                                                    setProjects((prev) =>
                                                        prev.filter(
                                                            (p) =>
                                                                p.id !==
                                                                project.id,
                                                        ),
                                                    );
                                                }}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
