"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Upload,
  Plus,
  Loader2,
  FileText,
  File,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Download,
  Database,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Table2,
  Trash2,
  Users,
  X,
  Search,
} from "lucide-react";
import { HeaderSearchBtn } from "@/app/components/shared/HeaderSearchBtn";
import {
  getProject,
  getProjectRegistry,
  deleteDocument,
  createTabularReview,
  updateProject,
  listProjectChats,
  deleteChat,
  renameChat,
  listTabularReviews,
  deleteTabularReview,
  updateTabularReview,
  getDocumentUrl,
  createProjectFolder,
  renameProjectFolder,
  deleteProjectFolder,
  moveDocumentToFolder,
  moveSubfolderToFolder,
  listDocumentVersions,
  renameDocumentVersion,
  listPdfAnnotations,
  deletePdfAnnotation,
  exportAnnotatedPdf,
  rescanDocument,
  getProjectPeople,
  addProjectSourceFolder,
  listProjectSourceFolders,
  rescanProjectSourceFolder,
  getProjectIndexStatus,
  ensureProjectIndexCurrent,
  rebuildProjectIndex,
  compactProjectDatabase,
  cancelProjectIndex,
  startProjectEmbedding,
  pauseProjectEmbedding,
  searchProjectDocuments,
  type DocketDocumentVersion,
  type ProjectIndexStatus,
  type ProjectSearchResult,
  type DocketSourceFolder,
  type DocketSourceFolderScanResult,
} from "@/app/lib/docketApi";
import { clearLocalSessionCache } from "@/lib/supabase";
import type {
  DocketDocument,
  DocketFolder,
  DocketProject,
  DocketChat,
  PdfAnnotation,
  TabularReview,
  ColumnConfig,
} from "@/app/components/shared/types";
import { ToolbarTabs } from "@/app/components/shared/ToolbarTabs";
import { RenameableTitle } from "@/app/components/shared/RenameableTitle";
import { RowActions } from "@/app/components/shared/RowActions";
import { AddDocumentsModal } from "@/app/components/shared/AddDocumentsModal";
import { PeopleModal } from "@/app/components/shared/PeopleModal";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { useAuth } from "@/contexts/AuthContext";
import { DocViewModal } from "@/app/components/shared/DocViewModal";
import { AddNewTRModal } from "@/app/components/tabular/AddNewTRModal";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";

interface Props {
  projectId: string;
}

type Tab = "documents" | "assistant" | "reviews";

type ContextMenu = {
  x: number;
  y: number;
  folderId: string | null; // null = right-clicked on root/empty space
  showFolderActions: boolean; // true when right-clicked on a specific folder row
};

const CHECK_W = "w-8 shrink-0";
const NAME_COL_W = "w-[300px] shrink-0";
const PROJECT_SEARCH_RESULT_LIMIT = 200;
const PROJECT_SEARCH_PAGE_SIZES = [10, 25, 50] as const;

type SearchDocTarget = {
  quote: string;
  page: number | null;
  key: string;
};

type DocumentViewerPayload = {
  documentId: string;
  filename: string;
  versionId?: string | null;
  versionLabel?: string | null;
  searchQuote?: string | null;
  searchPage?: number | null;
  searchKey?: string | null;
  annotationId?: string | null;
  projectId?: string | null;
};

type DocumentViewerBridge = {
  openDocumentViewer?: (
    payload: DocumentViewerPayload,
  ) => Promise<{ ok?: boolean; error?: string } | void>;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function documentViewerPath(payload: DocumentViewerPayload): string {
  const params = new URLSearchParams();
  params.set("document_id", payload.documentId);
  params.set("filename", payload.filename);
  if (payload.versionId) params.set("version_id", payload.versionId);
  if (payload.versionLabel) params.set("version_label", payload.versionLabel);
  if (payload.searchQuote) params.set("search_quote", payload.searchQuote);
  if (
    typeof payload.searchPage === "number" &&
    Number.isFinite(payload.searchPage)
  ) {
    params.set("search_page", String(payload.searchPage));
  }
  if (payload.searchKey) params.set("search_key", payload.searchKey);
  if (payload.annotationId) params.set("annotation_id", payload.annotationId);
  if (payload.projectId) params.set("project_id", payload.projectId);
  return `/document-viewer?${params.toString()}`;
}

function DocIcon({ fileType }: { fileType: string | null }) {
  if (fileType === "pdf")
    return <FileText className="h-4 w-4 text-red-600 shrink-0" />;
  if (fileType === "docx" || fileType === "doc")
    return <File className="h-4 w-4 text-blue-600 shrink-0" />;
  if (fileType === "md" || fileType === "txt")
    return <FileText className="h-4 w-4 text-emerald-600 shrink-0" />;
  return <File className="h-4 w-4 text-gray-500 shrink-0" />;
}

function escapeRegExp(value: string) {
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
      .map((term) => `${escapeRegExp(term)}(?:['’]s)?`)
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
    if (ranges.length > 0) {
      return ranges.sort((a, b) => a.start - b.start);
    }
  }

  const highlightTerms = terms
    .filter((part) => part.length >= 2)
    .sort((a, b) => b.length - a.length);

  for (const term of highlightTerms) {
    const termRegex = new RegExp(escapeRegExp(term), "gi");
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

function renderSearchSnippet(snippet: string, query: string) {
  const parts = snippet.split(/(\[\[HL\]\]|\[\[\/HL\]\])/g);
  let highlighted = false;
  const hasServerHighlights = parts.length > 1;
  if (!hasServerHighlights) {
    return renderHighlightedSearchText(snippet, query, "search-snippet");
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
      <mark key={index} className="rounded bg-yellow-100 px-0.5 text-gray-900">
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

function buildSearchOpenQuote(result: ProjectSearchResult, query: string) {
  const fileType = result.file_type?.toLowerCase();
  const opener = stripSearchHighlightMarkers(
    result.snippet || result.quote || result.content || query,
  );
  if (fileType === "md" || fileType === "txt") {
    return opener;
  }
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

function statusLabel(status: ProjectIndexStatus | null): string {
  if (!status) return "Index status unavailable";
  const ready = status.status_counts.ready ?? 0;
  const indexing = status.status_counts.indexing ?? 0;
  const pending = status.status_counts.pending ?? 0;
  const failed =
    (status.status_counts.error ?? 0) + (status.status_counts.failed ?? 0);
  const active = indexing + pending + status.queued_jobs;
  if (failed > 0) return `${failed} failed`;
  if (active > 0) return `${active} indexing`;
  if (ready > 0) return `${ready} searchable`;
  return "No searchable index";
}

function boundedPercent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function indexProgress(status: ProjectIndexStatus): {
  active: boolean;
  done: number;
  failed: number;
  percent: number;
  total: number;
} {
  const ready = status.status_counts.ready ?? 0;
  const indexing = status.status_counts.indexing ?? 0;
  const pending = status.status_counts.pending ?? 0;
  const failed =
    (status.status_counts.error ?? 0) + (status.status_counts.failed ?? 0);
  const knownTotal = ready + indexing + pending + failed;
  const total = Math.max(status.total_documents, knownTotal);
  const done = ready + failed;
  return {
    active: indexing + pending + status.queued_jobs > 0,
    done,
    failed,
    percent: boundedPercent(done, total),
    total,
  };
}

function semanticProgress(
  semantic: NonNullable<ProjectIndexStatus["semantic"]>,
): {
  active: boolean;
  done: number;
  failed: number;
  percent: number;
  total: number;
} {
  const embedding = semantic.status_counts.embedding ?? 0;
  const failed =
    (semantic.status_counts.error ?? 0) + (semantic.status_counts.failed ?? 0);
  const done = semantic.ready_vectors + failed;
  return {
    active: semantic.queued_vectors + embedding > 0,
    done,
    failed,
    percent: boundedPercent(done, semantic.total_vectors),
    total: semantic.total_vectors,
  };
}

function CircularProgressPill({
  label,
  percent,
  tone,
  title,
}: {
  label: string;
  percent: number;
  tone: "blue" | "emerald" | "gray" | "red";
  title?: string;
}) {
  const colors = {
    blue: "#2563eb",
    emerald: "#059669",
    gray: "#9ca3af",
    red: "#dc2626",
  };
  const classes = {
    blue: "bg-blue-50 text-blue-700",
    emerald: "bg-emerald-50 text-emerald-700",
    gray: "bg-gray-100 text-gray-500",
    red: "bg-red-50 text-red-700",
  };
  const safePercent = Math.max(0, Math.min(100, percent));
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 ${classes[tone]}`}
      title={title}
    >
      <span
        aria-hidden="true"
        className="relative h-3.5 w-3.5 shrink-0 rounded-full"
        style={{
          background: `conic-gradient(${colors[tone]} ${safePercent * 3.6}deg, #e5e7eb 0deg)`,
        }}
      >
        <span className="absolute inset-[3px] rounded-full bg-white" />
      </span>
      <span>
        {label} {safePercent}%
      </span>
    </span>
  );
}

function SourceFolderModal({
  open,
  busy,
  error,
  path,
  onPathChange,
  onPick,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  path: string;
  onPathChange: (path: string) => void;
  onPick: () => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/10 backdrop-blur-xs">
      <div className="w-full max-w-xl rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-800">
            <FolderOpen className="h-4 w-4 text-gray-500" />
            Open folder
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pb-4">
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => onPathChange(e.target.value)}
              placeholder="/Users/you/Documents/case-folder"
              className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 outline-none focus:border-gray-400"
              autoFocus
            />
            <button
              type="button"
              onClick={onPick}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Browse
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || path.trim().length === 0}
            onClick={onSubmit}
            className="flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Open
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Stacked rows rendered beneath a doc row when its Version column is
 * expanded. Each row shows a past (or current) version with its number,
 * source, date, and a download button that fetches that specific version.
 */
function DocVersionHistory({
  docId,
  filename,
  loading,
  versions,
  onDownloadVersion,
  onOpenVersion,
  onRenameVersion,
}: {
  docId: string;
  filename: string;
  loading: boolean;
  versions: DocketDocumentVersion[];
  onDownloadVersion: (
    docId: string,
    versionId: string,
    filename: string,
  ) => void;
  onOpenVersion?: (versionId: string, versionLabel: string) => void;
  onRenameVersion?: (
    versionId: string,
    displayName: string | null,
  ) => Promise<void> | void;
}) {
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const commit = async (versionId: string) => {
    const trimmed = editingValue.trim();
    setEditingVersionId(null);
    // Empty string → clear override (falls back to V{n})
    const next = trimmed.length > 0 ? trimmed : null;
    await onRenameVersion?.(versionId, next);
  };
  if (loading && versions.length === 0) {
    return (
      <div className="flex items-center h-9 border-b border-gray-50 text-xs text-gray-500 bg-gray-50/60">
        <div
          className={`sticky left-0 z-[60] ${CHECK_W} bg-gray-50/60 self-stretch`}
        />
        <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-gray-50/60 p-2`}>
          <div className="flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin text-gray-400" />
            <span>Loading versions…</span>
          </div>
        </div>
      </div>
    );
  }
  if (versions.length === 0) {
    return (
      <div className="flex items-center h-9 border-b border-gray-50 text-xs text-gray-400 bg-gray-50/60">
        <div
          className={`sticky left-0 z-[60] ${CHECK_W} bg-gray-50/60 self-stretch`}
        />
        <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-gray-50/60 p-2`}>
          <div>No version history.</div>
        </div>
      </div>
    );
  }
  // Most recent version first.
  const ordered = [...versions].reverse();
  return (
    <>
      {ordered.map((v) => {
        const numberLabel =
          typeof v.version_number === "number" && v.version_number >= 1
            ? `${v.version_number}`
            : v.source === "upload"
              ? "Original"
              : "—";
        const displayLabel = v.display_name?.trim() || numberLabel;
        const dt = new Date(v.created_at);
        const dateLabel = Number.isNaN(dt.valueOf())
          ? ""
          : dt.toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            });
        const isEditing = editingVersionId === v.id;
        return (
          <div
            key={`ver-${docId}-${v.id}`}
            onClick={() => {
              if (isEditing) return;
              onOpenVersion?.(v.id, displayLabel);
            }}
            className="group flex items-center h-9 pr-8 border-b border-gray-50 bg-gray-50/60 text-xs text-gray-600 cursor-pointer hover:bg-gray-100/80 transition-colors"
          >
            <div
              className={`sticky left-0 z-[60] ${CHECK_W} bg-gray-50/60 group-hover:bg-gray-100/80 self-stretch`}
            />
            <div
              className={`sticky left-8 z-[60] ${NAME_COL_W} bg-gray-50/60 group-hover:bg-gray-100/80 p-2`}
            >
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-gray-400">↳</span>
                {isEditing ? (
                  <input
                    autoFocus
                    value={editingValue}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commit(v.id);
                      } else if (e.key === "Escape") {
                        setEditingVersionId(null);
                      }
                    }}
                    onBlur={() => void commit(v.id)}
                    className="min-w-0 flex-1 max-w-[240px] border-b border-gray-300 bg-transparent text-xs text-gray-800 outline-none focus:border-gray-500"
                  />
                ) : (
                  <span className="font-medium text-gray-700 truncate">
                    {displayLabel}
                  </span>
                )}
                {!isEditing && onRenameVersion && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingVersionId(v.id);
                      setEditingValue(v.display_name ?? "");
                    }}
                    title="Rename version"
                    className="shrink-0 rounded p-0.5 text-gray-400 opacity-0 group-hover:opacity-100 hover:text-gray-700 hover:bg-gray-200 transition"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
                <span className="text-gray-400 truncate">{dateLabel}</span>
                <span className="text-gray-300 shrink-0">·</span>
                <span className="text-gray-400 truncate">{v.source}</span>
              </div>
            </div>
            <div className="ml-auto w-20 shrink-0" />
            <div className="w-24 shrink-0" />
            <div className="ml-auto w-20 shrink-0" />
            <div className="w-8 shrink-0 flex justify-end">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDownloadVersion(docId, v.id, filename);
                }}
                title="Download this version"
                className="flex items-center justify-center w-6 h-6 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

function DocAnnotationRows({
  docId,
  loading,
  annotations,
  onOpen,
  onDelete,
  onDeleteMany,
}: {
  docId: string;
  loading: boolean;
  annotations: PdfAnnotation[];
  onOpen: (annotation: PdfAnnotation) => void;
  onDelete: (annotationId: string) => void;
  onDeleteMany: (annotationIds: string[]) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    annotationId: string;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menu]);

  const validSelectedIds = annotations
    .map((ann) => ann.id)
    .filter((id) => selectedIds.has(id));
  const allSelected =
    annotations.length > 0 && validSelectedIds.length === annotations.length;
  const selectedCount = validSelectedIds.length;

  function toggleAnnotationSelected(annotationId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(annotationId)) next.delete(annotationId);
      else next.add(annotationId);
      return next;
    });
  }

  function toggleAllSelected() {
    setSelectedIds((prev) =>
      prev.size === annotations.length
        ? new Set()
        : new Set(annotations.map((ann) => ann.id)),
    );
  }

  function deleteSelected() {
    const ids = validSelectedIds;
    if (ids.length === 0) return;
    setSelectedIds(new Set());
    onDeleteMany(ids);
  }

  if (annotations.length === 0) {
    return (
      <div className="flex items-center h-9 border-b border-gray-50 text-xs text-gray-400 bg-gray-50/60">
        <div
          className={`sticky left-0 z-[60] ${CHECK_W} bg-gray-50/60 self-stretch`}
        />
        <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-gray-50/60 p-2`}>
          {loading ? (
            <div className="flex items-center gap-2 text-gray-500">
              <Loader2 className="h-3 w-3 animate-spin text-gray-400" />
              <span>Loading annotations…</span>
            </div>
          ) : (
            <div>No annotations.</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="group flex items-center h-8 pr-8 border-b border-gray-50 bg-gray-50/80 text-xs text-gray-500">
        <div
          className={`sticky left-0 z-[60] ${CHECK_W} bg-gray-50/80 group-hover:bg-gray-50/80 self-stretch flex items-center justify-center`}
        >
          <input
            data-session-check="project-annotation-select-all"
            type="checkbox"
            checked={allSelected}
            aria-label="Select all annotations"
            onChange={toggleAllSelected}
            onClick={(e) => e.stopPropagation()}
            className="h-3.5 w-3.5 rounded border-gray-300 text-gray-900"
          />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 p-2 pl-6">
          <span className="text-[11px] text-gray-400">
            {selectedCount > 0
              ? `${selectedCount} annotation${selectedCount === 1 ? "" : "s"} selected`
              : `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`}
          </span>
          <button
            data-session-check="project-annotations-delete-selected"
            disabled={selectedCount === 0}
            onClick={(e) => {
              e.stopPropagation();
              deleteSelected();
            }}
            className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:pointer-events-none disabled:text-gray-300"
          >
            <Trash2 className="h-3 w-3" />
            Delete selected
          </button>
        </div>
      </div>
      {annotations.map((ann) => {
        const text = ann.quote?.trim() || ann.comment?.trim() || "(no text)";
        const selected = selectedIds.has(ann.id);
        return (
          <div
            key={`ann-${docId}-${ann.id}`}
            data-session-check="project-annotation-row"
            onClick={() => onOpen(ann)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, annotationId: ann.id });
            }}
            title={
              ann.comment?.trim() && ann.quote?.trim()
                ? `${ann.quote}\n— ${ann.comment}`
                : text
            }
            className={`group flex items-center h-9 pr-8 border-b border-gray-50 text-xs text-gray-600 cursor-pointer transition-colors ${
              selected
                ? "bg-red-50/70 hover:bg-red-50"
                : "bg-gray-50/60 hover:bg-gray-100/80"
            }`}
          >
            <div
              className={`sticky left-0 z-[60] ${CHECK_W} self-stretch flex items-center justify-center ${
                selected
                  ? "bg-red-50/70 group-hover:bg-red-50"
                  : "bg-gray-50/60 group-hover:bg-gray-100/80"
              }`}
            >
              <input
                data-session-check="project-annotation-checkbox"
                type="checkbox"
                checked={selected}
                aria-label="Select annotation"
                onChange={() => toggleAnnotationSelected(ann.id)}
                onClick={(e) => e.stopPropagation()}
                className="h-3.5 w-3.5 rounded border-gray-300 text-gray-900"
              />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2 p-2 pl-6">
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-[3px] flex items-center justify-center text-[8px] font-semibold text-white"
                style={{ backgroundColor: ann.color || "#facc15" }}
              >
                {ann.annotation_type === "comment" ? "C" : "A"}
              </span>
              <span className="min-w-0 flex-1 truncate italic">“{text}”</span>
              <span className="shrink-0 text-[10px] text-gray-400">
                p.{ann.page_number}
              </span>
            </div>
          </div>
        );
      })}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-[70] w-44 rounded-lg border border-gray-100 bg-white shadow-lg overflow-hidden text-xs"
          style={{ top: menu.y, left: menu.x }}
        >
          <button
            data-session-check="project-annotation-delete"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
            onClick={() => {
              onDelete(menu.annotationId);
              setMenu(null);
            }}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            Delete annotation
          </button>
        </div>
      )}
    </>
  );
}

export function ProjectPage({ projectId }: Props) {
  const [project, setProject] = useState<DocketProject | null>(null);
  const [folders, setFolders] = useState<DocketFolder[]>([]);
  const [chats, setChats] = useState<DocketChat[]>([]);
  const [projectReviews, setProjectReviews] = useState<TabularReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [registeredProject, setRegisteredProject] =
    useState<DocketProject | null>(null);
  const [folderAccessBusy, setFolderAccessBusy] = useState(false);
  const [folderAccessError, setFolderAccessError] = useState<string | null>(
    null,
  );
  const [projectReloadNonce, setProjectReloadNonce] = useState(0);
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab =
    tabParam === "assistant" || tabParam === "reviews" ? tabParam : "documents";
  const [addDocsOpen, setAddDocsOpen] = useState(false);
  const [sourceFolderOpen, setSourceFolderOpen] = useState(false);
  const [sourceFolderPath, setSourceFolderPath] = useState("");
  const [sourceFolderBusy, setSourceFolderBusy] = useState(false);
  const [sourceFolderError, setSourceFolderError] = useState<string | null>(
    null,
  );
  const [sourceFolders, setSourceFolders] = useState<DocketSourceFolder[]>([]);
  const [sourceFolderScanSummary, setSourceFolderScanSummary] = useState<
    Record<string, string>
  >({});
  const [rescanningSourceFolderId, setRescanningSourceFolderId] = useState<
    string | null
  >(null);
  const [peopleModalOpen, setPeopleModalOpen] = useState(false);
  const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
  const { user } = useAuth();
  const [viewingDoc, setViewingDoc] = useState<DocketDocument | null>(null);
  const [viewingDocVersion, setViewingDocVersion] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [viewingDocSearchTarget, setViewingDocSearchTarget] =
    useState<SearchDocTarget | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [creatingReview, setCreatingReview] = useState(false);
  const [newTRModalOpen, setNewTRModalOpen] = useState(false);

  // Per-tab selection
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);

  // Version-history expansion (per-doc). versionsByDocId caches fetched
  // versions so toggling closed + open again doesn't refetch. loadingIds
  // drives the inline spinner in the version cell while a fetch is in
  // flight.
  const [expandedVersionDocIds, setExpandedVersionDocIds] = useState<
    Set<string>
  >(() => new Set());
  const [versionsByDocId, setVersionsByDocId] = useState<
    Map<string, DocketDocumentVersion[]>
  >(() => new Map());
  const [loadingVersionDocIds, setLoadingVersionDocIds] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleVersions = async (docId: string) => {
    const already = expandedVersionDocIds.has(docId);
    if (already) {
      setExpandedVersionDocIds((prev) => {
        const next = new Set(prev);
        next.delete(docId);
        return next;
      });
      return;
    }
    // Opening — expand immediately so the user sees a loading state.
    setExpandedVersionDocIds((prev) => new Set([...prev, docId]));
    if (versionsByDocId.has(docId)) return;
    setLoadingVersionDocIds((prev) => new Set([...prev, docId]));
    try {
      const res = await listDocumentVersions(docId);
      setVersionsByDocId((prev) => {
        const next = new Map(prev);
        next.set(docId, res.versions);
        return next;
      });
    } catch (e) {
      console.error("listDocumentVersions failed", e);
    } finally {
      setLoadingVersionDocIds((prev) => {
        const next = new Set(prev);
        next.delete(docId);
        return next;
      });
    }
  };

  // Annotation expansion (per-doc), mirroring the version-history pattern.
  // Refetched on every expand so highlights added in the viewer show up.
  const [expandedAnnotationDocIds, setExpandedAnnotationDocIds] = useState<
    Set<string>
  >(() => new Set());
  const [annotationsByDocId, setAnnotationsByDocId] = useState<
    Map<string, PdfAnnotation[]>
  >(() => new Map());
  const [loadingAnnotationDocIds, setLoadingAnnotationDocIds] = useState<
    Set<string>
  >(() => new Set());

  const toggleAnnotations = (docId: string) => {
    const already = expandedAnnotationDocIds.has(docId);
    if (already) {
      setExpandedAnnotationDocIds((prev) => {
        const next = new Set(prev);
        next.delete(docId);
        return next;
      });
      return;
    }
    setExpandedAnnotationDocIds((prev) => new Set([...prev, docId]));
    setLoadingAnnotationDocIds((prev) => new Set([...prev, docId]));
    listPdfAnnotations(docId)
      .then((rows) => {
        setAnnotationsByDocId((prev) => {
          const next = new Map(prev);
          next.set(docId, rows);
          return next;
        });
      })
      .catch((e) => {
        console.error("listPdfAnnotations failed", e);
        setAnnotationsByDocId((prev) => {
          const next = new Map(prev);
          if (!next.has(docId)) next.set(docId, []);
          return next;
        });
      })
      .finally(() => {
        setLoadingAnnotationDocIds((prev) => {
          const next = new Set(prev);
          next.delete(docId);
          return next;
        });
      });
  };

  async function handleDeleteAnnotation(docId: string, annotationId: string) {
    setAnnotationsByDocId((prev) => {
      const next = new Map(prev);
      next.set(
        docId,
        (next.get(docId) ?? []).filter((a) => a.id !== annotationId),
      );
      return next;
    });
    try {
      await deletePdfAnnotation(docId, annotationId);
    } catch (e) {
      console.error("deletePdfAnnotation failed", e);
      listPdfAnnotations(docId)
        .then((rows) =>
          setAnnotationsByDocId((prev) => {
            const next = new Map(prev);
            next.set(docId, rows);
            return next;
          }),
        )
        .catch(() => {});
    }
  }

  async function handleDeleteAnnotations(
    docId: string,
    annotationIds: string[],
  ) {
    if (annotationIds.length === 0) return;
    const deleteIds = new Set(annotationIds);
    setAnnotationsByDocId((prev) => {
      const next = new Map(prev);
      next.set(
        docId,
        (next.get(docId) ?? []).filter((a) => !deleteIds.has(a.id)),
      );
      return next;
    });
    try {
      await Promise.all(
        annotationIds.map((annotationId) =>
          deletePdfAnnotation(docId, annotationId),
        ),
      );
    } catch (e) {
      console.error("deletePdfAnnotations failed", e);
      listPdfAnnotations(docId)
        .then((rows) =>
          setAnnotationsByDocId((prev) => {
            const next = new Map(prev);
            next.set(docId, rows);
            return next;
          }),
        )
        .catch(() => {});
    }
  }

  async function downloadDocVersion(
    docId: string,
    versionId: string,
    filename: string,
  ) {
    try {
      const resolved = await getDocumentUrl(docId, versionId);
      const a = document.createElement("a");
      a.href = resolved.url;
      // Prefer the backend's resolved filename (which honours the
      // version's display_name). Fall back to the passed filename
      // if for some reason it's missing.
      a.download = resolved.filename || filename;
      a.click();
    } catch (e) {
      console.error("downloadDocVersion failed", e);
    }
  }

  /**
   * Patch a version's display_name and update the local cache in place.
   */
  async function handleRenameVersion(
    docId: string,
    versionId: string,
    displayName: string | null,
  ) {
    try {
      const updated = await renameDocumentVersion(
        docId,
        versionId,
        displayName,
      );
      setVersionsByDocId((prev) => {
        const list = prev.get(docId);
        if (!list) return prev;
        const next = new Map(prev);
        next.set(
          docId,
          list.map((v) => (v.id === versionId ? updated : v)),
        );
        return next;
      });
    } catch (e) {
      console.error("renameDocumentVersion failed", e);
    }
  }

  // Inline rename for chats and reviews
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameChatValue, setRenameChatValue] = useState("");
  const [renamingReviewId, setRenamingReviewId] = useState<string | null>(null);
  const [renameReviewValue, setRenameReviewValue] = useState("");

  // Folder state
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(
    new Set(),
  );
  // undefined = not creating; null = creating at root; string = creating inside that folder id
  const [creatingFolderIn, setCreatingFolderIn] = useState<
    string | null | undefined
  >(undefined);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const newFolderInputRef = useRef<HTMLDivElement | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);

  // Actions dropdown
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [indexStatus, setIndexStatus] = useState<ProjectIndexStatus | null>(
    null,
  );
  const [indexBusy, setIndexBusy] = useState(false);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [compactBusy, setCompactBusy] = useState(false);
  const [compactStatus, setCompactStatus] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [projectSearchResults, setProjectSearchResults] = useState<
    ProjectSearchResult[]
  >([]);
  const [projectSearchActiveQuery, setProjectSearchActiveQuery] = useState("");
  const [projectSearchLoading, setProjectSearchLoading] = useState(false);
  const [projectSearchError, setProjectSearchError] = useState<string | null>(
    null,
  );
  const [projectSearchType, setProjectSearchType] = useState<string>("all");
  const [projectSearchPageSize, setProjectSearchPageSize] = useState<number>(
    PROJECT_SEARCH_PAGE_SIZES[0],
  );
  const [projectSearchPage, setProjectSearchPage] = useState(1);

  const router = useRouter();
  const { saveChat } = useChatHistoryContext();

  const refreshIndexStatus = useCallback(async () => {
    try {
      const status = await getProjectIndexStatus(projectId);
      setIndexStatus(status);
    } catch {
      setIndexStatus(null);
    }
  }, [projectId]);

  async function handleRebuildIndex() {
    if (
      !window.confirm(
        "Rebuild replaces the lexical index and removes all existing project embeddings. It does not generate new embeddings or require a GPU. After indexing finishes, use Start Embedding if you want semantic search again. Continue?",
      )
    ) {
      return;
    }
    setIndexBusy(true);
    try {
      await rebuildProjectIndex(projectId);
      await refreshIndexStatus();
    } finally {
      setIndexBusy(false);
    }
  }

  async function handleCancelIndexing() {
    setIndexBusy(true);
    try {
      await cancelProjectIndex(projectId);
      await refreshIndexStatus();
    } finally {
      setIndexBusy(false);
    }
  }

  async function handleCompactDatabase() {
    if (
      !window.confirm(
        "Compact Database returns unused SQLite space to disk. It may briefly lock this project's database. Continue?",
      )
    ) {
      return;
    }
    setCompactBusy(true);
    setCompactStatus(null);
    try {
      const result = await compactProjectDatabase(projectId);
      setCompactStatus({
        message: `Compacted · ${formatBytes(result.reclaimed_bytes)} reclaimed`,
        error: false,
      });
    } catch (err) {
      setCompactStatus({
        message: (err as Error).message || "Database compaction failed",
        error: true,
      });
    } finally {
      setCompactBusy(false);
    }
  }

  async function handleStartEmbedding() {
    setEmbeddingBusy(true);
    try {
      await startProjectEmbedding(projectId);
      await refreshIndexStatus();
    } finally {
      setEmbeddingBusy(false);
    }
  }

  async function handlePauseEmbedding() {
    setEmbeddingBusy(true);
    try {
      await pauseProjectEmbedding(projectId);
      await refreshIndexStatus();
    } finally {
      setEmbeddingBusy(false);
    }
  }

  async function submitProjectSearch() {
    const q = projectSearchQuery.trim();
    if (!q) {
      setProjectSearchResults([]);
      setProjectSearchActiveQuery("");
      setProjectSearchError(null);
      setProjectSearchPage(1);
      return;
    }
    setProjectSearchLoading(true);
    setProjectSearchError(null);
    try {
      const result = await searchProjectDocuments(projectId, {
        q,
        limit: PROJECT_SEARCH_RESULT_LIMIT,
        types: projectSearchType === "all" ? undefined : [projectSearchType],
        group: "documents",
      });
      setProjectSearchResults(result.results);
      setProjectSearchActiveQuery(q);
      setProjectSearchPage(1);
      await refreshIndexStatus();
    } catch (err) {
      setProjectSearchError((err as Error).message || "Search failed");
    } finally {
      setProjectSearchLoading(false);
    }
  }

  function openDocumentViewerFromSearch(
    doc: DocketDocument,
    result: ProjectSearchResult,
  ) {
    const quote = buildSearchOpenQuote(result, projectSearchDisplayQuery);
    const page = result.page_number ?? null;
    const version =
      result.version_id ? { id: result.version_id, label: "Search result" } : null;
    openDocumentViewer(doc, {
      filename: result.filename || doc.filename,
      version,
      searchTarget: {
        quote,
        page,
        key: result.chunk_id,
      },
    });
  }

  function openDocumentViewer(
    doc: DocketDocument,
    options: {
      filename?: string;
      version?: { id: string; label: string } | null;
      searchTarget?: SearchDocTarget | null;
      annotation?: PdfAnnotation | null;
    } = {},
  ) {
    const version = options.version ?? null;
    const annotation = options.annotation ?? null;
    // An annotation target rides the search params for the page hint and
    // fallback-modal scroll, plus annotation_id for the precise focus.
    const searchTarget =
      options.searchTarget ??
      (annotation
        ? {
            quote: annotation.quote ?? "",
            page: annotation.page_number,
            key: `annotation-${annotation.id}-${Date.now()}`,
          }
        : null);
    const payload: DocumentViewerPayload = {
      documentId: doc.id,
      filename: options.filename || doc.filename,
      versionId: version?.id ?? null,
      versionLabel: version?.label ?? null,
      searchQuote: searchTarget?.quote ?? null,
      searchPage: searchTarget?.page ?? null,
      searchKey: searchTarget?.key ?? null,
      annotationId: annotation?.id ?? null,
      projectId,
    };
    const bridge =
      typeof window !== "undefined"
        ? ((window.docket as DocumentViewerBridge | undefined) ?? null)
        : null;
    const openFallbackModal = () => {
      setViewingDocVersion(version);
      setViewingDocSearchTarget(searchTarget);
      setViewingDoc(doc);
    };
    if (bridge?.openDocumentViewer) {
      void bridge
        .openDocumentViewer(payload)
        .then((result) => {
          if (result && "ok" in result && result.ok === false) {
            openFallbackModal();
          }
        })
        .catch(openFallbackModal);
      return;
    }
    if (typeof window !== "undefined" && window.docket) {
      const popup = window.open(
        documentViewerPath(payload),
        "docket-document-viewer",
        "popup,width=960,height=820",
      );
      if (popup) {
        popup.focus();
        return;
      }
    }
    openFallbackModal();
  }

  const projectSearchDisplayQuery =
    projectSearchActiveQuery || projectSearchQuery;
  const projectSearchPageCount = Math.max(
    1,
    Math.ceil(projectSearchResults.length / projectSearchPageSize),
  );
  const safeProjectSearchPage = Math.min(
    projectSearchPage,
    projectSearchPageCount,
  );
  const projectSearchStartIndex =
    (safeProjectSearchPage - 1) * projectSearchPageSize;
  const projectSearchEndIndex = Math.min(
    projectSearchStartIndex + projectSearchPageSize,
    projectSearchResults.length,
  );
  const projectSearchVisibleResults = projectSearchResults.slice(
    projectSearchStartIndex,
    projectSearchEndIndex,
  );
  const currentIndexProgress = indexStatus ? indexProgress(indexStatus) : null;
  const currentSemanticProgress = indexStatus?.semantic
    ? semanticProgress(indexStatus.semantic)
    : null;
  const semanticEmbeddingAvailable =
    indexStatus?.semantic?.enabled !== false &&
    !!currentSemanticProgress &&
    currentSemanticProgress.total > 0;
  const semanticEmbeddingPaused = indexStatus?.semantic?.paused === true;
  const semanticEmbeddingActive = currentSemanticProgress?.active === true;

  function handleTabChange(newTab: Tab) {
    const base = `/projects/${projectId}`;
    const url = newTab === "documents" ? base : `${base}?tab=${newTab}`;
    router.push(url);
  }

  async function reconnectProjectFolder() {
    if (!registeredProject?.path || folderAccessBusy) return;
    const bridge =
      typeof window !== "undefined"
        ? (window.docket as
            | {
                authorizeProjectFolder?: (payload: {
                  path: string;
                  name?: string;
                }) => Promise<{ ok: boolean; error?: string }>;
              }
            | undefined)
        : undefined;
    if (!bridge?.authorizeProjectFolder) {
      setFolderAccessError("Folder access can only be repaired in the desktop app.");
      return;
    }

    setFolderAccessBusy(true);
    setFolderAccessError(null);
    try {
      const result = await bridge.authorizeProjectFolder({
        path: registeredProject.path,
        name: registeredProject.name,
      });
      if (!result.ok) {
        if (result.error) setFolderAccessError(result.error);
        return;
      }
      clearLocalSessionCache();
      setProjectReloadNonce((value) => value + 1);
    } catch (err) {
      setFolderAccessError(
        err instanceof Error ? err.message : "Could not reconnect project folder",
      );
    } finally {
      setFolderAccessBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProjectLoadError(null);
    setRegisteredProject(null);
    setFolderAccessError(null);
    getProject(projectId)
      .then(async (proj) => {
        void ensureProjectIndexCurrent(projectId).catch(() => null);
        const [projectChats, projectReviews, linkedFolders, status] =
          await Promise.all([
            listProjectChats(projectId).catch(() => [] as DocketChat[]),
            listTabularReviews(projectId).catch(() => []),
            listProjectSourceFolders(projectId).catch(
              () => [] as DocketSourceFolder[],
            ),
            getProjectIndexStatus(projectId).catch(() => null),
          ]);
        return { proj, projectChats, projectReviews, linkedFolders, status };
      })
      .then(({ proj, projectChats, projectReviews, linkedFolders, status }) => {
        if (cancelled) return;
        setProject(proj);
        const loadedFolders = proj.folders ?? [];
        setFolders(loadedFolders);
        setExpandedFolderIds(new Set(loadedFolders.map((f) => f.id)));
        setChats(projectChats);
        setProjectReviews(projectReviews);
        setSourceFolders(linkedFolders);
        setIndexStatus(status);
      })
      .catch(async (err) => {
        if (cancelled) return;
        console.warn("load project failed", err);
        const registry = await getProjectRegistry(projectId).catch(() => null);
        if (cancelled) return;
        setProject(null);
        setRegisteredProject(registry);
        setProjectLoadError(
          err instanceof Error ? err.message : "Failed to load project",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, projectReloadNonce]);

  useEffect(() => {
    if (tab !== "documents") return;
    void refreshIndexStatus();
    const pollingMs =
      currentIndexProgress?.active || currentSemanticProgress?.active
        ? 1000
        : 5000;
    const id = window.setInterval(() => {
      void refreshIndexStatus();
    }, pollingMs);
    return () => window.clearInterval(id);
  }, [
    refreshIndexStatus,
    tab,
    currentIndexProgress?.active,
    currentSemanticProgress?.active,
  ]);

  // Reset selection and close dropdowns when tab changes
  useEffect(() => {
    setSelectedDocIds([]);
    setSelectedChatIds([]);
    setSelectedReviewIds([]);
    setActionsOpen(false);
    setContextMenu(null);
  }, [tab]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node))
        setActionsOpen(false);
    }
    if (actionsOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [actionsOpen]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    function handle(e: MouseEvent) {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      )
        setContextMenu(null);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [contextMenu]);

  // Clear all drag state when any drag operation ends
  useEffect(() => {
    function handleDragEnd() {
      setDragOverFolderId(null);
      setDragOverRoot(false);
    }
    document.addEventListener("dragend", handleDragEnd);
    return () => document.removeEventListener("dragend", handleDragEnd);
  }, []);

  // Scroll new-folder input into view whenever it appears
  useEffect(() => {
    if (creatingFolderIn !== undefined) {
      newFolderInputRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [creatingFolderIn]);

  // ── Folder handlers ───────────────────────────────────────────────────────

  function toggleFolder(id: string) {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleCreateFolder(parentId: string | null) {
    const name = newFolderName.trim();
    setNewFolderName("");
    if (!name) {
      setCreatingFolderIn(undefined);
      return;
    }

    // Immediately hide the input and show an optimistic folder row
    setCreatingFolderIn(undefined);
    const tempId = `temp-${Date.now()}`;
    const optimistic: DocketFolder = {
      id: tempId,
      project_id: projectId,
      user_id: "",
      name,
      parent_folder_id: parentId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setFolders((prev) => [...prev, optimistic]);
    setExpandedFolderIds((prev) => new Set([...prev, tempId]));
    if (parentId) setExpandedFolderIds((prev) => new Set([...prev, parentId]));

    // Replace with real folder from API
    const folder = await createProjectFolder(
      projectId,
      name,
      parentId ?? undefined,
    );
    setFolders((prev) => prev.map((f) => (f.id === tempId ? folder : f)));
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      next.delete(tempId);
      next.add(folder.id);
      return next;
    });
  }

  async function handleRenameFolder(folderId: string) {
    const name = renameFolderValue.trim();
    setRenamingFolderId(null);
    if (!name) return;
    setFolders((prev) =>
      prev.map((f) => (f.id === folderId ? { ...f, name } : f)),
    );
    await renameProjectFolder(projectId, folderId, name);
  }

  async function handleDeleteFolder(folderId: string) {
    // Collect all subfolder IDs that will cascade-delete
    const toDelete = new Set<string>();
    function collectIds(id: string) {
      toDelete.add(id);
      folders
        .filter((f) => f.parent_folder_id === id)
        .forEach((f) => collectIds(f.id));
    }
    collectIds(folderId);

    setFolders((prev) => prev.filter((f) => !toDelete.has(f.id)));
    setProject((prev) =>
      prev
        ? {
            ...prev,
            documents: (prev.documents ?? []).map((d) =>
              d.folder_id && toDelete.has(d.folder_id)
                ? { ...d, folder_id: null }
                : d,
            ),
          }
        : prev,
    );
    await deleteProjectFolder(projectId, folderId);
  }

  // ── Doc/chat/review handlers ──────────────────────────────────────────────

  function handleDocsSelected(newDocs: DocketDocument[]) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            documents: [
              ...(prev.documents || []),
              ...newDocs.filter(
                (d) => !prev.documents?.some((e) => e.id === d.id),
              ),
            ],
          }
        : prev,
    );
    setTimeout(() => void refreshIndexStatus(), 300);
  }

  async function pickSourceFolder() {
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
    if (!bridge?.pickSourceFolder) return;
    const result = await bridge.pickSourceFolder();
    if (result.ok && result.path) {
      setSourceFolderPath(result.path);
      setSourceFolderError(null);
    } else if (result.error) {
      setSourceFolderError(result.error);
    }
  }

  async function submitSourceFolder() {
    const path = sourceFolderPath.trim();
    if (!path) return;
    setSourceFolderBusy(true);
    setSourceFolderError(null);
    try {
      const result = await addProjectSourceFolder(projectId, path);
      setSourceFolders((prev) => [...prev, result.source_folder]);
      setSourceFolderScanSummary((prev) => ({
        ...prev,
        [result.source_folder.id]: formatScanSummary(result),
      }));
      setProject((prev) =>
        prev
          ? {
              ...prev,
              documents: [
                ...(prev.documents ?? []),
                ...result.imported.filter(
                  (d) =>
                    !prev.documents?.some((existing) => existing.id === d.id),
                ),
              ],
            }
          : prev,
      );
      setSourceFolderOpen(false);
      setSourceFolderPath("");
      setTimeout(() => void refreshIndexStatus(), 300);
    } catch (err) {
      setSourceFolderError(
        (err as Error).message || "Could not open folder.",
      );
    } finally {
      setSourceFolderBusy(false);
    }
  }

  function mergeScanDocuments(result: DocketSourceFolderScanResult) {
    setProject((prev) => {
      if (!prev) return prev;
      const docsById = new Map((prev.documents ?? []).map((d) => [d.id, d]));
      for (const doc of [...result.imported, ...result.updated]) {
        docsById.set(doc.id, doc);
      }
      return { ...prev, documents: Array.from(docsById.values()) };
    });
  }

  function formatScanSummary(result: DocketSourceFolderScanResult): string {
    const parts = [
      result.imported.length ? `${result.imported.length} new` : null,
      result.updated.length ? `${result.updated.length} updated` : null,
      result.unchanged.length ? `${result.unchanged.length} unchanged` : null,
      result.missing.length ? `${result.missing.length} missing` : null,
      result.skipped.length ? `${result.skipped.length} skipped` : null,
    ].filter(Boolean);
    return parts.join(", ") || "No supported files found";
  }

  async function handleRescanSourceFolder(folder: DocketSourceFolder) {
    setRescanningSourceFolderId(folder.id);
    try {
      const result = await rescanProjectSourceFolder(projectId, folder.id);
      setSourceFolders((prev) =>
        prev.map((f) => (f.id === folder.id ? result.source_folder : f)),
      );
      setSourceFolderScanSummary((prev) => ({
        ...prev,
        [folder.id]: formatScanSummary(result),
      }));
      mergeScanDocuments(result);
      setTimeout(() => void refreshIndexStatus(), 300);
    } catch (err) {
      setSourceFolderScanSummary((prev) => ({
        ...prev,
        [folder.id]: (err as Error).message || "Rescan failed",
      }));
    } finally {
      setRescanningSourceFolderId(null);
    }
  }

  async function handleRemoveDocFromFolder(docId: string) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            documents: (prev.documents ?? []).map((d) =>
              d.id === docId ? { ...d, folder_id: null } : d,
            ),
          }
        : prev,
    );
    await moveDocumentToFolder(projectId, docId, null);
  }

  async function handleRemoveDoc(docId: string) {
    const doc = project?.documents?.find((d) => d.id === docId);
    // Backend only lets the doc creator delete. Warn the requester
    // instead of letting the request 404 silently.
    if (doc && user?.id && doc.user_id && doc.user_id !== user.id) {
      setOwnerOnlyAction("delete this document");
      return;
    }
    await deleteDocument(docId);
    setProject((prev) =>
      prev
        ? {
            ...prev,
            documents: prev.documents?.filter((d) => d.id !== docId) || [],
          }
        : prev,
    );
  }

  async function handleNewChat() {
    setCreatingChat(true);
    try {
      const id = await saveChat(projectId);
      if (id) {
        const params = new URLSearchParams();
        const q = (projectSearchActiveQuery || projectSearchQuery).trim();
        if (q) params.set("q", q);
        if (projectSearchType !== "all") params.set("type", projectSearchType);
        const query = params.toString();
        router.push(
          `/projects/${projectId}/assistant/chat/${id}${query ? `?${query}` : ""}`,
        );
      }
    } finally {
      setCreatingChat(false);
    }
  }

  function handleNewReview() {
    const docs = project?.documents?.filter((d) => d.status === "ready") || [];
    if (docs.length === 0) return;
    setNewTRModalOpen(true);
  }

  async function handleCreateReview(
    title: string,
    _projectId?: string,
    documentIds?: string[],
    columnsConfig?: Pick<ColumnConfig, "index" | "name" | "prompt">[] | null,
  ) {
    setCreatingReview(true);
    try {
      const docs =
        project?.documents?.filter((d) => d.status === "ready") || [];
      const review = await createTabularReview({
        title: title || undefined,
        document_ids: documentIds ?? docs.map((d) => d.id),
        columns_config: columnsConfig ?? [],
        project_id: projectId,
      });
      router.push(`/projects/${projectId}/tabular-reviews/${review.id}`);
    } finally {
      setCreatingReview(false);
    }
  }

  async function handleTitleCommit(newName: string) {
    if (!newName || newName === project?.name) return;
    // Server-side this would 404 silently for non-owners; surface a
    // clear permission warning instead.
    if (project && project.is_owner === false) {
      setOwnerOnlyAction("rename this project");
      return;
    }
    setProject((prev) => (prev ? { ...prev, name: newName } : prev));
    await updateProject(projectId, { name: newName });
  }

  async function submitChatRename(chatId: string) {
    const trimmed = renameChatValue.trim();
    setRenamingChatId(null);
    if (!trimmed) return;
    const chat = chats.find((c) => c.id === chatId);
    if (chat && user?.id && chat.user_id !== user.id) {
      setOwnerOnlyAction("rename this chat");
      return;
    }
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, title: trimmed } : c)),
    );
    await renameChat(chatId, trimmed);
  }

  async function submitReviewRename(reviewId: string) {
    const trimmed = renameReviewValue.trim();
    setRenamingReviewId(null);
    if (!trimmed) return;
    const review = projectReviews.find((r) => r.id === reviewId);
    if (review && user?.id && review.user_id !== user.id) {
      setOwnerOnlyAction("rename this tabular review");
      return;
    }
    setProjectReviews((prev) =>
      prev.map((r) => (r.id === reviewId ? { ...r, title: trimmed } : r)),
    );
    await updateTabularReview(reviewId, { title: trimmed });
  }

  /**
   * Merge saved annotations into a new "[Annotated]" PDF version and hand
   * it to the browser; Electron prompts a save-as dialog for downloads.
   * Returns an error message instead of alerting so bulk callers can
   * aggregate failures.
   */
  async function handleExportAnnotated(
    doc: DocketDocument,
  ): Promise<string | null> {
    try {
      const version = await exportAnnotatedPdf(doc.id, null);
      const resolved = await getDocumentUrl(doc.id, version.id);
      const a = document.createElement("a");
      a.href = resolved.url;
      a.download = resolved.filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // The export records a new version; refresh so the history advances.
      setVersionsByDocId((prev) => {
        const next = new Map(prev);
        next.delete(doc.id);
        return next;
      });
      getProject(projectId)
        .then(setProject)
        .catch(() => {});
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Failed to export annotated PDF.";
    }
  }

  async function handleExportAnnotatedClick(doc: DocketDocument) {
    const error = await handleExportAnnotated(doc);
    if (error) alert(`${doc.filename}: ${error}`);
  }

  /**
   * Per-document rescan: pick up on-disk changes to the linked source file
   * as a new version and re-import annotations added by external editors.
   */
  async function handleRescanDoc(doc: DocketDocument): Promise<string | null> {
    try {
      const result = await rescanDocument(doc.id);
      // Drop cached annotations so the next expand shows the fresh set.
      setAnnotationsByDocId((prev) => {
        const next = new Map(prev);
        next.delete(doc.id);
        return next;
      });
      if (expandedAnnotationDocIds.has(doc.id)) {
        const rows = await listPdfAnnotations(doc.id);
        setAnnotationsByDocId((prev) => {
          const next = new Map(prev);
          next.set(doc.id, rows);
          return next;
        });
      }
      if (result.status === "updated") {
        setVersionsByDocId((prev) => {
          const next = new Map(prev);
          next.delete(doc.id);
          return next;
        });
        const updated = await getProject(projectId);
        setProject(updated);
        setTimeout(() => void refreshIndexStatus(), 300);
      }
      if (result.status === "missing") return "Source file not found on disk.";
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Rescan failed.";
    }
  }

  async function handleRescanDocClick(doc: DocketDocument) {
    const error = await handleRescanDoc(doc);
    if (error) alert(`${doc.filename}: ${error}`);
  }

  async function handleExportSelectedAnnotated() {
    setActionsOpen(false);
    const targets = selectedDocIds
      .map((id) => docs.find((d) => d.id === id))
      .filter((d): d is DocketDocument => !!d && d.file_type === "pdf");
    const failures: string[] = [];
    for (const doc of targets) {
      const error = await handleExportAnnotated(doc);
      if (error) failures.push(`${doc.filename}: ${error}`);
    }
    if (failures.length) alert(failures.join("\n"));
  }

  async function handleRescanSelected() {
    setActionsOpen(false);
    const targets = selectedDocIds
      .map((id) => docs.find((d) => d.id === id))
      .filter((d): d is DocketDocument => !!d);
    const failures: string[] = [];
    for (const doc of targets) {
      const error = await handleRescanDoc(doc);
      if (error) failures.push(`${doc.filename}: ${error}`);
    }
    if (failures.length) alert(failures.join("\n"));
  }

  async function handleRemoveSelectedFromFolder() {
    const ids = selectedDocIds.filter(
      (id) => docs.find((d) => d.id === id)?.folder_id != null,
    );
    setActionsOpen(false);
    if (ids.length === 0) return;
    setProject((prev) =>
      prev
        ? {
            ...prev,
            documents: (prev.documents ?? []).map((d) =>
              ids.includes(d.id) ? { ...d, folder_id: null } : d,
            ),
          }
        : prev,
    );
    await Promise.all(
      ids.map((id) =>
        moveDocumentToFolder(projectId, id, null).catch(() => {}),
      ),
    );
  }

  async function handleDeleteSelectedDocs() {
    const ids = [...selectedDocIds];
    setActionsOpen(false);
    // Filter to docs the requester owns (server-side gate).
    const owned = ids.filter((id) => {
      const d = project?.documents?.find((dd) => dd.id === id);
      return !d || !d.user_id || !user?.id || d.user_id === user.id;
    });
    const blocked = ids.length - owned.length;
    setSelectedDocIds([]);
    await Promise.all(owned.map((id) => deleteDocument(id).catch(() => {})));
    setProject((prev) =>
      prev
        ? {
            ...prev,
            documents:
              prev.documents?.filter((d) => !owned.includes(d.id)) || [],
          }
        : prev,
    );
    if (blocked > 0) {
      setOwnerOnlyAction(
        `delete ${blocked} of the selected documents — only the document creator can delete a document`,
      );
    }
  }

  async function handleDeleteSelectedChats() {
    const ids = [...selectedChatIds];
    setActionsOpen(false);
    const owned = ids.filter((id) => {
      const c = chats.find((cc) => cc.id === id);
      return !c || !user?.id || c.user_id === user.id;
    });
    const blocked = ids.length - owned.length;
    setSelectedChatIds([]);
    await Promise.all(owned.map((id) => deleteChat(id).catch(() => {})));
    setChats((prev) => prev.filter((c) => !owned.includes(c.id)));
    if (blocked > 0) {
      setOwnerOnlyAction(
        `delete ${blocked} of the selected chats — only the chat creator can delete a chat`,
      );
    }
  }

  async function handleDeleteSelectedReviews() {
    const ids = [...selectedReviewIds];
    setActionsOpen(false);
    const owned = ids.filter((id) => {
      const r = projectReviews.find((rr) => rr.id === id);
      return !r || !user?.id || r.user_id === user.id;
    });
    const blocked = ids.length - owned.length;
    setSelectedReviewIds([]);
    await Promise.all(
      owned.map((id) => deleteTabularReview(id).catch(() => {})),
    );
    setProjectReviews((prev) => prev.filter((r) => !owned.includes(r.id)));
    if (blocked > 0) {
      setOwnerOnlyAction(
        `delete ${blocked} of the selected reviews — only the review creator can delete a review`,
      );
    }
  }

  // ── Drag & drop ───────────────────────────────────────────────────────────

  function wouldCreateCycle(movingId: string, targetId: string): boolean {
    // Returns true if targetId is movingId or a descendant of it
    let cur: DocketFolder | undefined = folders.find((f) => f.id === targetId);
    while (cur) {
      if (cur.id === movingId) return true;
      if (!cur.parent_folder_id) break;
      cur = folders.find((f) => f.id === cur!.parent_folder_id);
    }
    return false;
  }

  async function handleDropOnFolder(
    targetFolderId: string | null,
    dt: DataTransfer,
  ) {
    const docId = dt.getData("application/docket-doc");
    const subFolderId = dt.getData("application/docket-folder");
    if (docId) {
      const doc = (project?.documents ?? []).find((d) => d.id === docId);
      if (!doc || (doc.folder_id ?? null) === targetFolderId) return;
      setProject((prev) =>
        prev
          ? {
              ...prev,
              documents: (prev.documents ?? []).map((d) =>
                d.id === docId ? { ...d, folder_id: targetFolderId } : d,
              ),
            }
          : prev,
      );
      await moveDocumentToFolder(projectId, docId, targetFolderId);
    } else if (subFolderId && subFolderId !== targetFolderId) {
      if (
        targetFolderId !== null &&
        wouldCreateCycle(subFolderId, targetFolderId)
      )
        return;
      const folder = folders.find((f) => f.id === subFolderId);
      if (!folder || (folder.parent_folder_id ?? null) === targetFolderId)
        return;
      setFolders((prev) =>
        prev.map((f) =>
          f.id === subFolderId ? { ...f, parent_folder_id: targetFolderId } : f,
        ),
      );
      await moveSubfolderToFolder(projectId, subFolderId, targetFolderId);
    }
  }

  // ── Tree rendering ────────────────────────────────────────────────────────

  function renderFolderInput(parentId: string | null) {
    if (creatingFolderIn !== parentId) return null;
    return (
      <div
        ref={newFolderInputRef}
        className="group flex items-center h-10 pr-8 border-b border-gray-50"
        key={`new-folder-${parentId ?? "root"}`}
      >
        <div
          className={`sticky left-0 z-[60] ${CHECK_W} bg-white self-stretch`}
        />
        <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white p-2`}>
          <div className="flex items-center gap-1.5">
            <ChevronRight className="h-3.5 w-3.5 text-gray-300 shrink-0" />
            <FolderPlus className="h-4 w-4 text-amber-400 shrink-0" />
            <input
              autoFocus
              className="flex-1 min-w-0 text-sm text-gray-800 bg-transparent outline-none border-b border-gray-300"
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateFolder(parentId);
                if (e.key === "Escape") {
                  setCreatingFolderIn(undefined);
                  setNewFolderName("");
                }
              }}
              onBlur={() => void handleCreateFolder(parentId)}
            />
          </div>
        </div>
        <div className="ml-auto w-20 shrink-0" />
        <div className="w-24 shrink-0" />
        <div className="w-20 shrink-0" />
        <div className="w-32 shrink-0" />
        <div className="w-32 shrink-0" />
        <div className="w-8 shrink-0" />
      </div>
    );
  }

  function renderLevel(parentId: string | null, depth: number) {
    const childFolders = folders
      .filter((f) => f.parent_folder_id === parentId)
      .sort((a, b) => a.name.localeCompare(b.name));
    const childDocs = (project?.documents ?? []).filter(
      (d) => (d.folder_id ?? null) === parentId,
    );

    return (
      <>
        {/* Files first */}
        {childDocs.map((doc) => {
          const isProcessing =
            doc.status === "pending" || doc.status === "processing";
          const isError = doc.status === "error";
          const isVersionsOpen = expandedVersionDocIds.has(doc.id);
          const isAnnotationsOpen = expandedAnnotationDocIds.has(doc.id);
          const hasVersions =
            typeof doc.latest_version_number === "number" &&
            doc.latest_version_number >= 1;
          return (
            <div key={`doc-${doc.id}`}>
              <div
                data-session-check="project-doc-row"
                data-document-id={doc.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/docket-doc", doc.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => {
                  openDocumentViewer(doc);
                }}
                onContextMenu={(e) => e.stopPropagation()}
                className="group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
              >
                {(() => {
                  const rowBg = selectedDocIds.includes(doc.id)
                    ? "bg-gray-50"
                    : "bg-white";
                  return (
                    <>
                      <div
                        className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${rowBg} group-hover:bg-gray-50`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedDocIds.includes(doc.id)}
                          onChange={() =>
                            setSelectedDocIds((prev) =>
                              prev.includes(doc.id)
                                ? prev.filter((x) => x !== doc.id)
                                : [...prev, doc.id],
                            )
                          }
                          className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                        />
                      </div>
                      <div
                        className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${rowBg} group-hover:bg-gray-50`}
                      >
                        <div className="flex items-center gap-2">
                          {doc.file_type === "pdf" ? (
                            <button
                              data-session-check="project-annotation-toggle"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleAnnotations(doc.id);
                              }}
                              title={
                                isAnnotationsOpen
                                  ? "Hide annotations"
                                  : "Show annotations"
                              }
                              className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                            >
                              {isAnnotationsOpen ? (
                                <ChevronDown className="h-3 w-3" />
                              ) : (
                                <ChevronRight className="h-3 w-3" />
                              )}
                            </button>
                          ) : (
                            <span className="h-4 w-4 shrink-0" />
                          )}
                          {isProcessing ? (
                            <Loader2 className="h-4 w-4 animate-spin text-gray-400 shrink-0" />
                          ) : isError ? (
                            <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                          ) : (
                            <DocIcon fileType={doc.file_type} />
                          )}
                          <span className="text-sm text-gray-800 truncate">
                            {doc.filename}
                          </span>
                        </div>
                      </div>
                      <div className="ml-auto w-20 shrink-0 text-xs text-gray-500 uppercase truncate">
                        {doc.file_type ?? (
                          <span className="text-gray-300">—</span>
                        )}
                      </div>
                      <div className="w-24 shrink-0 text-sm text-gray-500 truncate">
                        {doc.size_bytes != null ? (
                          formatBytes(doc.size_bytes)
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </div>
                      <div
                        className="w-20 shrink-0 text-sm text-gray-500 flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {hasVersions ? (
                          <button
                            onClick={() => void toggleVersions(doc.id)}
                            className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-gray-100 transition-colors"
                          >
                            <span>{doc.latest_version_number}</span>
                            {isVersionsOpen ? (
                              <ChevronDown className="h-3 w-3 text-gray-400" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-gray-400" />
                            )}
                          </button>
                        ) : (
                          <span className="text-gray-300 pl-1">—</span>
                        )}
                      </div>
                      <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                        {doc.created_at ? (
                          formatDate(doc.created_at)
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </div>
                      <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                        {doc.updated_at ? (
                          formatDate(doc.updated_at)
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </div>
                      <div className="w-8 shrink-0 flex justify-end">
                        {!isProcessing && (
                          <RowActions
                            onExportAnnotated={
                              doc.file_type === "pdf"
                                ? () => void handleExportAnnotatedClick(doc)
                                : undefined
                            }
                            onRescan={() => void handleRescanDocClick(doc)}
                            onShowAllVersions={
                              hasVersions && !isVersionsOpen
                                ? () => void toggleVersions(doc.id)
                                : undefined
                            }
                            onRemoveFromFolder={
                              doc.folder_id
                                ? () => handleRemoveDocFromFolder(doc.id)
                                : undefined
                            }
                            onDelete={() => handleRemoveDoc(doc.id)}
                          />
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
              {isAnnotationsOpen && (
                <DocAnnotationRows
                  docId={doc.id}
                  loading={loadingAnnotationDocIds.has(doc.id)}
                  annotations={annotationsByDocId.get(doc.id) ?? []}
                  onOpen={(ann) =>
                    openDocumentViewer(doc, { annotation: ann })
                  }
                  onDelete={(annotationId) =>
                    void handleDeleteAnnotation(doc.id, annotationId)
                  }
                  onDeleteMany={(annotationIds) =>
                    void handleDeleteAnnotations(doc.id, annotationIds)
                  }
                />
              )}
              {isVersionsOpen && (
                <DocVersionHistory
                  docId={doc.id}
                  filename={doc.filename}
                  loading={loadingVersionDocIds.has(doc.id)}
                  versions={versionsByDocId.get(doc.id) ?? []}
                  onDownloadVersion={downloadDocVersion}
                  onOpenVersion={(versionId, label) => {
                    openDocumentViewer(doc, {
                      version: { id: versionId, label },
                    });
                  }}
                  onRenameVersion={(versionId, displayName) =>
                    handleRenameVersion(doc.id, versionId, displayName)
                  }
                />
              )}
            </div>
          );
        })}

        {/* Subfolders after files, sorted alphabetically */}
        {childFolders.map((folder) => {
          const isExpanded = expandedFolderIds.has(folder.id);
          const isRenaming = renamingFolderId === folder.id;
          return (
            <div key={`folder-${folder.id}`}>
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/docket-folder", folder.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.stopPropagation();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverFolderId(folder.id);
                }}
                onDragLeave={(e) => {
                  e.stopPropagation();
                  setDragOverFolderId(null);
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverFolderId(null);
                  setDragOverRoot(false);
                  await handleDropOnFolder(folder.id, e.dataTransfer);
                }}
                onClick={() => toggleFolder(folder.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    folderId: folder.id,
                    showFolderActions: true,
                  });
                }}
                className={`group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors select-none ${dragOverFolderId === folder.id ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : ""}`}
              >
                <div
                  className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${dragOverFolderId === folder.id ? "bg-blue-50" : "bg-white"} group-hover:bg-gray-50 self-stretch`}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                  )}
                </div>
                <div
                  className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${dragOverFolderId === folder.id ? "bg-blue-50" : "bg-white"} group-hover:bg-gray-50`}
                >
                  <div className="flex items-center gap-1.5">
                    {isExpanded ? (
                      <FolderOpen className="h-4 w-4 text-amber-500 shrink-0" />
                    ) : (
                      <Folder className="h-4 w-4 text-amber-500 shrink-0" />
                    )}
                    {isRenaming ? (
                      <input
                        autoFocus
                        className="flex-1 min-w-0 text-sm text-gray-800 bg-transparent outline-none"
                        value={renameFolderValue}
                        onChange={(e) => setRenameFolderValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter")
                            void handleRenameFolder(folder.id);
                          if (e.key === "Escape") setRenamingFolderId(null);
                        }}
                        onBlur={() => void handleRenameFolder(folder.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="text-sm text-gray-800 truncate">
                        {folder.name}
                      </span>
                    )}
                  </div>
                </div>
                <div className="ml-auto w-20 shrink-0 text-xs text-gray-300">
                  —
                </div>
                <div className="w-24 shrink-0 text-sm text-gray-300">—</div>
                <div className="w-20 shrink-0 text-sm text-gray-300">—</div>
                <div className="w-32 shrink-0 text-sm text-gray-300">—</div>
                <div className="w-32 shrink-0 text-sm text-gray-300">—</div>
                <div
                  className="w-8 shrink-0 flex justify-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  <RowActions
                    onRename={() => {
                      setRenameFolderValue(folder.name);
                      setRenamingFolderId(folder.id);
                    }}
                    onDelete={() => handleDeleteFolder(folder.id)}
                  />
                </div>
              </div>
              {isExpanded && renderLevel(folder.id, depth + 1)}
            </div>
          );
        })}

        {/* New-folder input row at the bottom of this level */}
        {renderFolderInput(parentId)}
      </>
    );
  }

  // ── Loading skeleton ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto bg-white">
        <div className="flex items-start justify-between px-8 py-4">
          <div className="flex items-center gap-1.5 text-2xl font-medium font-serif">
            <span className="text-gray-400">Projects</span>
            <span className="text-gray-300">›</span>
            <div className="h-6 w-40 rounded bg-gray-100 animate-pulse" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-8 w-16 rounded bg-gray-100 animate-pulse" />
            <div className="h-8 w-28 rounded bg-gray-100 animate-pulse" />
          </div>
        </div>
        <div className="flex items-center h-10 px-8 border-b border-gray-200 gap-5">
          <div className="h-3 w-20 rounded bg-gray-100 animate-pulse" />
          <div className="h-3 w-10 rounded bg-gray-100 animate-pulse" />
          <div className="h-3 w-24 rounded bg-gray-100 animate-pulse" />
        </div>
        <div className="flex items-center h-8 pr-8 border-b border-gray-200">
          <div className="w-8 shrink-0" />
          <div className="flex-1 min-w-0 pl-3 pr-4">
            <div className="h-2.5 w-8 rounded bg-gray-100 animate-pulse" />
          </div>
          <div className="w-20 shrink-0">
            <div className="h-2.5 w-8 rounded bg-gray-100 animate-pulse" />
          </div>
          <div className="w-24 shrink-0">
            <div className="h-2.5 w-8 rounded bg-gray-100 animate-pulse" />
          </div>
          <div className="w-8 shrink-0" />
        </div>
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="flex items-center h-10 pr-8 border-b border-gray-50"
          >
            <div className="w-8 shrink-0" />
            <div className="flex-1 min-w-0 pl-3 pr-4">
              <div className="h-3.5 w-56 rounded bg-gray-100 animate-pulse" />
            </div>
            <div className="w-20 shrink-0">
              <div className="h-3 w-8 rounded bg-gray-100 animate-pulse" />
            </div>
            <div className="w-24 shrink-0">
              <div className="h-3 w-12 rounded bg-gray-100 animate-pulse" />
            </div>
            <div className="w-8 shrink-0" />
          </div>
        ))}
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md px-6 text-center">
          {projectLoadError ? (
            <>
              <AlertCircle className="mx-auto mb-3 h-6 w-6 text-red-500" />
              <p className="font-medium text-gray-900">Project cannot be opened</p>
              <p className="mt-2 text-sm text-gray-500">{projectLoadError}</p>
              {registeredProject?.path ? (
                <div className="mt-4 space-y-3">
                  <p className="break-all rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
                    {registeredProject.path}
                  </p>
                  <button
                    type="button"
                    onClick={reconnectProjectFolder}
                    disabled={folderAccessBusy}
                    className="inline-flex h-9 items-center gap-2 rounded-md bg-gray-900 px-3 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {folderAccessBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FolderOpen className="h-4 w-4" />
                    )}
                    Grant Folder Access
                  </button>
                  {folderAccessError ? (
                    <p className="text-sm text-red-600">{folderAccessError}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-gray-400">Project not found</p>
          )}
        </div>
      </div>
    );
  }

  const docs = project.documents || [];
  const q = search.toLowerCase();
  const filteredDocs = q
    ? docs.filter((d) => d.filename.toLowerCase().includes(q))
    : docs;
  const filteredChats = q
    ? chats.filter((c) => (c.title ?? "").toLowerCase().includes(q))
    : chats;
  const filteredReviews = q
    ? projectReviews.filter((r) => (r.title ?? "").toLowerCase().includes(q))
    : projectReviews;

  const allDocsSelected =
    filteredDocs.length > 0 &&
    filteredDocs.every((d) => selectedDocIds.includes(d.id));
  const someDocsSelected =
    !allDocsSelected && filteredDocs.some((d) => selectedDocIds.includes(d.id));
  const allChatsSelected =
    filteredChats.length > 0 &&
    filteredChats.every((c) => selectedChatIds.includes(c.id));
  const someChatsSelected =
    !allChatsSelected &&
    filteredChats.some((c) => selectedChatIds.includes(c.id));
  const allReviewsSelected =
    filteredReviews.length > 0 &&
    filteredReviews.every((r) => selectedReviewIds.includes(r.id));
  const someReviewsSelected =
    !allReviewsSelected &&
    filteredReviews.some((r) => selectedReviewIds.includes(r.id));

  const currentSelectionCount =
    tab === "documents"
      ? selectedDocIds.length
      : tab === "assistant"
        ? selectedChatIds.length
        : selectedReviewIds.length;

  const handleDeleteSelected =
    tab === "documents"
      ? handleDeleteSelectedDocs
      : tab === "assistant"
        ? handleDeleteSelectedChats
        : handleDeleteSelectedReviews;

  const actionsDropdown =
    currentSelectionCount > 0 ? (
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
            {tab === "documents" &&
              selectedDocIds.some(
                (id) => docs.find((d) => d.id === id)?.file_type === "pdf",
              ) && (
                <button
                  onClick={() => void handleExportSelectedAnnotated()}
                  className="w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Export with annotations
                </button>
              )}
            {tab === "documents" && (
              <button
                onClick={() => void handleRescanSelected()}
                className="w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Rescan
              </button>
            )}
            {tab === "documents" &&
              selectedDocIds.some(
                (id) => docs.find((d) => d.id === id)?.folder_id != null,
              ) && (
                <button
                  onClick={handleRemoveSelectedFromFolder}
                  className="w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Remove from subfolder
                </button>
              )}
            <button
              onClick={handleDeleteSelected}
              className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    ) : null;

  const toolbarActions = (
    <div className="flex items-center gap-2">
      {actionsDropdown}
      {tab === "documents" && (
        <>
          <button
            onClick={() => {
              setCreatingFolderIn(null);
              setNewFolderName("");
            }}
            className="flex items-center gap-1 text-xs px-3 font-medium text-gray-500 hover:text-gray-700 transition-colors"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            Add Subfolder
          </button>
          <button
            onClick={() => {
              setSourceFolderOpen(true);
              setSourceFolderError(null);
            }}
            className="flex items-center gap-1 text-xs px-3 font-medium text-gray-500 hover:text-gray-700 transition-colors"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open Folder
          </button>
          <button
            onClick={() => setAddDocsOpen(true)}
            className="flex items-center gap-1 text-xs px-3 font-medium text-gray-500 hover:text-gray-700 transition-colors"
          >
            <Upload className="h-3.5 w-3.5" />
            Add Documents
          </button>
        </>
      )}
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto bg-white flex flex-col h-full">
      {/* Page header */}
      <div className="flex items-start justify-between px-8 py-4">
        <div>
          <div className="flex items-center gap-1.5 text-2xl font-medium font-serif">
            <button
              onClick={() => router.push("/projects")}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              Projects
            </button>
            <span className="text-gray-300">›</span>
            {tab !== "documents" ? (
              <button
                onClick={() => router.push(`/projects/${projectId}`)}
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {project.name}
                {project.cm_number ? (
                  <span className="ml-1 text-gray-400">
                    (#{project.cm_number})
                  </span>
                ) : null}
              </button>
            ) : (
              <RenameableTitle
                value={project.name}
                onCommit={handleTitleCommit}
                suffix={
                  project.cm_number ? (
                    <span className="ml-1 text-gray-400">
                      (#{project.cm_number})
                    </span>
                  ) : null
                }
              />
            )}
            {tab !== "documents" && (
              <>
                <span className="text-gray-300">›</span>
                <span className="text-gray-900">
                  {tab === "assistant" ? "Assistant" : "Tabular Reviews"}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <HeaderSearchBtn
            value={search}
            onChange={setSearch}
            placeholder="Search…"
          />
          <button
            onClick={() => setPeopleModalOpen(true)}
            className="flex h-8 w-8 items-center justify-center text-sm text-gray-500 transition-colors hover:text-gray-900 cursor-pointer"
            title="People with access"
            aria-label="People with access"
          >
            <Users className="h-4 w-4" />
          </button>
          <div className="relative group">
            <button
              onClick={() => !creatingChat && handleNewChat()}
              className={`flex h-8 items-center justify-center gap-1.5 px-3 text-sm transition-colors ${
                !creatingChat
                  ? "text-gray-500 hover:text-gray-900 cursor-pointer"
                  : "text-gray-300 cursor-default"
              }`}
            >
              {creatingChat ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Chat
            </button>
          </div>
          <div className="relative group">
            <button
              onClick={() =>
                docs.length > 0 && !creatingReview && handleNewReview()
              }
              className={`flex h-8 items-center justify-center gap-1.5 px-3 text-sm transition-colors ${
                docs.length > 0
                  ? "text-gray-500 hover:text-gray-900 cursor-pointer"
                  : "text-gray-300 cursor-default"
              }`}
            >
              {creatingReview ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Tabular Review
            </button>
            {docs.length === 0 && (
              <div className="pointer-events-none absolute right-0 top-full mt-1.5 z-10 hidden group-hover:flex items-center whitespace-nowrap rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg">
                Upload a document first
              </div>
            )}
          </div>
        </div>
      </div>

      <ToolbarTabs
        tabs={[
          { id: "documents", label: "Documents" },
          { id: "assistant", label: "Assistant" },
          { id: "reviews", label: "Tabular Reviews" },
        ]}
        active={tab}
        onChange={handleTabChange}
        actions={<>{toolbarActions}</>}
      />

      {tab === "documents" && sourceFolders.length > 0 && (
        <div className="border-b border-gray-100 px-8 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-gray-500">
              Opened folders
            </span>
            {sourceFolders.map((folder) => {
              const busy = rescanningSourceFolderId === folder.id;
              const label =
                folder.display_name?.trim() ||
                folder.display_path?.split(/[\\/]/).filter(Boolean).pop() ||
                folder.root_path.split(/[\\/]/).filter(Boolean).pop() ||
                folder.root_path;
              return (
                <div
                  key={folder.id}
                  data-session-check="source-folder-row"
                  data-source-folder-id={folder.id}
                  className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-2 py-1"
                  title={folder.display_path ?? folder.root_path}
                >
                  <FolderOpen className="h-3.5 w-3.5 text-gray-400" />
                  <span className="max-w-[220px] truncate text-xs text-gray-700">
                    {label}
                  </span>
                  {sourceFolderScanSummary[folder.id] && (
                    <span
                      data-session-check="source-folder-scan-summary"
                      data-source-folder-id={folder.id}
                      className="max-w-[260px] truncate text-[11px] text-gray-400"
                    >
                      {sourceFolderScanSummary[folder.id]}
                    </span>
                  )}
                  <button
                    data-session-check="source-folder-rescan"
                    data-source-folder-id={folder.id}
                    type="button"
                    disabled={busy}
                    onClick={() => handleRescanSourceFolder(folder)}
                    className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-gray-500 hover:bg-white hover:text-gray-800 disabled:cursor-not-allowed disabled:text-gray-300"
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    Rescan
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === "documents" && (
        <div className="border-b border-gray-100 px-8 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium text-gray-700">
                {statusLabel(indexStatus)}
              </span>
              {indexStatus && (
                <>
                  {currentIndexProgress &&
                  currentIndexProgress.total > 0 ? (
                    <CircularProgressPill
                      label="indexing"
                      percent={currentIndexProgress.percent}
                      tone={
                        currentIndexProgress.failed > 0
                          ? "red"
                          : currentIndexProgress.active
                            ? "blue"
                            : currentIndexProgress.percent === 100
                              ? "emerald"
                              : "gray"
                      }
                      title={`${currentIndexProgress.done}/${currentIndexProgress.total} documents processed`}
                    />
                  ) : null}
                  {indexStatus.semantic?.enabled !== false &&
                  currentSemanticProgress &&
                  currentSemanticProgress.total > 0 ? (
                    <CircularProgressPill
                      label="embedding"
                      percent={currentSemanticProgress.percent}
                      tone={
                        currentSemanticProgress.failed > 0 ||
                        indexStatus.semantic?.last_error
                          ? "red"
                          : currentSemanticProgress.active
                            ? "blue"
                            : currentSemanticProgress.percent === 100
                              ? "emerald"
                              : "gray"
                      }
                      title={`${currentSemanticProgress.done}/${currentSemanticProgress.total} vectors processed`}
                    />
                  ) : null}
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-500">
                    {indexStatus.chunk_count} chunks
                  </span>
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-500">
                    {formatBytes(indexStatus.text_bytes)}
                  </span>
                  {indexStatus.status_counts.ready ? (
                    <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-700">
                      {indexStatus.status_counts.ready} ready
                    </span>
                  ) : null}
                  {indexStatus.status_counts.indexing ||
                  indexStatus.status_counts.pending ||
                  indexStatus.queued_jobs ? (
                    <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700">
                      {(indexStatus.status_counts.indexing ?? 0) +
                        (indexStatus.status_counts.pending ?? 0) +
                        indexStatus.queued_jobs}{" "}
                      active
                    </span>
                  ) : null}
                  <span
                    className={`rounded px-2 py-0.5 ${
                      indexStatus.semantic?.enabled === false
                        ? "bg-gray-100 text-gray-500"
                        : indexStatus.semantic?.last_error
                          ? "bg-red-50 text-red-700"
                          : !semanticEmbeddingActive &&
                              (indexStatus.semantic?.ready_vectors ?? 0) <
                                (indexStatus.semantic?.total_vectors ?? 0)
                            ? "bg-amber-50 text-amber-700"
                            : (indexStatus.semantic?.ready_vectors ?? 0) > 0
                              ? "bg-blue-50 text-blue-700"
                              : "bg-gray-100 text-gray-500"
                    }`}
                    title={indexStatus.semantic?.last_error ?? undefined}
                  >
                    semantic{" "}
                    {indexStatus.semantic?.enabled === false
                      ? "disabled"
                      : `${indexStatus.semantic?.ready_vectors ?? 0}/${
                          indexStatus.semantic?.total_vectors ?? 0
                        }${
                          !semanticEmbeddingActive &&
                          (indexStatus.semantic?.ready_vectors ?? 0) <
                            (indexStatus.semantic?.total_vectors ?? 0)
                            ? " · start embedding"
                            : indexStatus.semantic?.paused
                              ? " paused"
                              : ""
                        }`}
                  </span>
                  {indexStatus.semantic?.enabled !== false ? (
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-500">
                      {indexStatus.semantic?.provider ?? "ollama"} ·{" "}
                      {indexStatus.semantic?.model_id ??
                        "batiai/qwen3-embedding:0.6b"}
                    </span>
                  ) : null}
                  {compactStatus ? (
                    <span
                      className={`rounded px-2 py-0.5 ${
                        compactStatus.error
                          ? "bg-red-50 text-red-700"
                          : "bg-emerald-50 text-emerald-700"
                      }`}
                    >
                      {compactStatus.message}
                    </span>
                  ) : null}
                </>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                disabled={
                  embeddingBusy ||
                  compactBusy ||
                  currentIndexProgress?.active ||
                  !semanticEmbeddingAvailable ||
                  (semanticEmbeddingActive && !semanticEmbeddingPaused)
                }
                onClick={() => void handleStartEmbedding()}
                title={
                  currentIndexProgress?.active
                    ? "Wait for lexical indexing to finish"
                    : indexStatus?.semantic?.enabled === false
                      ? "Semantic search is disabled in model settings"
                      : undefined
                }
                className="flex h-7 items-center gap-1 rounded border border-gray-200 px-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
              >
                {embeddingBusy && semanticEmbeddingPaused ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
                Start Embedding
              </button>
              <button
                type="button"
                disabled={
                  embeddingBusy ||
                  compactBusy ||
                  !semanticEmbeddingAvailable ||
                  semanticEmbeddingPaused ||
                  !semanticEmbeddingActive
                }
                onClick={() => void handlePauseEmbedding()}
                className="flex h-7 items-center gap-1 rounded border border-gray-200 px-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
              >
                {embeddingBusy && !semanticEmbeddingPaused ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Pause className="h-3 w-3" />
                )}
                Pause Embedding
              </button>
              <button
                type="button"
                disabled={indexBusy || compactBusy}
                onClick={() => void handleRebuildIndex()}
                className="flex h-7 items-center gap-1 rounded border border-gray-200 px-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
              >
                {indexBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Rebuild
              </button>
              <button
                type="button"
                disabled={
                  compactBusy ||
                  indexBusy ||
                  embeddingBusy ||
                  currentIndexProgress?.active ||
                  currentSemanticProgress?.active
                }
                onClick={() => void handleCompactDatabase()}
                title="Return unused project database space to disk"
                className="flex h-7 items-center gap-1 rounded border border-gray-200 px-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
              >
                {compactBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Database className="h-3 w-3" />
                )}
                Compact Database
              </button>
              <button
                type="button"
                disabled={indexBusy || compactBusy}
                onClick={() => void handleCancelIndexing()}
                className="flex h-7 items-center gap-1 rounded border border-gray-200 px-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
              >
                <X className="h-3 w-3" />
                Cancel
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="relative flex min-w-[260px] flex-1 items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-gray-400" />
              <input
                value={projectSearchQuery}
                onChange={(e) => setProjectSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitProjectSearch();
                }}
                placeholder="Search document text"
                className="h-8 w-full rounded-lg border border-gray-200 pl-8 pr-3 text-sm text-gray-800 outline-none focus:border-gray-400"
              />
            </div>
            <select
              value={projectSearchType}
              onChange={(e) => setProjectSearchType(e.target.value)}
              className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-600 outline-none focus:border-gray-400"
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
              disabled={projectSearchLoading || !projectSearchQuery.trim()}
              onClick={() => void submitProjectSearch()}
              className="flex h-8 items-center gap-1 rounded-lg bg-gray-900 px-3 text-xs font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {projectSearchLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              Search
            </button>
          </div>
          {projectSearchError && (
            <div className="mt-2 text-xs text-red-600">
              {projectSearchError}
            </div>
          )}
          {projectSearchResults.length > 0 && (
            <div className="mt-3 border-t border-gray-100">
              <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-gray-500">
                <span>
                  {projectSearchStartIndex + 1}-{projectSearchEndIndex} of{" "}
                  {projectSearchResults.length}
                </span>
                <label className="flex items-center gap-2">
                  <span>Results per page</span>
                  <select
                    value={projectSearchPageSize}
                    onChange={(e) => {
                      setProjectSearchPageSize(Number(e.target.value));
                      setProjectSearchPage(1);
                    }}
                    className="h-7 rounded border border-gray-200 bg-white px-2 text-xs text-gray-600 outline-none focus:border-gray-400"
                    aria-label="Search results per page"
                  >
                    {PROJECT_SEARCH_PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="divide-y divide-gray-100">
                {projectSearchVisibleResults.map((result) => (
                  <button
                    type="button"
                    key={result.chunk_id}
                    onClick={() => {
                      const doc = docs.find((d) => d.id === result.document_id);
                      if (doc) {
                        openDocumentViewerFromSearch(doc, result);
                      }
                    }}
                    className="flex w-full items-start gap-3 py-2 text-left hover:bg-gray-50"
                  >
                    <DocIcon fileType={result.file_type} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-gray-800">
                          {result.filename}
                        </span>
                        {result.page_number ? (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
                            p. {result.page_number}
                          </span>
                        ) : null}
                        {result.grouped_chunk_count &&
                        result.grouped_chunk_count > 1 ? (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
                            {result.grouped_chunk_count} hits
                          </span>
                        ) : null}
                        {(result.match_reasons?.length
                          ? result.match_reasons
                          : result.basic_match
                            ? (["basic"] as const)
                            : (["keyword"] as const)
                        ).map((reason) => (
                          <span
                            key={reason}
                            className={`rounded px-1.5 py-0.5 text-[11px] ${searchReasonClass(
                              reason,
                            )}`}
                          >
                            {searchReasonLabel(reason)}
                          </span>
                        ))}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">
                        {renderSearchSnippet(
                          result.snippet,
                          projectSearchDisplayQuery,
                        )}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
              {projectSearchPageCount > 1 && (
                <div
                  className="flex flex-wrap items-center gap-1 py-2 text-xs"
                  aria-label="Search results pages"
                >
                  {Array.from(
                    { length: projectSearchPageCount },
                    (_, index) => index + 1,
                  ).map((page) => (
                    <button
                      type="button"
                      key={page}
                      onClick={() => setProjectSearchPage(page)}
                      className={`h-7 min-w-7 rounded px-2 ${
                        page === safeProjectSearchPage
                          ? "bg-gray-900 text-white"
                          : "text-gray-600 hover:bg-gray-100"
                      }`}
                      aria-current={
                        page === safeProjectSearchPage ? "page" : undefined
                      }
                    >
                      {page}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Table content */}
      <div className="w-full flex-1 min-h-0 overflow-x-auto">
        <div className="min-w-max flex min-h-full flex-col">
          {/* Tab: Documents */}
          {tab === "documents" && (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Table header */}
              <div className="flex items-center h-8 pr-8 border-b border-gray-200 text-xs text-gray-500 font-medium select-none shrink-0">
                <div
                  className={`sticky left-0 z-[60] ${CHECK_W} relative bg-white flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-white`}
                >
                  <input
                    type="checkbox"
                    checked={allDocsSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someDocsSelected;
                    }}
                    onChange={() => {
                      if (allDocsSelected) setSelectedDocIds([]);
                      else setSelectedDocIds(filteredDocs.map((d) => d.id));
                    }}
                    className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                  />
                </div>
                <div
                  className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white pl-2 text-left`}
                >
                  Name
                </div>
                <div className="ml-auto w-20 shrink-0 text-left">Type</div>
                <div className="w-24 shrink-0 text-left">Size</div>
                <div className="w-20 shrink-0 text-left">Version</div>
                <div className="w-32 shrink-0 text-left">Created</div>
                <div className="w-32 shrink-0 text-left">Updated</div>
                <div className="w-8 shrink-0" />
              </div>

              {/* Blue ring wraps everything below the header when root-dropping */}
              <div className="flex-1 flex flex-col min-h-0 relative">
                {dragOverRoot && dragOverFolderId === null && (
                  <div className="absolute inset-0 border-2 border-blue-400 pointer-events-none z-20" />
                )}

                {/* Empty state */}
                {docs.length === 0 && folders.length === 0 ? (
                  <div
                    onClick={() => setAddDocsOpen(true)}
                    className="flex-1 flex cursor-pointer flex-col items-center justify-center py-24 text-center"
                  >
                    <Upload className="h-8 w-8 text-gray-200 mb-3" />
                    <p className="text-sm text-gray-400">
                      Drop PDF or DOCX files here
                    </p>
                  </div>
                ) : (
                  <div
                    className="flex-1 flex flex-col"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        folderId: null,
                        showFolderActions: false,
                      });
                    }}
                    onClick={() => setContextMenu(null)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverRoot(true);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDragOverRoot(false);
                      }
                    }}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setDragOverRoot(false);
                      setDragOverFolderId(null);
                      await handleDropOnFolder(null, e.dataTransfer);
                    }}
                  >
                    {/* Search: flat list; no search: folder tree */}
                    {q
                      ? filteredDocs.map((doc) => {
                          const isProcessing =
                            doc.status === "pending" ||
                            doc.status === "processing";
                          const isError = doc.status === "error";
                          const isVersionsOpen = expandedVersionDocIds.has(
                            doc.id,
                          );
                          const isAnnotationsOpen =
                            expandedAnnotationDocIds.has(doc.id);
                          const hasVersions =
                            typeof doc.latest_version_number === "number" &&
                            doc.latest_version_number >= 1;
                          return (
                            <div key={doc.id}>
                              <div
                                data-session-check="project-doc-row"
                                data-document-id={doc.id}
                                onClick={() => {
                                  openDocumentViewer(doc);
                                }}
                                className="group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                              >
                                <div
                                  className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${selectedDocIds.includes(doc.id) ? "bg-gray-50" : "bg-white"} group-hover:bg-gray-50`}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedDocIds.includes(doc.id)}
                                    onChange={() =>
                                      setSelectedDocIds((prev) =>
                                        prev.includes(doc.id)
                                          ? prev.filter((x) => x !== doc.id)
                                          : [...prev, doc.id],
                                      )
                                    }
                                    className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                  />
                                </div>
                                <div
                                  className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${selectedDocIds.includes(doc.id) ? "bg-gray-50" : "bg-white"} group-hover:bg-gray-50`}
                                >
                                  <div className="flex items-center gap-2">
                                    {doc.file_type === "pdf" ? (
                                      <button
                                        data-session-check="project-annotation-toggle"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleAnnotations(doc.id);
                                        }}
                                        title={
                                          isAnnotationsOpen
                                            ? "Hide annotations"
                                            : "Show annotations"
                                        }
                                        className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                                      >
                                        {isAnnotationsOpen ? (
                                          <ChevronDown className="h-3 w-3" />
                                        ) : (
                                          <ChevronRight className="h-3 w-3" />
                                        )}
                                      </button>
                                    ) : (
                                      <span className="h-4 w-4 shrink-0" />
                                    )}
                                    {isProcessing ? (
                                      <Loader2 className="h-4 w-4 animate-spin text-gray-400 shrink-0" />
                                    ) : isError ? (
                                      <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                                    ) : (
                                      <DocIcon fileType={doc.file_type} />
                                    )}
                                    <span className="text-sm text-gray-800 truncate">
                                      {doc.filename}
                                    </span>
                                  </div>
                                </div>
                                <div className="ml-auto w-20 shrink-0 text-xs text-gray-500 uppercase truncate">
                                  {doc.file_type ?? (
                                    <span className="text-gray-300">—</span>
                                  )}
                                </div>
                                <div className="w-24 shrink-0 text-sm text-gray-500 truncate">
                                  {doc.size_bytes != null ? (
                                    formatBytes(doc.size_bytes)
                                  ) : (
                                    <span className="text-gray-300">—</span>
                                  )}
                                </div>
                                <div
                                  className="w-20 shrink-0 text-sm text-gray-500 flex items-center gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {hasVersions ? (
                                    <button
                                      onClick={() =>
                                        void toggleVersions(doc.id)
                                      }
                                      className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-gray-100 transition-colors"
                                    >
                                      <span>{doc.latest_version_number}</span>
                                      {isVersionsOpen ? (
                                        <ChevronDown className="h-3 w-3 text-gray-400" />
                                      ) : (
                                        <ChevronRight className="h-3 w-3 text-gray-400" />
                                      )}
                                    </button>
                                  ) : (
                                    <span className="text-gray-300 pl-1">
                                      —
                                    </span>
                                  )}
                                </div>
                                <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                                  {doc.created_at ? (
                                    formatDate(doc.created_at)
                                  ) : (
                                    <span className="text-gray-300">—</span>
                                  )}
                                </div>
                                <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                                  {doc.updated_at ? (
                                    formatDate(doc.updated_at)
                                  ) : (
                                    <span className="text-gray-300">—</span>
                                  )}
                                </div>
                                <div className="w-8 shrink-0 flex justify-end">
                                  {!isProcessing && (
                                    <RowActions
                                      onExportAnnotated={
                                        doc.file_type === "pdf"
                                          ? () =>
                                                void handleExportAnnotatedClick(
                                                    doc,
                                                )
                                          : undefined
                                      }
                                      onRescan={() =>
                                        void handleRescanDocClick(doc)
                                      }
                                      onShowAllVersions={
                                        hasVersions && !isVersionsOpen
                                          ? () => void toggleVersions(doc.id)
                                          : undefined
                                      }
                                      onDelete={() => handleRemoveDoc(doc.id)}
                                    />
                                  )}
                                </div>
                              </div>
                              {isAnnotationsOpen && (
                                <DocAnnotationRows
                                  docId={doc.id}
                                  loading={loadingAnnotationDocIds.has(doc.id)}
                                  annotations={
                                    annotationsByDocId.get(doc.id) ?? []
                                  }
                                  onOpen={(ann) =>
                                    openDocumentViewer(doc, {
                                      annotation: ann,
                                    })
                                  }
                                  onDelete={(annotationId) =>
                                    void handleDeleteAnnotation(
                                      doc.id,
                                      annotationId,
                                    )
                                  }
                                  onDeleteMany={(annotationIds) =>
                                    void handleDeleteAnnotations(
                                      doc.id,
                                      annotationIds,
                                    )
                                  }
                                />
                              )}
                              {isVersionsOpen && (
                                <DocVersionHistory
                                  docId={doc.id}
                                  filename={doc.filename}
                                  loading={loadingVersionDocIds.has(doc.id)}
                                  versions={versionsByDocId.get(doc.id) ?? []}
                                  onDownloadVersion={downloadDocVersion}
                                  onOpenVersion={(versionId, label) => {
                                    openDocumentViewer(doc, {
                                      version: {
                                        id: versionId,
                                        label,
                                      },
                                    });
                                  }}
                                  onRenameVersion={(versionId, displayName) =>
                                    handleRenameVersion(
                                      doc.id,
                                      versionId,
                                      displayName,
                                    )
                                  }
                                />
                              )}
                            </div>
                          );
                        })
                      : renderLevel(null, 0)}
                    {/* Spacer — fills remaining height and extends the root drop zone */}
                    <div className="flex-1 min-h-16" />
                  </div>
                )}

                {/* Context menu */}
                {contextMenu && (
                  <div
                    ref={contextMenuRef}
                    className="fixed z-50 w-44 rounded-lg border border-gray-100 bg-white shadow-lg overflow-hidden text-xs"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="w-full px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                      onClick={() => {
                        setCreatingFolderIn(contextMenu.folderId);
                        setNewFolderName("");
                        if (contextMenu.folderId)
                          setExpandedFolderIds(
                            (prev) => new Set([...prev, contextMenu.folderId!]),
                          );
                        setContextMenu(null);
                      }}
                    >
                      <FolderPlus className="h-3.5 w-3.5 text-gray-400" />
                      {contextMenu.showFolderActions
                        ? "New subfolder inside"
                        : "New subfolder"}
                    </button>
                    {contextMenu.showFolderActions && contextMenu.folderId && (
                      <>
                        <button
                          className="w-full px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50"
                          onClick={() => {
                            const f = folders.find(
                              (x) => x.id === contextMenu.folderId,
                            );
                            setRenameFolderValue(f?.name ?? "");
                            setRenamingFolderId(contextMenu.folderId!);
                            setContextMenu(null);
                          }}
                        >
                          Rename folder
                        </button>
                        <button
                          className="w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                          onClick={() => {
                            handleDeleteFolder(contextMenu.folderId!);
                            setContextMenu(null);
                          }}
                        >
                          Delete folder
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {/* end blue ring wrapper */}
            </div>
          )}

          {/* Tab: Assistant */}
          {tab === "assistant" && (
            <>
              <div className="flex items-center h-8 pr-8 border-b border-gray-200 text-xs text-gray-500 font-medium select-none">
                <div
                  className={`sticky left-0 z-[60] ${CHECK_W} relative bg-white flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-white`}
                >
                  <input
                    type="checkbox"
                    checked={allChatsSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someChatsSelected;
                    }}
                    onChange={() => {
                      if (allChatsSelected) setSelectedChatIds([]);
                      else setSelectedChatIds(filteredChats.map((c) => c.id));
                    }}
                    className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                  />
                </div>
                <div
                  className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white pl-2 text-left`}
                >
                  Chats
                </div>
                <div className="ml-auto w-32 shrink-0 text-left">Created</div>
                <div className="w-8 shrink-0" />
              </div>
              {chats.length === 0 ? (
                <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                  <MessageSquare className="h-8 w-8 text-gray-300 mb-4" />
                  <p className="text-2xl font-medium font-serif text-gray-900">
                    Assistant
                  </p>
                  <p className="mt-1 text-xs text-gray-400 max-w-xs">
                    Ask questions and get answers grounded in the documents in
                    this project.
                  </p>
                  <button
                    onClick={() => handleNewChat()}
                    className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 transition-colors shadow-md"
                  >
                    + Create New
                  </button>
                </div>
              ) : (
                <div>
                  {filteredChats.map((chat) => (
                    <div
                      key={chat.id}
                      onClick={() => {
                        if (renamingChatId === chat.id) return;
                        router.push(
                          `/projects/${projectId}/assistant/chat/${chat.id}`,
                        );
                      }}
                      className="group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                    >
                      <div
                        className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${selectedChatIds.includes(chat.id) ? "bg-gray-50" : "bg-white"} group-hover:bg-gray-50`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedChatIds.includes(chat.id)}
                          onChange={() =>
                            setSelectedChatIds((prev) =>
                              prev.includes(chat.id)
                                ? prev.filter((x) => x !== chat.id)
                                : [...prev, chat.id],
                            )
                          }
                          className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                        />
                      </div>
                      <div
                        className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${selectedChatIds.includes(chat.id) ? "bg-gray-50" : "bg-white"} group-hover:bg-gray-50`}
                      >
                        {renamingChatId === chat.id ? (
                          <input
                            autoFocus
                            value={renameChatValue}
                            onChange={(e) => setRenameChatValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") submitChatRename(chat.id);
                              if (e.key === "Escape") setRenamingChatId(null);
                            }}
                            onBlur={() => submitChatRename(chat.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full text-sm text-gray-800 bg-transparent outline-none"
                          />
                        ) : (
                          <span className="text-sm text-gray-800 truncate block">
                            {chat.title ?? "Untitled Chat"}
                          </span>
                        )}
                      </div>
                      <div className="ml-auto w-32 shrink-0 text-sm text-gray-500 truncate">
                        {formatDate(chat.created_at)}
                      </div>
                      <div
                        className="w-8 shrink-0 flex justify-end"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <RowActions
                          onRename={() => {
                            if (user?.id && chat.user_id !== user.id) {
                              setOwnerOnlyAction("rename this chat");
                              return;
                            }
                            setRenameChatValue(chat.title ?? "Untitled Chat");
                            setRenamingChatId(chat.id);
                          }}
                          onDelete={async () => {
                            if (user?.id && chat.user_id !== user.id) {
                              setOwnerOnlyAction("delete this chat");
                              return;
                            }
                            await deleteChat(chat.id);
                            setChats((prev) =>
                              prev.filter((c) => c.id !== chat.id),
                            );
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Tab: Reviews */}
          {tab === "reviews" && (
            <>
              <div className="flex items-center h-8 pr-8 border-b border-gray-200 text-xs text-gray-500 font-medium select-none">
                <div
                  className={`sticky left-0 z-[60] ${CHECK_W} relative bg-white flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-white`}
                >
                  <input
                    type="checkbox"
                    checked={allReviewsSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someReviewsSelected;
                    }}
                    onChange={() => {
                      if (allReviewsSelected) setSelectedReviewIds([]);
                      else
                        setSelectedReviewIds(filteredReviews.map((r) => r.id));
                    }}
                    className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                  />
                </div>
                <div
                  className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white pl-2 text-left`}
                >
                  Name
                </div>
                <div className="ml-auto w-24 shrink-0 text-left">Columns</div>
                <div className="w-24 shrink-0 text-left">Documents</div>
                <div className="w-32 shrink-0 text-left">Created</div>
                <div className="w-8 shrink-0" />
              </div>
              {projectReviews.length === 0 ? (
                <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                  <Table2 className="h-8 w-8 text-gray-300 mb-4" />
                  <p className="text-2xl font-medium font-serif text-gray-900">
                    Tabular Reviews
                  </p>
                  <p className="mt-1 text-xs text-gray-400 max-w-xs">
                    Extract data from project documents into tables using AI.
                  </p>
                  <button
                    onClick={handleNewReview}
                    disabled={creatingReview || docs.length === 0}
                    className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 transition-colors shadow-md disabled:opacity-40"
                  >
                    + Create New
                  </button>
                </div>
              ) : (
                <div>
                  {filteredReviews.map((review) => (
                    <div
                      key={review.id}
                      onClick={() => {
                        if (renamingReviewId === review.id) return;
                        router.push(
                          `/projects/${projectId}/tabular-reviews/${review.id}`,
                        );
                      }}
                      className="group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                    >
                      <div
                        className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${selectedReviewIds.includes(review.id) ? "bg-gray-50" : "bg-white"} group-hover:bg-gray-50`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedReviewIds.includes(review.id)}
                          onChange={() =>
                            setSelectedReviewIds((prev) =>
                              prev.includes(review.id)
                                ? prev.filter((x) => x !== review.id)
                                : [...prev, review.id],
                            )
                          }
                          className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                        />
                      </div>
                      <div
                        className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${selectedReviewIds.includes(review.id) ? "bg-gray-50" : "bg-white"} group-hover:bg-gray-50`}
                      >
                        {renamingReviewId === review.id ? (
                          <input
                            autoFocus
                            value={renameReviewValue}
                            onChange={(e) =>
                              setRenameReviewValue(e.target.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter")
                                submitReviewRename(review.id);
                              if (e.key === "Escape") setRenamingReviewId(null);
                            }}
                            onBlur={() => submitReviewRename(review.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full text-sm text-gray-800 bg-transparent outline-none"
                          />
                        ) : (
                          <span className="text-sm text-gray-800 truncate block">
                            {review.title ?? "Untitled Review"}
                          </span>
                        )}
                      </div>
                      <div className="ml-auto w-24 shrink-0 text-sm text-gray-500 truncate">
                        {review.columns_config?.length ?? 0}
                      </div>
                      <div className="w-24 shrink-0 text-sm text-gray-500 truncate">
                        {review.document_count ?? 0}
                      </div>
                      <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                        {review.created_at ? (
                          formatDate(review.created_at)
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </div>
                      <div
                        className="w-8 shrink-0 flex justify-end"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <RowActions
                          onRename={() => {
                            if (user?.id && review.user_id !== user.id) {
                              setOwnerOnlyAction("rename this tabular review");
                              return;
                            }
                            setRenameReviewValue(
                              review.title ?? "Untitled Review",
                            );
                            setRenamingReviewId(review.id);
                          }}
                          onDelete={async () => {
                            if (user?.id && review.user_id !== user.id) {
                              setOwnerOnlyAction("delete this tabular review");
                              return;
                            }
                            await deleteTabularReview(review.id);
                            setProjectReviews((prev) =>
                              prev.filter((r) => r.id !== review.id),
                            );
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <AddDocumentsModal
        open={addDocsOpen}
        onClose={() => setAddDocsOpen(false)}
        onSelect={handleDocsSelected}
        breadcrumb={[
          "Projects",
          project.name + (project.cm_number ? ` (${project.cm_number})` : ""),
          "Add Documents",
        ]}
        projectId={projectId}
      />

      <SourceFolderModal
        open={sourceFolderOpen}
        busy={sourceFolderBusy}
        error={sourceFolderError}
        path={sourceFolderPath}
        onPathChange={setSourceFolderPath}
        onPick={pickSourceFolder}
        onClose={() => setSourceFolderOpen(false)}
        onSubmit={submitSourceFolder}
      />

      <DocViewModal
        doc={viewingDoc}
        versionId={viewingDocVersion?.id ?? null}
        versionLabel={viewingDocVersion?.label ?? null}
        initialSearchQuote={viewingDocSearchTarget?.quote ?? null}
        initialSearchPage={viewingDocSearchTarget?.page ?? null}
        initialSearchKey={viewingDocSearchTarget?.key ?? null}
        onClose={() => {
          setViewingDoc(null);
          setViewingDocVersion(null);
          setViewingDocSearchTarget(null);
        }}
        onDelete={(doc) => handleRemoveDoc(doc.id)}
      />

      <AddNewTRModal
        open={newTRModalOpen}
        onClose={() => setNewTRModalOpen(false)}
        onAdd={handleCreateReview}
        projectDocs={project?.documents?.filter((d) => d.status === "ready")}
        projectName={project?.name}
        projectCmNumber={project?.cm_number}
      />

      <OwnerOnlyModal
        open={!!ownerOnlyAction}
        action={ownerOnlyAction ?? undefined}
        onClose={() => setOwnerOnlyAction(null)}
      />

      <PeopleModal
        open={peopleModalOpen}
        onClose={() => setPeopleModalOpen(false)}
        resource={project}
        fetchPeople={getProjectPeople}
        currentUserEmail={user?.email ?? null}
        breadcrumb={[
          "Projects",
          project
            ? project.name +
              (project.cm_number ? ` (${project.cm_number})` : "")
            : "",
          "People",
        ]}
        // Only owners may modify the member list. Without this prop
        // PeopleModal renders read-only — non-owners can still see
        // who has access but the add/remove controls are hidden.
        onSharedWithChange={
          project.is_owner === false
            ? undefined
            : async (next) => {
                const updated = await updateProject(projectId, {
                  shared_with: next,
                });
                setProject((prev) =>
                  prev
                    ? {
                        ...prev,
                        shared_with: updated.shared_with,
                      }
                    : prev,
                );
              }
        }
      />
    </div>
  );
}
