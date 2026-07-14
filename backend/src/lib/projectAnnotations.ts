import { z } from "zod";
import {
  classifyAnnotationColor,
  type AnnotationColorFamily,
} from "./annotationColors";
import type { createServerSupabase } from "./supabase";

const COLOR_FAMILIES = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "gray",
] as const;

export const projectAnnotationQuerySchema = z.object({
  color_family: z.array(z.enum(COLOR_FAMILIES)).optional(),
  doc_id: z.array(z.string().min(1)).optional(),
  annotation_type: z.enum(["highlight", "comment"]).optional(),
  has_comment: z.boolean().optional(),
  source: z.enum(["user", "citation_promotion"]).optional(),
  order: z.enum(["position", "recent"]).default("position"),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  party_role: z.array(z.string().min(1)).optional(),
  party_side: z.array(z.enum(["A", "B"])).optional(),
  // Legacy convenience alias retained for existing clients.
  party: z.enum(["plaintiff", "defendant"]).optional(),
});

export type ProjectAnnotationQuery = z.infer<
  typeof projectAnnotationQuerySchema
>;

function csvValues(value: unknown, lowercase: boolean): string[] | undefined {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string") return [String(raw)];
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (lowercase ? item.toLowerCase() : item));
  return values.length > 0 ? values : undefined;
}

function booleanValue(value: unknown): unknown {
  if (value == null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function numberValue(value: unknown): unknown {
  if (value == null || value === "") return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

export function parseProjectAnnotationQuery(
  raw: Record<string, unknown>,
): { ok: true; value: ProjectAnnotationQuery } | { ok: false; detail: string } {
  const parsed = projectAnnotationQuerySchema.safeParse({
    color_family: csvValues(raw.color_family, true),
    // Document IDs are opaque. In particular, do not lowercase CSV values.
    doc_id: csvValues(raw.doc_id, false),
    annotation_type: raw.annotation_type || undefined,
    has_comment: booleanValue(raw.has_comment),
    source: raw.source || undefined,
    order: raw.order || undefined,
    limit: numberValue(raw.limit),
    offset: numberValue(raw.offset),
    party_role: csvValues(raw.party_role, false),
    party_side: csvValues(raw.party_side, false)?.map((side) =>
      side.toUpperCase(),
    ),
    party: raw.party || undefined,
  });
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    detail: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
      .join("; "),
  };
}

// Mirrors annotationIsCurrent() in chatTools.ts: a row is current when it is
// not deleted and either the document has no pinned version or versions match.
export function annotationRowIsCurrent(
  row: { deleted_at?: string | null; version_id: string | null },
  currentVersionId: string | null,
): boolean {
  return (
    !row.deleted_at &&
    (!currentVersionId || row.version_id === currentVersionId)
  );
}

export type ProjectDocMeta = {
  document_id: string;
  filename: string;
  current_version_id: string | null;
  folder_path: string | null;
  party_role?: string | null;
  party_side?: "A" | "B" | null;
};

type ProjectDocumentDbRow = {
  id: string;
  filename: string;
  current_version_id?: string | null;
  folder_id?: string | null;
  party_role?: string | null;
  party_side?: "A" | "B" | null;
};

type ProjectFolderDbRow = {
  id: string;
  name: string;
  parent_folder_id?: string | null;
};

export function buildProjectDocMeta(
  documentRows: ProjectDocumentDbRow[],
  folderRows: ProjectFolderDbRow[],
): ProjectDocMeta[] {
  const folders = new Map(
    folderRows.map((folder) => [
      folder.id,
      {
        name: folder.name,
        parentId: folder.parent_folder_id ?? null,
      },
    ]),
  );

  function resolveFolderPath(folderId: string | null): string | null {
    if (!folderId) return null;
    const parts: string[] = [];
    const seen = new Set<string>();
    let current: string | null = folderId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const folder = folders.get(current);
      if (!folder) break;
      parts.unshift(folder.name);
      current = folder.parentId;
    }
    return parts.length > 0 ? parts.join(" / ") : null;
  }

  return documentRows.map((document) => ({
    document_id: document.id,
    filename: document.filename,
    current_version_id: document.current_version_id ?? null,
    folder_path: resolveFolderPath(document.folder_id ?? null),
    ...(document.party_role !== undefined
      ? { party_role: document.party_role }
      : {}),
    ...(document.party_side !== undefined
      ? { party_side: document.party_side }
      : {}),
  }));
}

export type ProjectAnnotationDbRow = {
  id: string;
  document_id: string;
  version_id: string | null;
  page_number: number;
  annotation_type: "highlight" | "comment";
  color: string | null;
  quote: string | null;
  comment: string | null;
  source: string | null;
  created_at: string;
  deleted_at?: string | null;
};

export type ProjectAnnotationRow = {
  id: string;
  document_id: string;
  version_id: string | null;
  filename: string;
  folder_path: string | null;
  page_number: number;
  annotation_type: "highlight" | "comment";
  color: string | null;
  color_family: AnnotationColorFamily | null;
  quote: string | null;
  comment: string | null;
  source: string | null;
  created_at: string;
};

export type ProjectAnnotationsResult = {
  annotations: ProjectAnnotationRow[];
  total: number;
  returned: number;
  next_offset: number | null;
  project_total: number;
  group_counts: {
    by_color_family: Array<{
      color_family: AnnotationColorFamily | null;
      count: number;
    }>;
    by_document: Array<{
      document_id: string;
      filename: string;
      count: number;
    }>;
  };
  applied_filters: {
    color_family: AnnotationColorFamily[] | null;
    doc_id: string[] | null;
    annotation_type: "highlight" | "comment" | null;
    has_comment: boolean | null;
    source: "user" | "citation_promotion" | null;
    party_role: string[] | null;
    party_side: Array<"A" | "B"> | null;
    party: "plaintiff" | "defendant" | null;
    order: "position" | "recent";
  };
  warnings: string[];
};

function emptyResult(query: ProjectAnnotationQuery): ProjectAnnotationsResult {
  return {
    annotations: [],
    total: 0,
    returned: 0,
    next_offset: null,
    project_total: 0,
    group_counts: { by_color_family: [], by_document: [] },
    applied_filters: appliedFilters(query),
    warnings: [],
  };
}

function appliedFilters(
  query: ProjectAnnotationQuery,
): ProjectAnnotationsResult["applied_filters"] {
  return {
    color_family: query.color_family ?? null,
    doc_id: query.doc_id ?? null,
    annotation_type: query.annotation_type ?? null,
    has_comment: query.has_comment ?? null,
    source: query.source ?? null,
    party_role: query.party_role ?? null,
    party_side: query.party_side ?? null,
    party: query.party ?? null,
    order: query.order,
  };
}

function hasComment(row: ProjectAnnotationDbRow): boolean {
  return typeof row.comment === "string" && row.comment.trim().length > 0;
}

export async function fetchProjectAnnotations(args: {
  db: ReturnType<typeof createServerSupabase>;
  userId: string;
  documents: ProjectDocMeta[];
  query: ProjectAnnotationQuery;
}): Promise<ProjectAnnotationsResult> {
  const { db, userId, documents, query } = args;
  if (documents.length === 0) return emptyResult(query);

  const documentIds = documents.map((document) => document.document_id);
  const { data, error } = await db
    .from("pdf_annotations")
    .select(
      "id, document_id, version_id, page_number, annotation_type, color, quote, comment, source, created_at, deleted_at",
    )
    .eq("user_id", userId)
    .in("document_id", documentIds)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);

  const documentById = new Map(
    documents.map((document) => [document.document_id, document]),
  );
  const rowsCurrent = (
    (data ?? []) as unknown as ProjectAnnotationDbRow[]
  ).filter((row) => {
    const document = documentById.get(row.document_id);
    return (
      !!document && annotationRowIsCurrent(row, document.current_version_id)
    );
  });

  const docIds = query.doc_id ? new Set(query.doc_id) : null;
  const partyRoles = new Set(query.party_role ?? []);
  const partySides = new Set(query.party_side ?? []);
  const legacyPartyRoles = query.party === "plaintiff"
    ? new Set(["plaintiff", "원고"])
    : query.party === "defendant"
      ? new Set(["defendant", "피고"])
      : null;
  const rowsForFacets = rowsCurrent.filter((row) => {
    if (docIds && !docIds.has(row.document_id)) return false;
    const document = documentById.get(row.document_id);
    if (!document) return false;
    if (partyRoles.size && !partyRoles.has(document.party_role ?? "")) return false;
    if (
      partySides.size &&
      (!document.party_side || !partySides.has(document.party_side))
    ) {
      return false;
    }
    if (legacyPartyRoles && !legacyPartyRoles.has(document.party_role ?? "")) {
      return false;
    }
    if (
      query.annotation_type &&
      row.annotation_type !== query.annotation_type
    ) {
      return false;
    }
    if (
      query.has_comment !== undefined &&
      hasComment(row) !== query.has_comment
    ) {
      return false;
    }
    if (query.source && row.source !== query.source) return false;
    return true;
  });

  const colorCounts = new Map<AnnotationColorFamily | null, number>();
  for (const row of rowsForFacets) {
    const family = classifyAnnotationColor(row.color)?.family ?? null;
    colorCounts.set(family, (colorCounts.get(family) ?? 0) + 1);
  }
  const colorOrder: Array<AnnotationColorFamily | null> = [
    ...COLOR_FAMILIES,
    null,
  ];
  const byColorFamily = colorOrder
    .filter((family) => colorCounts.has(family))
    .map((family) => ({
      color_family: family,
      count: colorCounts.get(family) ?? 0,
    }));

  const selectedColors = query.color_family
    ? new Set(query.color_family)
    : null;
  const rowsFiltered = rowsForFacets.filter((row) => {
    if (!selectedColors) return true;
    const family = classifyAnnotationColor(row.color)?.family ?? null;
    return family !== null && selectedColors.has(family);
  });

  const documentCounts = new Map<string, number>();
  for (const row of rowsFiltered) {
    documentCounts.set(
      row.document_id,
      (documentCounts.get(row.document_id) ?? 0) + 1,
    );
  }
  const byDocument = documents
    .filter((document) => documentCounts.has(document.document_id))
    .map((document) => ({
      document_id: document.document_id,
      filename: document.filename,
      count: documentCounts.get(document.document_id) ?? 0,
    }))
    .sort((left, right) =>
      left.filename.localeCompare(right.filename, undefined, {
        sensitivity: "base",
      }),
    );

  const sorted = [...rowsFiltered].sort((left, right) => {
    if (query.order === "recent") {
      return (
        right.created_at.localeCompare(left.created_at) ||
        left.id.localeCompare(right.id)
      );
    }
    const leftDocument = documentById.get(left.document_id)!;
    const rightDocument = documentById.get(right.document_id)!;
    return (
      leftDocument.filename.localeCompare(rightDocument.filename, undefined, {
        sensitivity: "base",
      }) ||
      left.page_number - right.page_number ||
      left.created_at.localeCompare(right.created_at) ||
      left.id.localeCompare(right.id)
    );
  });

  const page = sorted.slice(query.offset, query.offset + query.limit);
  const annotations = page.map((row): ProjectAnnotationRow => {
    const document = documentById.get(row.document_id)!;
    return {
      id: row.id,
      document_id: row.document_id,
      version_id: row.version_id,
      filename: document.filename,
      folder_path: document.folder_path,
      page_number: row.page_number,
      annotation_type: row.annotation_type,
      color: row.color,
      color_family: classifyAnnotationColor(row.color)?.family ?? null,
      quote: row.quote,
      comment: row.comment,
      source: row.source,
      created_at: row.created_at,
    };
  });
  const nextOffset = query.offset + annotations.length;

  return {
    annotations,
    total: rowsFiltered.length,
    returned: annotations.length,
    next_offset: nextOffset < rowsFiltered.length ? nextOffset : null,
    project_total: rowsCurrent.length,
    group_counts: {
      by_color_family: byColorFamily,
      by_document: byDocument,
    },
    applied_filters: appliedFilters(query),
    warnings: [],
  };
}
