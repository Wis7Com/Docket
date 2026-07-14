import { Router } from "express";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../lib/documentVersions";
import { storageKey, uploadFile } from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import { checkProjectAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import {
  resolveSourceFolderPath,
  scanSourceFolder,
} from "../lib/sourceFolders";
import {
  addSourceFolderToProject,
  createProjectFromFolder,
} from "../lib/projectFolders";
import {
  displaySourceFolderPath,
  resolveStoredSourceFolderPath,
} from "../lib/sourceFolderPaths";
import {
  cancelProjectIndexing,
  compactProjectDatabase,
  enqueueDocumentIndex,
  enqueueEmptyPdfIndexes,
  enqueueProjectIndexRebuild,
  ensureProjectBaselineCurrent,
  getProjectIndexStatus,
  getProjectSemanticIndexStatus,
  pauseProjectSemanticIndexing,
  startProjectSemanticIndexing,
} from "../lib/indexing/indexer";
import { searchProjectIndex } from "../lib/indexing/search";
import {
  ensureProjectRowInProjectDb,
  getRegisteredProject,
  listRegisteredProjects,
  projectDbRequestContext,
  refreshProjectRegistryCounts,
} from "../lib/projectRegistry";
import { getAppDb, runWithDatabaseContext } from "../db/sqlite";
import {
  IMAGE_DOCUMENT_TYPES,
  isAllowedDocumentType,
  isImageDocumentType,
  mimeTypeForDocumentType,
} from "../lib/documentTypes";
import {
  docRoleSchema,
  inferDocRole,
  inferPartyRole,
  partyRoleNullableSchema,
  partySideNullableSchema,
} from "../lib/documentClassification";
import {
  buildProjectDocMeta,
  fetchProjectAnnotations,
  parseProjectAnnotationQuery,
} from "../lib/projectAnnotations";
import { parseColorLegendEntries } from "../lib/colorLegend";

export const projectsRouter = Router();
const ocrOverrideSchema = z.union([z.number().int().min(0), z.null()]);
const ALLOWED_TYPES = new Set([
  "pdf",
  "docx",
  "doc",
  "txt",
  "md",
  ...IMAGE_DOCUMENT_TYPES,
]);

function serializeSourceFolder<T extends Record<string, unknown>>(row: T): T {
  const rootPath = typeof row.root_path === "string" ? row.root_path : "";
  return {
    ...row,
    display_path: rootPath ? displaySourceFolderPath(rootPath) : rootPath,
  };
}

function parseCsvQuery(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function uploadRootFilename(root: string, filename: string): string {
  const base = path.basename(filename).trim() || "document";
  const parsed = path.parse(base);
  const stem = parsed.name.trim() || "document";
  const ext = parsed.ext;
  let candidate = `${stem}${ext}`;
  let counter = 1;
  while (fs.existsSync(path.join(root, candidate))) {
    candidate = `${stem} (${counter})${ext}`;
    counter += 1;
  }
  return candidate;
}

async function uploadIntoProjectSourceRoot(args: {
  db: ReturnType<typeof createServerSupabase>;
  projectId: string;
  userId: string;
  filename: string;
  content: Buffer;
}): Promise<Record<string, unknown>> {
  const { data: sourceFolders, error } = await args.db
    .from("source_folders")
    .select("*")
    .eq("project_id", args.projectId)
    .eq("root_path", "project:.")
    .limit(1);
  if (error) throw new Error(error.message);
  const sourceFolder = sourceFolders?.[0] as
    | { id: string; root_path: string }
    | undefined;
  if (!sourceFolder?.id || !sourceFolder.root_path) {
    throw new Error("Project root source folder is missing");
  }

  const root = resolveSourceFolderPath(
    resolveStoredSourceFolderPath(sourceFolder.root_path),
  );
  const relativePath = uploadRootFilename(root, args.filename);
  const destination = path.join(root, relativePath);
  await fs.promises.writeFile(destination, args.content);

  await scanSourceFolder({
    db: args.db,
    sourceFolderId: sourceFolder.id,
    projectId: args.projectId,
    userId: args.userId,
    rootPath: root,
  });

  const { data: linked } = await args.db
    .from("linked_source_files")
    .select("document_id")
    .eq("source_folder_id", sourceFolder.id)
    .eq("relative_path", relativePath)
    .single();
  if (!linked?.document_id) {
    throw new Error("Uploaded file was copied but could not be registered");
  }

  const { data: doc } = await args.db
    .from("documents")
    .select("*")
    .eq("id", linked.document_id as string)
    .single();
  if (!doc) throw new Error("Uploaded document record was not found");

  const [withPaths] = await attachActiveVersionPaths(args.db, [
    doc as Record<string, unknown> & { id: string },
  ]);
  return withPaths;
}

// GET /projects
projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const projects = listRegisteredProjects(userId, userEmail);

  const result = projects.map((p) => ({
    ...p,
    is_owner: p.user_id === userId,
    document_count: p.document_count_cache ?? 0,
    chat_count: p.chat_count_cache ?? 0,
    review_count: p.review_count_cache ?? 0,
  }));
  res.json(result);
});

// POST /projects/open-folder
// Open a local folder as a Docket project. The folder itself is the durable
// project boundary; project data lives in <folder>/.docket.
projectsRouter.post("/open-folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const folderPath = typeof req.body?.path === "string" ? req.body.path : "";
  if (!folderPath.trim())
    return void res.status(400).json({ detail: "path is required" });

  const db = createServerSupabase();
  try {
    const { project, sourceFolder, scan } = await createProjectFromFolder({
      db,
      userId,
      folderPath,
    });
    res.status(201).json({
      ...project,
      is_owner: true,
      document_count: scan.imported.length + scan.updated.length,
      chat_count: 0,
      review_count: 0,
      source_folder: serializeSourceFolder(sourceFolder),
      scan,
    });
  } catch (err) {
    return void res.status(400).json({
      detail: (err as Error).message || "Could not open folder",
    });
  }
});

// GET /projects/:projectId/registry
// Registry-only metadata. This intentionally does not open the project DB, so
// the UI can recover when macOS folder access needs to be re-authorized.
projectsRouter.get("/:projectId/registry", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const row = getRegisteredProject(req.params.projectId);
  if (!row) return void res.status(404).json({ detail: "Project not found" });
  if (row.user_id !== userId)
    return void res.status(404).json({ detail: "Project not found" });

  res.json({
    ...row,
    shared_with: undefined,
    is_owner: true,
    document_count: row.document_count_cache ?? 0,
    chat_count: row.chat_count_cache ?? 0,
    review_count: row.review_count_cache ?? 0,
  });
});

// DELETE /projects/:projectId
// Deleting a project unregisters it from Docket. Keep this registry-only so a
// stale entry can still be removed after its local folder has been moved or
// deleted.
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  getAppDb()
    .prepare("DELETE FROM projects WHERE id = ? AND user_id = ?")
    .run(projectId, userId);
  res.status(204).send();
});

projectsRouter.use("/:projectId", requireAuth, projectDbRequestContext);

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const { data: project, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project)
    return void res.status(404).json({ detail: "Project not found" });

  if (project.user_id !== userId)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db
      .from("documents")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
    db
      .from("project_subfolders")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  const counts = refreshProjectRegistryCounts(
    project as { id: string; path: string },
  );
  res.json({
    ...project,
    is_owner: project.user_id === userId,
    ...counts,
    documents: docsTyped,
    folders: folderData ?? [],
  });
});

// GET /projects/:projectId/color-legend
projectsRouter.get(
  "/:projectId/color-legend",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const { data, error } = await db
      .from("project_color_legend")
      .select("color_family, label, party_role, party_side")
      .eq("project_id", projectId)
      .order("color_family", { ascending: true });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ entries: data ?? [] });
  },
);

// PUT /projects/:projectId/color-legend — replace the complete legend.
projectsRouter.put(
  "/:projectId/color-legend",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!access.isOwner) {
      return void res.status(403).json({
        detail: "Only the project owner can edit the color legend",
      });
    }

    const parsed = parseColorLegendEntries(req.body);
    if (!parsed.ok)
      return void res.status(400).json({ detail: parsed.detail });

    const { error: deleteError } = await db
      .from("project_color_legend")
      .delete()
      .eq("project_id", projectId);
    if (deleteError)
      return void res.status(500).json({ detail: deleteError.message });

    if (parsed.entries.length > 0) {
      const now = new Date().toISOString();
      const rows = parsed.entries.map((entry) => ({
        project_id: projectId,
        color_family: entry.color_family,
        label: entry.label,
        party_role: entry.party_role ?? null,
        party_side: entry.party_side ?? null,
        created_at: now,
        updated_at: now,
      }));
      const { error: insertError } = await db
        .from("project_color_legend")
        .insert(rows);
      if (insertError)
        return void res.status(500).json({ detail: insertError.message });
    }

    res.json({ entries: parsed.entries });
  },
);

// GET /projects/:projectId/index-status
projectsRouter.get(
  "/:projectId/index-status",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    res.json({
      ...getProjectIndexStatus(projectId),
      semantic: getProjectSemanticIndexStatus(projectId, userId),
    });
  },
);

// POST /projects/:projectId/index/ensure
// Reconcile only project-DB index metadata. This never scans linked folders or
// starts optional semantic work, so it is safe to call non-blockingly on open.
projectsRouter.post(
  "/:projectId/index/ensure",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const enqueued = ensureProjectBaselineCurrent(projectId);
    res.status(enqueued > 0 ? 202 : 200).json({
      project_id: projectId,
      enqueued,
    });
  },
);

// POST /projects/:projectId/index/rebuild
projectsRouter.post(
  "/:projectId/index/rebuild",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!access.isOwner)
      return void res.status(403).json({
        detail: "Only the project owner can rebuild the index",
      });

    const enqueued = await enqueueProjectIndexRebuild(projectId);
    res.status(202).json({ project_id: projectId, enqueued });
  },
);

// POST /projects/:projectId/index/compact
projectsRouter.post(
  "/:projectId/index/compact",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!access.isOwner)
      return void res.status(403).json({
        detail: "Only the project owner can compact the database",
      });

    try {
      const compacted = compactProjectDatabase(projectId);
      res.json({ project_id: projectId, ...compacted });
    } catch (err) {
      const detail = (err as Error).message || "Database compaction failed";
      const status =
        detail.includes("indexing and embedding") ||
        detail.includes("active transaction") ||
        detail.includes("database is locked")
          ? 409
          : 500;
      res.status(status).json({ detail });
    }
  },
);

// POST /projects/:projectId/index/cancel
projectsRouter.post(
  "/:projectId/index/cancel",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!access.isOwner)
      return void res
        .status(403)
        .json({ detail: "Only the project owner can cancel indexing" });

    const cancelled = cancelProjectIndexing(projectId);
    res.json({ project_id: projectId, cancelled });
  },
);

// POST /projects/:projectId/index/semantic/start
projectsRouter.post(
  "/:projectId/index/semantic/start",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!access.isOwner)
      return void res
        .status(403)
        .json({ detail: "Only the project owner can start embedding" });

    try {
      const enqueued = startProjectSemanticIndexing(projectId, userId);
      res.status(202).json({
        project_id: projectId,
        enqueued,
        semantic: getProjectSemanticIndexStatus(projectId, userId),
      });
    } catch (err) {
      const detail = (err as Error).message || "Embedding start failed";
      res.status(detail.includes("lexical indexing") ? 409 : 500).json({
        detail,
      });
    }
  },
);

// POST /projects/:projectId/index/semantic/pause
projectsRouter.post(
  "/:projectId/index/semantic/pause",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!access.isOwner)
      return void res
        .status(403)
        .json({ detail: "Only the project owner can pause embedding" });

    const queued = pauseProjectSemanticIndexing(projectId);
    res.json({
      project_id: projectId,
      queued,
      semantic: getProjectSemanticIndexStatus(projectId, userId),
    });
  },
);

// GET /projects/:projectId/search
projectsRouter.get("/:projectId/search", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const limit =
    typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const includeNeighbors =
    req.query.neighbors === "1" || req.query.neighbors === "true";
  const fileTypes = parseCsvQuery(req.query.types);
  const folderId =
    typeof req.query.folder_id === "string" && req.query.folder_id.trim()
      ? req.query.folder_id.trim()
      : null;
  const group = req.query.group === "documents" ? "documents" : "chunks";
  if (!q.trim()) return void res.status(400).json({ detail: "q is required" });

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const results = await searchProjectIndex({
    projectId,
    userId,
    query: q,
    limit: Number.isFinite(limit) ? limit : undefined,
    includeNeighbors,
    fileTypes,
    folderId,
    group,
  });

  res.json({
    query: q,
    results,
  });
});

// GET /projects/:projectId/source-folders
projectsRouter.get(
  "/:projectId/source-folders",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const { data, error } = await db
      .from("source_folders")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json((data ?? []).map((row) => serializeSourceFolder(row)));
  },
);

// POST /projects/:projectId/source-folders
// Open an additional local/OneDrive/Google Drive folder by reference, then scan
// supported legal source files into project documents without copying originals.
projectsRouter.post(
  "/:projectId/source-folders",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const folderPath = typeof req.body?.path === "string" ? req.body.path : "";
    if (!folderPath.trim())
      return void res.status(400).json({ detail: "path is required" });

    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!access.isOwner)
      return void res
        .status(403)
        .json({ detail: "Only the project owner can open folders" });

    let opened: Awaited<ReturnType<typeof addSourceFolderToProject>>;
    try {
      opened = await addSourceFolderToProject({
        db,
        projectId,
        userId,
        folderPath,
      });
    } catch (err) {
      return void res.status(400).json({
        detail: (err as Error).message || "Could not open folder",
      });
    }

    res.status(201).json({
      source_folder: serializeSourceFolder(opened.sourceFolder),
      ...opened.scan,
    });
  },
);

// POST /projects/:projectId/source-folders/:sourceFolderId/rescan
projectsRouter.post(
  "/:projectId/source-folders/:sourceFolderId/rescan",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, sourceFolderId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!access.isOwner)
      return void res.status(403).json({
        detail: "Only the project owner can rescan source folders",
      });

    const { data: sourceFolder, error } = await db
      .from("source_folders")
      .select("*")
      .eq("id", sourceFolderId)
      .eq("project_id", projectId)
      .single();
    if (error || !sourceFolder) {
      return void res.status(404).json({ detail: "Source folder not found" });
    }

    let root: string;
    try {
      root = resolveSourceFolderPath(
        resolveStoredSourceFolderPath(sourceFolder.root_path as string),
      );
    } catch (err) {
      return void res.status(400).json({
        detail:
          (err as Error).message || "Opened folder is no longer accessible",
      });
    }

    const scan = await scanSourceFolder({
      db,
      sourceFolderId,
      projectId,
      userId,
      rootPath: root,
    });
    res.json({
      source_folder: serializeSourceFolder(sourceFolder),
      ...scan,
    });
  },
);

// Project sharing was removed with the local-folder project boundary.
projectsRouter.all("/:projectId/people", requireAuth, (_req, res) => {
  res.status(410).json({
    detail: "Project members were removed because local projects are private",
    code: "project_members_removed",
  });
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.name != null) updates.name = req.body.name;
  if (req.body.cm_number != null) updates.cm_number = req.body.cm_number;
  if (Object.hasOwn(req.body, "ocr_max_pages_override")) {
    const parsed = ocrOverrideSchema.safeParse(
      req.body.ocr_max_pages_override,
    );
    if (!parsed.success) {
      return void res.status(400).json({
        detail:
          "ocr_max_pages_override must be a non-negative integer or null",
      });
    }
    updates.ocr_max_pages_override = parsed.data;
  }

  const db = createServerSupabase();
  const { data, error } = await db
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error || !data)
    return void res.status(404).json({ detail: "Project not found" });
  if (Object.hasOwn(updates, "ocr_max_pages_override")) {
    enqueueEmptyPdfIndexes(projectId);
  }

  const registryUpdates = {
    name: (data.name as string | undefined) ?? null,
    cm_number: (data.cm_number as string | null | undefined) ?? null,
    updated_at: new Date().toISOString(),
  };
  getAppDb()
    .prepare(
      `
      UPDATE projects
      SET name = COALESCE(?, name),
          cm_number = ?,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      registryUpdates.name,
      registryUpdates.cm_number,
      registryUpdates.updated_at,
      projectId,
    );

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db
      .from("documents")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
    db
      .from("project_subfolders")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json({ ...data, documents: docsTyped, folders: folderData ?? [] });
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: docs } = await db
    .from("documents")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json(docsTyped);
});

// GET /projects/:projectId/annotations
// Read the current user's annotations across every document in the project.
projectsRouter.get("/:projectId/annotations", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const parsed = parseProjectAnnotationQuery({
    color_family: parseCsvQuery(req.query.color_family),
    // Keep document IDs opaque and case-preserving.
    doc_id: req.query.doc_id,
    annotation_type: req.query.annotation_type,
    has_comment: req.query.has_comment,
    source: req.query.source,
    order: req.query.order,
    limit: req.query.limit,
    offset: req.query.offset,
    party_role: req.query.party_role,
    party_side: req.query.party_side,
    party: req.query.party,
  });
  if (!parsed.ok)
    return void res.status(400).json({ detail: parsed.detail });

  const [{ data: docs, error }, { data: folderRows }] = await Promise.all([
    db
      .from("documents")
      .select(
        "id, filename, current_version_id, folder_id, party_role, party_side",
      )
      .eq("project_id", projectId),
    db
      .from("project_subfolders")
      .select("id, name, parent_folder_id")
      .eq("project_id", projectId),
  ]);
  if (error) return void res.status(500).json({ detail: error.message });

  const documents = buildProjectDocMeta(
    (docs ?? []) as unknown as Parameters<typeof buildProjectDocMeta>[0],
    (folderRows ?? []) as unknown as Parameters<typeof buildProjectDocMeta>[1],
  );

  try {
    const result = await fetchProjectAnnotations({
      db,
      userId,
      documents,
      query: parsed.value,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      detail: (err as Error).message || "Could not list project annotations",
    });
  }
});

// Documents enter a project only through its local source folders.
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  (_req, res) => {
    res.status(410).json({
      detail:
        "Documents cannot be imported from outside a project source folder",
      code: "cross_project_document_import_removed",
    });
  },
);

// POST /projects/:projectId/documents
projectsRouter.post(
  "/:projectId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const row = getRegisteredProject(projectId);
    if (!row) return void res.status(404).json({ detail: "Project not found" });

    const ctx = ensureProjectRowInProjectDb(row);
    await runWithDatabaseContext(ctx, async () => {
      const db = createServerSupabase();
      const access = await checkProjectAccess(projectId, userId, userEmail, db);
      if (!access.ok)
        return void res.status(404).json({ detail: "Project not found" });

      await handleDocumentUpload(req, res, userId, projectId, db);
    });
  },
);

// GET /projects/:projectId/chats — every assistant chat under this project
// (any author with project access). Used by the project page's chat tab so
// it doesn't have to filter the global GET /chat list — and so collaborators
// see each other's chats inside the project even though those don't appear
// in the global list.
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db
    .from("chats")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data ?? []);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as {
    name: string;
    parent_folder_id?: string | null;
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const { data: parent } = await db
      .from("project_subfolders")
      .select("id")
      .eq("id", parent_folder_id)
      .eq("project_id", projectId)
      .single();
    if (!parent)
      return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const { data, error } = await db
    .from("project_subfolders")
    .insert({
      project_id: projectId,
      user_id: userId,
      name: name.trim(),
      parent_folder_id: parent_folder_id ?? null,
    })
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch(
  "/:projectId/folders/:folderId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, folderId } = req.params;
    const body = req.body as {
      name?: string;
      parent_folder_id?: string | null;
    };

    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.name != null) updates.name = body.name.trim();
    if ("parent_folder_id" in body) {
      // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
      if (body.parent_folder_id) {
        let cur: string | null = body.parent_folder_id;
        while (cur) {
          if (cur === folderId)
            return void res.status(400).json({
              detail: "Cannot move a folder into itself or a descendant",
            });
          const {
            data: p,
          }: { data: { parent_folder_id: string | null } | null } = await db
            .from("project_subfolders")
            .select("parent_folder_id")
            .eq("id", cur)
            .single();
          cur = p?.parent_folder_id ?? null;
        }
      }
      updates.parent_folder_id = body.parent_folder_id ?? null;
    }

    const { data, error } = await db
      .from("project_subfolders")
      .update(updates)
      .eq("id", folderId)
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error || !data)
      return void res.status(404).json({ detail: "Folder not found" });
    res.json(data);
  },
);

projectsRouter.post(
  "/:projectId/documents/:documentId/ocr",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const { data: document } = await db
      .from("documents")
      .select("id, current_version_id")
      .eq("id", documentId)
      .eq("project_id", projectId)
      .single();
    const versionId = document?.current_version_id as string | null | undefined;
    if (!versionId)
      return void res.status(404).json({ detail: "Document not found" });

    enqueueDocumentIndex(documentId, versionId, {
      ocrMode: "full",
      rerunIfActive: true,
    });
    res.status(202).json({
      document_id: documentId,
      version_id: versionId,
      status: "queued",
      ocr_mode: "full",
    });
  },
);

projectsRouter.patch(
  "/:projectId/documents/:documentId/classification",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if ("doc_role" in req.body) {
      const parsed = docRoleSchema.safeParse(req.body.doc_role);
      if (!parsed.success)
        return void res.status(400).json({ detail: "Invalid doc_role" });
      update.doc_role = parsed.data;
      update.doc_role_confidence = "manual";
    }
    if ("party_role" in req.body) {
      const parsed = partyRoleNullableSchema.safeParse(req.body.party_role);
      if (!parsed.success)
        return void res.status(400).json({ detail: "Invalid party_role" });
      update.party_role = parsed.data;
    }
    if ("party_side" in req.body) {
      const parsed = partySideNullableSchema.safeParse(req.body.party_side);
      if (!parsed.success)
        return void res.status(400).json({ detail: "Invalid party_side" });
      update.party_side = parsed.data;
    }
    if ("instance" in req.body) {
      const value = req.body.instance;
      if (
        value !== null &&
        (typeof value !== "string" || value.trim().length > 40)
      ) {
        return void res.status(400).json({ detail: "Invalid instance" });
      }
      update.instance =
        typeof value === "string" ? value.trim() || null : value;
    }
    if (Object.keys(update).length === 1) {
      return void res.status(400).json({ detail: "No classification fields" });
    }

    const { data, error } = await db
      .from("documents")
      .update(update)
      .eq("id", documentId)
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error || !data)
      return void res.status(404).json({ detail: "Document not found" });
    res.json(data);
  },
);

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete(
  "/:projectId/folders/:folderId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, folderId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Move direct documents to root before cascade-deleting subfolders.
    // Scope by project_id to avoid touching documents in other projects on
    // the off chance two folder IDs collide (defence-in-depth, post-RLS).
    await db
      .from("documents")
      .update({ folder_id: null })
      .eq("folder_id", folderId)
      .eq("project_id", projectId);

    const { error } = await db
      .from("project_subfolders")
      .delete()
      .eq("id", folderId)
      .eq("project_id", projectId);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
  },
);

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch(
  "/:projectId/documents/:documentId/folder",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const { folder_id } = req.body as { folder_id: string | null };

    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const { data, error } = await db
      .from("documents")
      .update({
        folder_id: folder_id ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId)
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error || !data)
      return void res.status(404).json({ detail: "Document not found" });
    res.json(data);
  },
);

export async function handleDocumentUpload(
  req: import("express").Request,
  res: import("express").Response,
  userId: string,
  projectId: string | null,
  db: ReturnType<typeof createServerSupabase>,
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  const filename = file.originalname;
  const suffix = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!isAllowedDocumentType(suffix) || !ALLOWED_TYPES.has(suffix))
    return void res.status(400).json({
      detail: `Unsupported file type: ${suffix}. Allowed: pdf, docx, doc, txt, md, ${IMAGE_DOCUMENT_TYPES.join(", ")}`,
    });

  const content = file.buffer;
  if (projectId) {
    try {
      const sourceRootDoc = await uploadIntoProjectSourceRoot({
        db,
        projectId,
        userId,
        filename,
        content,
      });
      return void res.status(201).json(sourceRootDoc);
    } catch (err) {
      return void res.status(500).json({
        detail: `Document project-folder upload failed: ${String(err)}`,
      });
    }
  }

  const roleGuess = inferDocRole({ filename });
  const partyGuess = inferPartyRole({ filename });
  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert({
      project_id: projectId,
      user_id: userId,
      filename,
      file_type: suffix,
      size_bytes: content.byteLength,
      status: "processing",
      doc_role: roleGuess.role,
      doc_role_confidence: roleGuess.confidence,
      ...(partyGuess ? { party_role: partyGuess.role } : {}),
    })
    .select("*")
    .single();

  if (insertErr || !doc)
    return void res
      .status(500)
      .json({ detail: "Failed to create document record" });

  try {
    const docId = doc.id as string;
    const key = storageKey(userId, docId, filename);
    const contentType = mimeTypeForDocumentType(suffix);
    await uploadFile(
      key,
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      contentType,
    );

    const rawBuf = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    const tree = await extractStructureTree(rawBuf, suffix, filename);
    const pageCount =
      suffix === "pdf"
        ? await countPdfPages(rawBuf)
        : isImageDocumentType(suffix)
          ? 1
          : null;
    const pageAwareRoleGuess =
      roleGuess.confidence === "low"
        ? inferDocRole({ filename, pageCount })
        : roleGuess;

    // Convert DOCX/DOC → PDF for display. PDFs are their own rendition.
    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(content);
        const pdfKey = convertedPdfKey(userId, docId);
        await uploadFile(
          pdfKey,
          pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
          ) as ArrayBuffer,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(
          `[upload] DOCX→PDF conversion failed for ${filename}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // Storage paths live on document_versions — create the V1 row and
    // point documents.current_version_id at it.
    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: docId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "upload",
        version_number: 1,
        display_name: filename,
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      throw new Error(
        `Failed to record upload version: ${verErr?.message ?? "unknown"}`,
      );
    }

    await db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
        size_bytes: content.byteLength,
        page_count: pageCount,
        doc_role: pageAwareRoleGuess.role,
        doc_role_confidence: pageAwareRoleGuess.confidence,
        structure_tree: tree ?? null,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId);
    enqueueDocumentIndex(docId, versionRow.id as string);

    const { data: updated } = await db
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    const responseDoc = updated
      ? {
          ...updated,
          storage_path: key,
          pdf_storage_path: pdfStoragePath,
        }
      : updated;
    return void res.status(201).json(responseDoc);
  } catch (e) {
    await db.from("documents").update({ status: "error" }).eq("id", doc.id);
    return void res
      .status(500)
      .json({ detail: `Document processing failed: ${String(e)}` });
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

async function extractStructureTree(
  content: ArrayBuffer,
  fileType: string,
  filename: string,
): Promise<unknown[] | null> {
  try {
    if (fileType === "pdf") {
      const pdfjsLib = await import(
        "pdfjs-dist/legacy/build/pdf.mjs" as string
      );
      const pdf = await (
        pdfjsLib as unknown as {
          getDocument: (opts: unknown) => {
            promise: Promise<{
              numPages: number;
              getOutline: () => Promise<{ title?: string }[]>;
            }>;
          };
        }
      ).getDocument({ data: new Uint8Array(content) }).promise;
      if (pdf.numPages <= 5) return null;
      const outline = await pdf.getOutline();
      if (outline?.length) {
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
      }
      return Array.from({ length: pdf.numPages }, (_, i) => ({
        id: `page-${i + 1}`,
        title: `Page ${i + 1}`,
        level: 1,
        page_number: i + 1,
        children: [],
      }));
    } else {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(content),
      });
      const lines = result.value.split("\n").filter((l) => l.trim());
      const nodes = lines.slice(0, 30).map((line, i) => ({
        id: `h1-${i}`,
        title: line.slice(0, 100),
        level: 1,
        page_number: null,
        children: [],
      }));
      return nodes.length ? nodes : null;
    }
  } catch {
    return null;
  }
}
