/**
 * Docket API client — all requests to the Node.js backend.
 * Attaches the Supabase auth token for user authentication.
 */

import { clearLocalSessionCache, supabase } from "@/lib/supabase";
import type {
  AssistantEvent,
  DocketChat,
  DocketChatDetailOut,
  DocketCitationAnnotation,
  DocketDocument,
  DocketFolder,
  DocketMessage,
  AnnotationColorFamily,
  PdfAnnotation,
  PdfAnnotationRect,
  ProjectAnnotationsResponse,
  DocketProject,
  DocketWorkflow,
  TabularReview,
  TabularReviewDetailOut,
} from "@/app/components/shared/types";
import { buildProjectAnnotationQueryString } from "@/app/components/projects/projectAnnotationBrowser.logic";

// Server-side shape before mapping
interface ServerMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | AssistantEvent[] | null;
  files?: { filename: string; document_id?: string }[] | null;
  workflow?: { id: string; title: string } | null;
  annotations?: DocketCitationAnnotation[] | null;
  created_at: string;
}
interface ServerChatDetailOut {
  chat: DocketChat;
  messages: ServerMessage[];
}

// C3: backend binds to an OS-assigned port. Read it via the Electron preload
// (`window.docket.getApiPort()`), cache for the session — port doesn't change
// without a relaunch. The fallback keeps `next dev` working in a browser.
const FALLBACK_API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

let cachedApiBase: string | null = null;

export class DocketApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DocketApiError";
  }
}

export async function getApiBase(): Promise<string> {
  if (typeof window !== "undefined") {
    const bridge = window.docket as
      { getApiPort?: () => Promise<number> } | undefined;
    if (bridge?.getApiPort) {
      try {
        const port = await bridge.getApiPort();
        if (port && Number.isFinite(port)) {
          return `http://localhost:${port}`;
        }
      } catch {
        // fall through to the env-configured base
      }
    }
    if (bridge?.getApiPort) {
      return FALLBACK_API_BASE;
    }
  }
  if (cachedApiBase) return cachedApiBase;
  cachedApiBase = FALLBACK_API_BASE;
  return cachedApiBase;
}

async function getAuthHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeaders = await getAuthHeader();
  const { headers: initHeaders, ...restInit } = init ?? {};
  let response = await fetch(`${await getApiBase()}${path}`, {
    cache: "no-store",
    ...restInit,
    headers: {
      Accept: "application/json",
      ...authHeaders,
      ...(initHeaders as Record<string, string> | undefined),
    },
  });

  if (response.status === 401) {
    clearLocalSessionCache();
    const retryAuthHeaders = await getAuthHeader();
    response = await fetch(`${await getApiBase()}${path}`, {
      cache: "no-store",
      ...restInit,
      headers: {
        Accept: "application/json",
        ...retryAuthHeaders,
        ...(initHeaders as Record<string, string> | undefined),
      },
    });
  }

  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      // Keep the raw response text.
    }
    throw new DocketApiError(
      detail || `API error: ${response.status}`,
      response.status,
    );
  }

  if (
    response.status === 204 ||
    response.headers.get("content-length") === "0"
  ) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<DocketProject[]> {
  return apiRequest<DocketProject[]>("/projects");
}

export async function openProjectFolder(path: string): Promise<DocketProject> {
  return apiRequest<DocketProject>("/projects/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export async function deleteAccount(): Promise<void> {
  return apiRequest<void>("/user/account", { method: "DELETE" });
}

export async function getProject(projectId: string): Promise<DocketProject> {
  return apiRequest<DocketProject>(`/projects/${projectId}`);
}

export async function getProjectRegistry(
  projectId: string,
): Promise<DocketProject> {
  return apiRequest<DocketProject>(`/projects/${projectId}/registry`);
}

export async function updateProject(
  projectId: string,
  payload: {
    name?: string;
    cm_number?: string;
  },
): Promise<DocketProject> {
  return apiRequest<DocketProject>(`/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

export interface ProjectIndexStatus {
  project_id: string;
  total_documents: number;
  queued_jobs: number;
  status_counts: Record<string, number>;
  text_bytes: number;
  chunk_count: number;
  ocr_pages: number;
  ocr_scanned_pages?: number;
  ocr_truncated_documents?: number;
  last_indexed_at: string | null;
  semantic?: {
    enabled: boolean;
    provider: string;
    model_id: string;
    active_model: string;
    override: string | null;
    models: {
      model: string;
      dimensions: number;
      ready: number;
      total: number;
    }[];
    dimensions_policy: string;
    memory_profile: string;
    paused: boolean;
    queued_vectors: number;
    status_counts: Record<string, number>;
    ready_vectors: number;
    total_vectors: number;
    last_error: string | null;
  };
}

export async function requestFullDocumentOcr(
  projectId: string,
  documentId: string,
): Promise<{
  document_id: string;
  version_id: string;
  status: "queued";
  ocr_mode: "full";
}> {
  return apiRequest(
    `/projects/${projectId}/documents/${documentId}/ocr`,
    { method: "POST" },
  );
}

export interface ProjectSearchResult {
  document_id: string;
  version_id: string;
  chunk_id: string;
  filename: string;
  file_type: string | null;
  chunk_index: number;
  page_number: number | null;
  page_end: number | null;
  location_hint: string | null;
  quote: string;
  snippet: string;
  content: string;
  score: number;
  rank_score?: number;
  lexical_score?: number | null;
  semantic_score?: number | null;
  match_reasons?: (
    "exact" | "keyword" | "substring" | "semantic" | "filename" | "basic"
  )[];
  grouped_chunk_count?: number;
  basic_match: boolean;
}

export async function getProjectIndexStatus(
  projectId: string,
): Promise<ProjectIndexStatus> {
  return apiRequest<ProjectIndexStatus>(`/projects/${projectId}/index-status`);
}

export async function setProjectEmbeddingModel(
  projectId: string,
  model: string | null,
): Promise<{
  project_id: string;
  semantic: NonNullable<ProjectIndexStatus["semantic"]>;
}> {
  return apiRequest(`/projects/${projectId}/embedding-model`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
}

export async function ensureProjectIndexCurrent(
  projectId: string,
): Promise<{ project_id: string; enqueued: number }> {
  return apiRequest(`/projects/${projectId}/index/ensure`, {
    method: "POST",
  });
}

export async function rebuildProjectIndex(
  projectId: string,
): Promise<{ project_id: string; enqueued: number }> {
  return apiRequest(`/projects/${projectId}/index/rebuild`, {
    method: "POST",
  });
}

export async function compactProjectDatabase(projectId: string): Promise<{
  project_id: string;
  before_bytes: number;
  after_bytes: number;
  reclaimed_bytes: number;
  free_pages_before: number;
}> {
  return apiRequest(`/projects/${projectId}/index/compact`, {
    method: "POST",
  });
}

export async function cancelProjectIndex(
  projectId: string,
): Promise<{ project_id: string; cancelled: number }> {
  return apiRequest(`/projects/${projectId}/index/cancel`, {
    method: "POST",
  });
}

export async function startProjectEmbedding(projectId: string): Promise<{
  project_id: string;
  enqueued: number;
  semantic: NonNullable<ProjectIndexStatus["semantic"]>;
}> {
  return apiRequest(`/projects/${projectId}/index/semantic/start`, {
    method: "POST",
  });
}

export async function pauseProjectEmbedding(projectId: string): Promise<{
  project_id: string;
  queued: number;
  semantic: NonNullable<ProjectIndexStatus["semantic"]>;
}> {
  return apiRequest(`/projects/${projectId}/index/semantic/pause`, {
    method: "POST",
  });
}

export async function searchProjectDocuments(
  projectId: string,
  params: {
    q: string;
    limit?: number;
    types?: string[];
    folder_id?: string | null;
    neighbors?: boolean;
    group?: "chunks" | "documents";
  },
): Promise<{ query: string; results: ProjectSearchResult[] }> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.types?.length) qs.set("types", params.types.join(","));
  if (params.folder_id) qs.set("folder_id", params.folder_id);
  if (params.neighbors) qs.set("neighbors", "1");
  if (params.group) qs.set("group", params.group);
  return apiRequest(`/projects/${projectId}/search?${qs.toString()}`);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
  projectId: string,
  name: string,
  parentFolderId?: string | null,
): Promise<DocketFolder> {
  return apiRequest<DocketFolder>(`/projects/${projectId}/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      parent_folder_id: parentFolderId ?? null,
    }),
  });
}

export async function renameProjectFolder(
  projectId: string,
  folderId: string,
  name: string,
): Promise<DocketFolder> {
  return apiRequest<DocketFolder>(
    `/projects/${projectId}/folders/${folderId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
}

export async function deleteProjectFolder(
  projectId: string,
  folderId: string,
): Promise<void> {
  await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
    method: "DELETE",
  });
}

export async function moveSubfolderToFolder(
  projectId: string,
  folderId: string,
  parentFolderId: string | null,
): Promise<DocketFolder> {
  return apiRequest<DocketFolder>(
    `/projects/${projectId}/folders/${folderId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_folder_id: parentFolderId }),
    },
  );
}

export async function moveDocumentToFolder(
  projectId: string,
  documentId: string,
  folderId: string | null,
): Promise<DocketDocument> {
  return apiRequest<DocketDocument>(
    `/projects/${projectId}/documents/${documentId}/folder`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId }),
    },
  );
}

export async function updateDocumentClassification(
  projectId: string,
  documentId: string,
  patch: {
    doc_role?: "brief" | "evidence" | "other";
    party_role?: string | null;
    party_side?: "A" | "B" | null;
    instance?: string | null;
  },
): Promise<DocketDocument> {
  return apiRequest<DocketDocument>(
    `/projects/${projectId}/documents/${documentId}/classification`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
}

export interface DocketDocumentVersion {
  id: string;
  version_number: number | null;
  source: string;
  created_at: string;
  display_name: string | null;
}

export async function listDocumentVersions(documentId: string): Promise<{
  current_version_id: string | null;
  versions: DocketDocumentVersion[];
}> {
  return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
  documentId: string,
  file: File,
  displayName?: string,
): Promise<DocketDocumentVersion> {
  const authHeaders = await getAuthHeader();
  const form = new FormData();
  form.append("file", file);
  if (displayName) form.append("display_name", displayName);
  const response = await fetch(
    `${await getApiBase()}/single-documents/${documentId}/versions`,
    {
      method: "POST",
      headers: { ...authHeaders },
      body: form,
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DocketDocumentVersion>;
}

export async function renameDocumentVersion(
  documentId: string,
  versionId: string,
  displayName: string | null,
): Promise<DocketDocumentVersion> {
  return apiRequest<DocketDocumentVersion>(
    `/single-documents/${documentId}/versions/${versionId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    },
  );
}

export async function uploadProjectDocument(
  projectId: string,
  file: File,
): Promise<DocketDocument> {
  const authHeaders = await getAuthHeader();
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(
    `${await getApiBase()}/projects/${projectId}/documents`,
    {
      method: "POST",
      headers: { ...authHeaders },
      body: form,
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DocketDocument>;
}

export interface DocketSourceFolder {
  id: string;
  project_id: string;
  root_path: string;
  display_path?: string | null;
  display_name: string | null;
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocketSourceFolderScanResult {
  source_folder: DocketSourceFolder;
  imported: DocketDocument[];
  updated: DocketDocument[];
  unchanged: string[];
  missing: string[];
  skipped: string[];
  limit_reached: boolean;
}

export async function listProjectSourceFolders(
  projectId: string,
): Promise<DocketSourceFolder[]> {
  return apiRequest<DocketSourceFolder[]>(
    `/projects/${projectId}/source-folders`,
  );
}

export async function addProjectSourceFolder(
  projectId: string,
  path: string,
): Promise<DocketSourceFolderScanResult> {
  return apiRequest(`/projects/${projectId}/source-folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export async function rescanProjectSourceFolder(
  projectId: string,
  sourceFolderId: string,
): Promise<DocketSourceFolderScanResult> {
  return apiRequest(
    `/projects/${projectId}/source-folders/${sourceFolderId}/rescan`,
    { method: "POST" },
  );
}

export async function uploadStandaloneDocument(
  file: File,
): Promise<DocketDocument> {
  const authHeaders = await getAuthHeader();
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${await getApiBase()}/single-documents`, {
    method: "POST",
    headers: { ...authHeaders },
    body: form,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DocketDocument>;
}

export async function listStandaloneDocuments(): Promise<DocketDocument[]> {
  return apiRequest<DocketDocument[]>("/single-documents");
}

export async function deleteDocument(documentId: string): Promise<void> {
  await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export async function getDocumentUrl(
  documentId: string,
  versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
  const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
  return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

export type OcrRegionMatch = {
  page_number: number;
  regions: {
    text: string;
    bbox: { x: number; y: number; width: number; height: number };
  }[];
};

export async function getDocumentOcrRegions(
  documentId: string,
  versionId: string | null | undefined,
  page: number,
  quote: string,
): Promise<OcrRegionMatch> {
  const qs = new URLSearchParams({ page: String(page), quote });
  if (versionId) qs.set("version_id", versionId);
  return apiRequest(
    `/single-documents/${documentId}/ocr-regions?${qs.toString()}`,
  );
}

export interface GeneratedDocumentOutlineItem {
  id: string;
  title: string;
  level: number;
  page?: number;
}

export interface GeneratedDocumentOutlineResult {
  items: GeneratedDocumentOutlineItem[];
  source:
    | "toc-match"
    | "document-structure"
    | "llm"
    | "gpu-unavailable"
    | "too-large"
    | "no-text";
  message?: string;
}

export async function generateDocumentOutline(
  documentId: string,
  options: { versionId?: string | null; model?: string | null } = {},
): Promise<GeneratedDocumentOutlineResult> {
  return apiRequest<GeneratedDocumentOutlineResult>(
    `/single-documents/${documentId}/outline`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version_id: options.versionId ?? null,
        model: options.model ?? null,
      }),
    },
  );
}

export async function listPdfAnnotations(
  documentId: string,
  versionId?: string | null,
): Promise<PdfAnnotation[]> {
  const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
  return apiRequest<PdfAnnotation[]>(
    `/single-documents/${documentId}/annotations${qs}`,
  );
}

export type ProjectAnnotationFilters = {
  colorFamily?: AnnotationColorFamily[];
  docId?: string[];
  annotationType?: "highlight" | "comment";
  hasComment?: boolean;
  source?: "user" | "citation_promotion";
  order?: "position" | "recent";
  limit?: number;
  offset?: number;
};

export async function listProjectAnnotations(
  projectId: string,
  filters: ProjectAnnotationFilters = {},
): Promise<ProjectAnnotationsResponse> {
  const query = buildProjectAnnotationQueryString(filters);
  return apiRequest<ProjectAnnotationsResponse>(
    `/projects/${projectId}/annotations${query ? `?${query}` : ""}`,
  );
}

export interface ColorLegendEntry {
  color_family: AnnotationColorFamily;
  label: string;
  party_role: string | null;
  party_side: "A" | "B" | null;
}

export async function getProjectColorLegend(
  projectId: string,
): Promise<{ entries: ColorLegendEntry[] }> {
  return apiRequest(`/projects/${projectId}/color-legend`);
}

export async function putProjectColorLegend(
  projectId: string,
  entries: ColorLegendEntry[],
): Promise<{ entries: ColorLegendEntry[] }> {
  return apiRequest(`/projects/${projectId}/color-legend`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}

export async function createPdfAnnotation(
  documentId: string,
  payload: {
    version_id?: string | null;
    page_number: number;
    annotation_type: "highlight" | "comment";
    color: string;
    quote?: string | null;
    comment?: string | null;
    rects: PdfAnnotationRect[];
    source?: "user" | "citation_promotion";
    source_citation?: Record<string, unknown> | null;
  },
): Promise<PdfAnnotation> {
  return apiRequest<PdfAnnotation>(
    `/single-documents/${documentId}/annotations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function updatePdfAnnotation(
  documentId: string,
  annotationId: string,
  payload: Partial<{
    annotation_type: "highlight" | "comment";
    color: string;
    quote: string | null;
    comment: string | null;
    rects: PdfAnnotationRect[];
    source_citation: Record<string, unknown> | null;
  }>,
): Promise<PdfAnnotation> {
  return apiRequest<PdfAnnotation>(
    `/single-documents/${documentId}/annotations/${annotationId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function deletePdfAnnotation(
  documentId: string,
  annotationId: string,
): Promise<void> {
  await apiRequest(
    `/single-documents/${documentId}/annotations/${annotationId}`,
    { method: "DELETE" },
  );
}

export type DocumentRescanResult = {
  status: "not_linked" | "missing" | "unchanged" | "updated";
  relative_path?: string;
  version_id?: string;
  annotations_synced: boolean;
};

export async function rescanDocument(
  documentId: string,
): Promise<DocumentRescanResult> {
  return apiRequest<DocumentRescanResult>(
    `/single-documents/${documentId}/rescan`,
    { method: "POST" },
  );
}

export async function exportAnnotatedPdf(
  documentId: string,
  versionId?: string | null,
): Promise<DocketDocumentVersion> {
  return apiRequest<DocketDocumentVersion>(
    `/single-documents/${documentId}/annotations/export-pdf`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: versionId ?? null }),
    },
  );
}

export async function downloadDocumentsZip(
  documentIds: string[],
): Promise<Blob> {
  const authHeaders = await getAuthHeader();
  const response = await fetch(
    `${await getApiBase()}/single-documents/download-zip`,
    {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ document_ids: documentIds }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `API error: ${response.status}`);
  }
  return response.blob();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
  project_id?: string;
}): Promise<{ id: string }> {
  return apiRequest<{ id: string }>("/chat/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

export async function listChats(): Promise<DocketChat[]> {
  return apiRequest<DocketChat[]>("/chat");
}

export async function listProjectChats(
  projectId: string,
): Promise<DocketChat[]> {
  return apiRequest<DocketChat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<DocketChatDetailOut> {
  const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
  const messages: DocketMessage[] = raw.messages.map((m) => {
    if (m.role === "user") {
      return {
        role: "user",
        content: typeof m.content === "string" ? m.content : "",
        files: m.files ?? undefined,
        workflow: m.workflow ?? undefined,
      };
    }
    const events = Array.isArray(m.content)
      ? (m.content as AssistantEvent[])
      : undefined;
    return {
      role: "assistant",
      content:
        events
          ?.filter((e) => e.type === "content")
          .map((e) => (e as { type: "content"; text: string }).text)
          .join("") ?? "",
      annotations: m.annotations ?? undefined,
      events,
    };
  });
  return { chat: raw.chat, messages };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
  await apiRequest(`/chat/${chatId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function deleteChat(chatId: string): Promise<void> {
  await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

export async function generateChatTitle(
  chatId: string,
  message: string,
): Promise<{ title: string }> {
  return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

export async function streamChat(payload: {
  messages: {
    role: string;
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
  }[];
  chat_id?: string;
  project_id?: string;
  model?: string;
  disabled_tools?: string[];
  signal?: AbortSignal;
}): Promise<Response> {
  const { signal, ...body } = payload;
  const authHeaders = await getAuthHeader();
  return fetch(`${await getApiBase()}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...authHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });
}

type StreamChatMessage = {
  role: string;
  content: string;
  files?: { filename: string; document_id?: string }[];
  workflow?: { id: string; title: string };
};

export async function streamProjectChat(payload: {
  projectId: string;
  messages: StreamChatMessage[];
  chat_id?: string;
  model?: string;
  displayed_doc?: { filename: string; document_id: string };
  attached_documents?: { filename: string; document_id: string }[];
  selected_document_ids?: string[];
  disabled_tools?: string[];
  signal?: AbortSignal;
}): Promise<Response> {
  const { projectId, signal, ...body } = payload;
  const authHeaders = await getAuthHeader();
  return fetch(`${await getApiBase()}/projects/${projectId}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...authHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
  projectId: string,
): Promise<TabularReview[]> {
  return apiRequest<TabularReview[]>(`/projects/${projectId}/tabular-reviews`);
}

export async function createTabularReview(
  projectId: string,
  payload: {
    title?: string;
    model?: string | null;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
  },
): Promise<TabularReview> {
  return apiRequest<TabularReview>(`/projects/${projectId}/tabular-reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getTabularReview(
  projectId: string,
  reviewId: string,
): Promise<TabularReviewDetailOut> {
  return apiRequest<TabularReviewDetailOut>(
    `/projects/${projectId}/tabular-reviews/${reviewId}`,
  );
}

export async function updateTabularReview(
  projectId: string,
  reviewId: string,
  payload: {
    title?: string;
    model?: string | null;
    columns_config?: { index: number; name: string; prompt: string }[];
    document_ids?: string[];
  },
): Promise<TabularReview> {
  return apiRequest<TabularReview>(
    `/projects/${projectId}/tabular-reviews/${reviewId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function generateTabularColumnPrompt(
  title: string,
  options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
  return apiRequest<{
    prompt: string;
    source: "preset" | "llm" | "fallback";
  }>("/tabular-column-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      format: options?.format,
      documentName: options?.documentName,
      tags: options?.tags,
    }),
  });
}

export async function uploadReviewDocument(
  projectId: string,
  reviewId: string,
  file: File,
  options?: {
    documentIds?: string[];
    columnsConfig?: { index: number; name: string; prompt: string }[];
  },
): Promise<DocketDocument> {
  const uploaded = await uploadProjectDocument(projectId, file);

  await updateTabularReview(projectId, reviewId, {
    columns_config: options?.columnsConfig,
    document_ids: [...(options?.documentIds ?? []), uploaded.id],
  });

  return uploaded;
}

export async function deleteTabularReview(
  projectId: string,
  reviewId: string,
): Promise<void> {
  await apiRequest(`/projects/${projectId}/tabular-reviews/${reviewId}`, {
    method: "DELETE",
  });
}

export async function streamTabularGeneration(
  projectId: string,
  reviewId: string,
  signal?: AbortSignal,
): Promise<Response> {
  const authHeaders = await getAuthHeader();
  return fetch(
    `${await getApiBase()}/projects/${projectId}/tabular-reviews/${reviewId}/generate`,
    {
      method: "POST",
      headers: { ...authHeaders },
      signal,
    },
  );
}

export async function streamTabularChat(
  projectId: string,
  reviewId: string,
  messages: { role: string; content: string }[],
  chat_id?: string | null,
  signal?: AbortSignal,
  context?: { reviewTitle?: string | null; projectName?: string | null },
): Promise<Response> {
  const authHeaders = await getAuthHeader();
  return fetch(
    `${await getApiBase()}/projects/${projectId}/tabular-reviews/${reviewId}/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        messages,
        chat_id: chat_id ?? undefined,
        review_title: context?.reviewTitle ?? undefined,
        project_name: context?.projectName ?? undefined,
      }),
      signal: signal ?? undefined,
    },
  );
}

export interface TRCitationAnnotation {
  type: "tabular_citation";
  ref: number;
  col_index: number;
  row_index: number;
  col_name: string;
  doc_name: string;
  quote: string;
}

interface RawTRMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | AssistantEvent[] | null;
  annotations?: TRCitationAnnotation[] | null;
  created_at: string;
}

export interface TRDisplayMessage {
  role: "user" | "assistant";
  content: string;
  events?: AssistantEvent[];
  annotations?: TRCitationAnnotation[];
}

export interface TRChat {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
  return raw.map((m) => {
    if (m.role === "user") {
      return {
        role: "user" as const,
        content: typeof m.content === "string" ? m.content : "",
      };
    }
    const events = Array.isArray(m.content)
      ? (m.content as AssistantEvent[])
      : undefined;
    const content =
      events
        ?.filter((e) => e.type === "content")
        .map((e) => (e as { type: "content"; text: string }).text)
        .join("") ?? "";
    return {
      role: "assistant" as const,
      content,
      events,
      annotations: m.annotations ?? undefined,
    };
  });
}

export async function getTabularChats(
  projectId: string,
  reviewId: string,
): Promise<TRChat[]> {
  return apiRequest<TRChat[]>(
    `/projects/${projectId}/tabular-reviews/${reviewId}/chats`,
  );
}

export async function getTabularChatMessages(
  projectId: string,
  reviewId: string,
  chatId: string,
): Promise<RawTRMessage[]> {
  return apiRequest<RawTRMessage[]>(
    `/projects/${projectId}/tabular-reviews/${reviewId}/chats/${chatId}/messages`,
  );
}

export async function deleteTabularChat(
  projectId: string,
  reviewId: string,
  chatId: string,
): Promise<void> {
  await apiRequest(
    `/projects/${projectId}/tabular-reviews/${reviewId}/chats/${chatId}`,
    {
      method: "DELETE",
    },
  );
}

export async function regenerateTabularCell(
  projectId: string,
  reviewId: string,
  documentId: string,
  columnIndex: number,
): Promise<{
  summary: string;
  flag: "green" | "grey" | "yellow" | "red";
  reasoning: string;
}> {
  return apiRequest(
    `/projects/${projectId}/tabular-reviews/${reviewId}/regenerate-cell`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document_id: documentId,
        column_index: columnIndex,
      }),
    },
  );
}

export async function clearTabularCells(
  projectId: string,
  reviewId: string,
  documentIds: string[],
): Promise<void> {
  await apiRequest(
    `/projects/${projectId}/tabular-reviews/${reviewId}/clear-cells`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_ids: documentIds }),
    },
  );
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = DocketWorkflow["type"];

export async function listWorkflows(
  type: WorkflowType,
): Promise<DocketWorkflow[]> {
  return apiRequest<DocketWorkflow[]>(`/workflows?type=${type}`);
}

export async function getWorkflow(workflowId: string): Promise<DocketWorkflow> {
  return apiRequest<DocketWorkflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
  title: string;
  type: "assistant" | "tabular";
  prompt_md?: string;
  columns_config?: { index: number; name: string; prompt: string }[];
  practice?: string | null;
}): Promise<DocketWorkflow> {
  return apiRequest<DocketWorkflow>("/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateWorkflow(
  workflowId: string,
  payload: {
    title?: string;
    prompt_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    practice?: string | null;
  },
): Promise<DocketWorkflow> {
  return apiRequest<DocketWorkflow>(`/workflows/${workflowId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function listHiddenWorkflows(): Promise<string[]> {
  return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
  await apiRequest("/workflows/hidden", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_id: workflowId }),
  });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
  await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
  workflowId: string,
  payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
  await apiRequest<void>(`/workflows/${workflowId}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function listWorkflowShares(workflowId: string): Promise<
  {
    id: string;
    shared_with_email: string;
    allow_edit: boolean;
    created_at: string;
  }[]
> {
  return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
  workflowId: string,
  shareId: string,
): Promise<void> {
  await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
    method: "DELETE",
  });
}
