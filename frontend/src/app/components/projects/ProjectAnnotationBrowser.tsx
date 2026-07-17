"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, MessageSquareText } from "lucide-react";
import { listProjectAnnotations } from "@/app/lib/docketApi";
import type {
  AnnotationColorFamily,
  DocketDocument,
  ProjectAnnotation,
  ProjectAnnotationsResponse,
} from "@/app/components/shared/types";
import {
  colorFamilyLabel,
  orderColorFamilyChips,
} from "./projectAnnotationBrowser.logic";

interface Props {
  projectId: string;
  documents: DocketDocument[];
  refreshKey?: number;
  onOpen: (
    doc: DocketDocument,
    target: { id: string; page_number: number; quote: string | null },
  ) => void;
  legend?: Partial<Record<AnnotationColorFamily, string>>;
}

type ColorCount =
  ProjectAnnotationsResponse["group_counts"]["by_color_family"][number];

const FAMILY_SWATCH: Record<AnnotationColorFamily, string> = {
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
  pink: "#ec4899",
  gray: "#9ca3af",
};

export function ProjectAnnotationBrowser({
  projectId,
  documents,
  refreshKey = 0,
  onOpen,
  legend,
}: Props) {
  const [selectedColors, setSelectedColors] = useState<
    Set<AnnotationColorFamily>
  >(() => new Set());
  const [commentsOnly, setCommentsOnly] = useState(false);
  const [order, setOrder] = useState<"position" | "recent">("position");
  const [rows, setRows] = useState<ProjectAnnotation[]>([]);
  const [colorCounts, setColorCounts] = useState<ColorCount[]>([]);
  const [total, setTotal] = useState(0);
  const [projectTotal, setProjectTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedColorList = useMemo(
    () => Array.from(selectedColors),
    [selectedColors],
  );
  const selectedColorKey = selectedColorList.join(",");

  const load = useCallback(
    async (offset: number, append: boolean, signal?: AbortSignal) => {
      const result = await listProjectAnnotations(projectId, {
        colorFamily:
          selectedColorList.length > 0 ? selectedColorList : undefined,
        hasComment: commentsOnly ? true : undefined,
        order,
        limit: 50,
        offset,
      });
      if (signal?.aborted) return;
      setRows((previous) =>
        append ? [...previous, ...result.annotations] : result.annotations,
      );
      setColorCounts(result.group_counts.by_color_family);
      setTotal(result.total);
      setProjectTotal(result.project_total);
      setNextOffset(result.next_offset);
      setWarnings(result.warnings);
      setError(null);
    },
    // selectedColorKey is the stable value dependency for the derived array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commentsOnly, order, projectId, selectedColorKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void load(0, false, controller.signal)
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError((reason as Error).message || "Could not load annotations");
          setRows([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, refreshKey]);

  async function loadMore() {
    if (nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    try {
      await load(nextOffset, true);
    } catch (reason) {
      setError((reason as Error).message || "Could not load more annotations");
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleColor(family: AnnotationColorFamily | null) {
    if (family === null) return;
    setSelectedColors((previous) => {
      const next = new Set(previous);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  }

  const chips = orderColorFamilyChips([
    ...colorCounts,
    ...selectedColorList
      .filter(
        (family) => !colorCounts.some((count) => count.color_family === family),
      )
      .map((family) => ({ color_family: family, count: 0 })),
  ]);

  return (
    <section
      data-session-check="project-annotation-browser"
      className="flex min-h-0 flex-1 flex-col bg-white"
      aria-label="All project highlights"
    >
      <div className="border-b border-gray-100 px-8 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-gray-900">
              All highlights
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {total} of {projectTotal} annotations
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5 text-gray-600">
              <input
                type="checkbox"
                checked={commentsOnly}
                onChange={(event) => setCommentsOnly(event.target.checked)}
                className="h-3 w-3 rounded border-gray-300 accent-gray-900"
              />
              With comments
            </label>
            <select
              aria-label="Annotation order"
              value={order}
              onChange={(event) =>
                setOrder(event.target.value as "position" | "recent")
              }
              className="h-7 rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-700"
            >
              <option value="position">Document position</option>
              <option value="recent">Most recent</option>
            </select>
          </div>
        </div>

        {chips.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {chips.map((chip) => {
              const selected =
                chip.color_family !== null &&
                selectedColors.has(chip.color_family);
              return (
                <button
                  key={chip.color_family ?? "unclassified"}
                  type="button"
                  disabled={chip.color_family === null}
                  aria-pressed={selected}
                  onClick={() => toggleColor(chip.color_family)}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors ${
                    selected
                      ? "border-gray-800 bg-gray-900 text-white"
                      : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                  } disabled:cursor-default disabled:opacity-60`}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full border border-black/10"
                    style={{
                      backgroundColor:
                        chip.color_family === null
                          ? "transparent"
                          : FAMILY_SWATCH[chip.color_family],
                    }}
                  />
                  {colorFamilyLabel(chip.color_family, legend)}
                  <span
                    className={selected ? "text-gray-300" : "text-gray-400"}
                  >
                    {chip.count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="mx-8 mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {warnings.join(" ")}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading annotations…
          </div>
        ) : error && rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <AlertCircle className="mb-2 h-5 w-5 text-red-400" />
            <p className="text-sm text-red-600">{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <MessageSquareText className="mb-2 h-6 w-6 text-gray-200" />
            <p className="text-sm text-gray-400">No annotations found</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {rows.map((annotation) => {
              const document = documents.find(
                (item) => item.id === annotation.document_id,
              );
              const preview =
                annotation.annotation_type === "comment"
                  ? annotation.comment || annotation.quote
                  : annotation.quote || annotation.comment;
              return (
                <button
                  key={annotation.id}
                  data-session-check="project-annotation-browser-row"
                  type="button"
                  disabled={!document}
                  onClick={() => {
                    if (!document) return;
                    onOpen(document, {
                      id: annotation.id,
                      page_number: annotation.page_number,
                      quote: annotation.quote,
                    });
                  }}
                  className="grid w-full grid-cols-[24px_minmax(180px,280px)_80px_minmax(240px,1fr)] items-center gap-3 px-8 py-3 text-left hover:bg-gray-50 disabled:cursor-default disabled:opacity-60"
                >
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded-full border border-black/10 text-[9px] font-semibold text-gray-700"
                    style={{ backgroundColor: annotation.color ?? "#e5e7eb" }}
                    title={annotation.annotation_type}
                  >
                    {annotation.annotation_type === "comment" ? "C" : "A"}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-gray-800">
                      {annotation.filename}
                    </span>
                    {annotation.folder_path && (
                      <span className="block truncate text-xs text-gray-400">
                        {annotation.folder_path}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-gray-500">
                    p.{annotation.page_number}
                  </span>
                  <span className="truncate text-sm text-gray-600">
                    {preview ? `“${preview}”` : "No text captured"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {nextOffset !== null && !loading && (
        <div className="border-t border-gray-100 px-8 py-3 text-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-gray-200 px-3 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60"
          >
            {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Load more
          </button>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
      )}
    </section>
  );
}
