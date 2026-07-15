import { Router } from "express";
import { createHash } from "crypto";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFString,
} from "pdf-lib";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  looksLikePdf,
  getSignedUrl,
  storageKey,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  loadActiveVersion,
} from "../lib/documentVersions";
import {
  bumpDocumentVersionContentRevision,
  enqueueDocumentIndex,
} from "../lib/indexing/indexer";
import { ensureDocAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import { rescanLinkedDocument } from "../lib/sourceFolders";
import {
  findProjectRowForEntity,
  projectContextFor,
} from "../lib/projectRegistry";
import {
  appDataPath,
  appDbPath,
  runWithDatabaseContext,
  type DatabaseContext,
} from "../db/sqlite";
import { extractStructuredTextFromBytes } from "../lib/indexing/extractors";
import { generateDocumentOutlineFallback } from "../lib/documentOutline";
import { getUserModelSettings } from "../lib/userSettings";
import { resolveModel } from "../lib/llm";
import {
  IMAGE_DOCUMENT_TYPES,
  isAllowedDocumentType,
  isImageDocumentType,
  mimeTypeForDocumentType,
} from "../lib/documentTypes";
import { findMatchingOcrRegions } from "../lib/ocr/ocrRegions";
import {
  inferBriefSequence,
  inferDocRole,
  inferPartyRole,
} from "../lib/documentClassification";

export const documentsRouter = Router();
const ALLOWED_TYPES = new Set([
  "pdf",
  "docx",
  "doc",
  "txt",
  "md",
  ...IMAGE_DOCUMENT_TYPES,
]);

type PdfAnnotationRect = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type PdfAnnotationRow = {
  id: string;
  document_id: string;
  version_id: string | null;
  user_id: string;
  page_number: number;
  annotation_type: "highlight" | "comment";
  color: string;
  quote: string | null;
  comment: string | null;
  rects_json: string;
  source: "user" | "citation_promotion";
  source_citation_json: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type AccessibleDocument = {
  id: string;
  filename: string;
  file_type: string | null;
  user_id: string;
  project_id: string | null;
  current_version_id?: string | null;
};

function contextForDocumentId(documentId: string): DatabaseContext {
  const row = findProjectRowForEntity("document", documentId);
  if (row) return projectContextFor(row);
  return {
    kind: "app",
    dbPath: appDbPath(),
    dataRoot: appDataPath(),
  };
}

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  const docs = (data ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docs);
  await attachActiveVersionPaths(db, docs);
  res.json(docs);
});

// POST /single-documents
documentsRouter.post(
  "/",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    await handleDocumentUpload(req, res, userId, null, db);
  },
);

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });

  // Storage now lives on document_versions — fan out and delete each
  // version's bytes (DOCX + PDF rendition) before dropping rows.
  const { data: versions } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .eq("document_id", documentId);
  await Promise.all(
    (versions ?? []).flatMap((v) =>
      [v.storage_path, v.pdf_storage_path]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => deleteFile(p).catch(() => {})),
    ),
  );
  await db
    .from("documents")
    .delete()
    .eq("id", documentId)
    .eq("user_id", userId);
  res.status(204).send();
});

// GET /single-documents/:documentId/display
// Optional ?version_id= renders a historical version. Defaults to the
// document's current_version_id.
documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, filename, file_type, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const fileType = (doc.file_type as string) ?? "";
  const isDocx = fileType === "docx" || fileType === "doc";

  // For DOCX, prefer the per-version PDF rendition if one exists.
  const servePath =
    isDocx && active.pdf_storage_path
      ? active.pdf_storage_path
      : active.storage_path;
  const raw = await downloadFile(servePath);
  if (!raw || raw.byteLength === 0)
    return void res
      .status(404)
      .json({ detail: "Document not found in storage" });

  if (fileType === "pdf" || (isDocx && active.pdf_storage_path)) {
    if (!looksLikePdf(raw)) {
      // Bytes labelled PDF that aren't one — e.g. an HTML error page saved
      // with a .pdf extension, or a corrupt rendition. For DOCX, fall back
      // to the raw DOCX so the client-side viewer can still render it; for
      // PDFs there is nothing valid to serve.
      if (isDocx) {
        const original = await downloadFile(active.storage_path);
        if (original && original.byteLength > 0) {
          res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          );
          res.setHeader(
            "Content-Disposition",
            buildContentDisposition("inline", doc.filename as string),
          );
          return void res.send(Buffer.from(original));
        }
      }
      return void res
        .status(422)
        .json({ detail: "Stored file is not a valid PDF" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  } else if (fileType === "txt" || fileType === "md") {
    res.setHeader(
      "Content-Type",
      fileType === "md"
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8",
    );
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  } else if (isImageDocumentType(fileType)) {
    res.setHeader("Content-Type", mimeTypeForDocumentType(fileType));
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  } else {
    // Fallback: serve raw DOCX (mammoth will handle it client-side)
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  }
});

documentsRouter.get(
  "/:documentId/ocr-regions",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const pageNumber = Number(req.query.page);
    const quote =
      typeof req.query.quote === "string" ? req.query.quote.trim() : "";
    const versionId =
      typeof req.query.version_id === "string" ? req.query.version_id : null;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !quote) {
      return void res
        .status(400)
        .json({ detail: "page and quote are required" });
    }
    const db = createServerSupabase();
    const doc = await loadAccessibleDocument(documentId, userId, userEmail, db);
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const active = await loadActiveVersion(documentId, db, versionId);
    if (!active)
      return void res
        .status(404)
        .json({ detail: "Document version not found" });
    const { data, error } = await db
      .from("document_ocr_regions")
      .select("region_index, text, bbox_x, bbox_y, bbox_width, bbox_height")
      .eq("document_id", documentId)
      .eq("version_id", active.id)
      .eq("page_number", pageNumber)
      .order("region_index", { ascending: true });
    if (error) return void res.status(500).json({ detail: error.message });
    const matched = findMatchingOcrRegions(
      (data ?? []) as Parameters<typeof findMatchingOcrRegions>[0],
      quote,
    );
    res.json({
      page_number: pageNumber,
      regions: matched.map((region) => ({
        text: region.text,
        bbox: {
          x: region.bbox_x,
          y: region.bbox_y,
          width: region.bbox_width,
          height: region.bbox_height,
        },
      })),
    });
  },
);

// POST /single-documents/:documentId/outline
// Final server-side fallback for documents whose viewer-side heading and TOC
// analysis found nothing. It reads the selected version in the backend so raw
// document text never needs to be posted back from the renderer.
documentsRouter.post("/:documentId/outline", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.body?.version_id === "string" ? req.body.version_id : null;
  const requestedModel =
    typeof req.body?.model === "string" ? req.body.model.trim() : null;
  const db = createServerSupabase();

  const doc = await loadAccessibleDocument(documentId, userId, userEmail, db);
  if (!doc) return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active) {
    return void res.status(404).json({ detail: "No file available" });
  }
  // Match the bytes the viewer is navigating. DOC/DOCX versions may be shown
  // through a per-version PDF rendition; extracting that rendition preserves
  // physical page numbers for the generated outline. The original Word text
  // remains the fallback when no rendition exists.
  const outlineStoragePath = active.pdf_storage_path ?? active.storage_path;
  const raw = await downloadFile(outlineStoragePath);
  if (!raw) {
    return void res
      .status(404)
      .json({ detail: "Document bytes not available" });
  }

  try {
    const fileType = active.pdf_storage_path
      ? "pdf"
      : (doc.file_type ?? "").toLowerCase();
    const structured = await extractStructuredTextFromBytes(raw, fileType);
    const settings = await getUserModelSettings(userId, db);
    const model = resolveModel(requestedModel, settings.title_model);
    const result = await generateDocumentOutlineFallback({
      structured,
      fileType,
      model,
      apiKeys: settings.api_keys,
    });
    res.json(result);
  } catch (error) {
    console.error("[document-outline] fallback generation failed", {
      documentId,
      versionId: active.id,
      error,
    });
    res.status(502).json({ detail: "LLM outline generation failed." });
  }
});

// POST /single-documents/download-zip
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids } = req.body as { document_ids?: string[] };

  if (!Array.isArray(document_ids) || document_ids.length === 0)
    return void res.status(400).json({ detail: "document_ids is required" });

  const db = createServerSupabase();
  const { data: rawDocs, error } = await db
    .from("documents")
    .select("id, filename, file_type, current_version_id, user_id, project_id")
    .in("id", document_ids);

  if (error) return void res.status(500).json({ detail: error.message });
  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    (rawDocs ?? []).map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(
        d as { user_id: string; project_id: string | null },
        userId,
        userEmail,
        db,
      ),
    })),
  );
  const docs = accessChecks
    .filter((x) => x.access.ok)
    .map((x) => x.doc as { id: string; filename: string });
  if (!docs || docs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  await Promise.all(
    docs.map(async (doc) => {
      const active = await loadActiveVersion(doc.id, db);
      if (!active) return;
      const raw = await downloadFile(active.storage_path);
      if (!raw) return;
      zip.file(doc.filename, Buffer.from(raw));
    }),
  );

  const content = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  res.send(content);
});

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = resolveDownloadFilename(
    doc.filename as string,
    active.display_name,
    active.version_number,
  );
  const url = await getSignedUrl(active.storage_path, 3600, downloadFilename);
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    // Lets the frontend decide between DocView (PDF.js) and DocxView
    // (docx-preview) without a follow-up round-trip.
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// GET /single-documents/:documentId/docx
// Streams the raw .docx bytes for the given document, optionally at a
// specific tracked-changes version. Unlike /url, this bypasses R2 (avoids
// the browser CORS problem on signed URLs) so the frontend docx-preview
// viewer can load tracked-change documents directly.
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const raw = await downloadFile(active.storage_path);
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document bytes not available" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(
      "inline",
      resolveDownloadFilename(
        doc.filename as string,
        active.display_name,
        active.version_number,
      ),
    ),
  );
  res.send(Buffer.from(raw));
});

// GET /single-documents/:documentId/annotations
// Returns the current user's saved PDF annotations for the selected version.
documentsRouter.get(
  "/:documentId/annotations",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
      typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const doc = await loadAccessibleDocument(documentId, userId, userEmail, db);
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const imported = await importEmbeddedPdfAnnotationsFromVersion({
      db,
      doc,
      userId,
      active,
    });
    if (!imported.ok) {
      return void res.status(500).json({ detail: imported.detail });
    }

    const { data, error } = await db
      .from("pdf_annotations")
      .select("*")
      .eq("document_id", documentId)
      .eq("version_id", active.id)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (error) return void res.status(500).json({ detail: error.message });
    res.json(((data ?? []) as PdfAnnotationRow[]).map(formatAnnotationRow));
  },
);

// POST /single-documents/:documentId/annotations
documentsRouter.post(
  "/:documentId/annotations",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const doc = await loadAccessibleDocument(documentId, userId, userEmail, db);
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    const versionId =
      typeof req.body?.version_id === "string" ? req.body.version_id : null;
    const active = await loadActiveVersion(documentId, db, versionId);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const parsed = parseAnnotationPayload(req.body, active.id);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

    const now = new Date().toISOString();
    const annotationId = crypto.randomUUID();
    const { data, error } = await db
      .from("pdf_annotations")
      .insert({
        id: annotationId,
        document_id: documentId,
        version_id: active.id,
        user_id: userId,
        page_number: parsed.annotation.page_number,
        annotation_type: parsed.annotation.annotation_type,
        color: parsed.annotation.color,
        quote: parsed.annotation.quote,
        comment: parsed.annotation.comment,
        rects_json: JSON.stringify(parsed.annotation.rects),
        source: parsed.annotation.source,
        source_citation_json: parsed.annotation.source_citation
          ? JSON.stringify(parsed.annotation.source_citation)
          : null,
        created_at: now,
        updated_at: now,
      })
      .select("*")
      .single();

    if (error || !data)
      return void res.status(500).json({
        detail: error?.message ?? "Failed to save annotation",
      });

    res.status(201).json(formatAnnotationRow(data as PdfAnnotationRow));
  },
);

// PATCH /single-documents/:documentId/annotations/:annotationId
documentsRouter.patch(
  "/:documentId/annotations/:annotationId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, annotationId } = req.params;
    const db = createServerSupabase();

    const doc = await loadAccessibleDocument(documentId, userId, userEmail, db);
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    const { data: existing } = await db
      .from("pdf_annotations")
      .select("*")
      .eq("id", annotationId)
      .eq("document_id", documentId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .single();
    if (!existing)
      return void res.status(404).json({ detail: "Annotation not found" });

    const patch = parseAnnotationPatch(req.body);
    if (!patch.ok) return void res.status(400).json({ detail: patch.detail });

    const { data, error } = await db
      .from("pdf_annotations")
      .update({ ...patch.values, updated_at: new Date().toISOString() })
      .eq("id", annotationId)
      .eq("document_id", documentId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .select("*")
      .single();

    if (error || !data)
      return void res.status(500).json({
        detail: error?.message ?? "Failed to update annotation",
      });

    res.json(formatAnnotationRow(data as PdfAnnotationRow));
  },
);

// DELETE /single-documents/:documentId/annotations/:annotationId
documentsRouter.delete(
  "/:documentId/annotations/:annotationId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, annotationId } = req.params;
    const db = createServerSupabase();

    const doc = await loadAccessibleDocument(documentId, userId, userEmail, db);
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    const { data: existing } = await db
      .from("pdf_annotations")
      .select("*")
      .eq("id", annotationId)
      .eq("document_id", documentId)
      .eq("user_id", userId)
      .single();
    if (!existing)
      return void res.status(404).json({ detail: "Annotation not found" });
    if (annotationId.startsWith("external-")) {
      await db
        .from("pdf_annotations")
        .update({
          deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", annotationId)
        .eq("document_id", documentId)
        .eq("user_id", userId);
    } else {
      await db
        .from("pdf_annotations")
        .delete()
        .eq("id", annotationId)
        .eq("document_id", documentId)
        .eq("user_id", userId);
    }
    res.status(204).send();
  },
);

// POST /single-documents/:documentId/rescan
// Per-document counterpart of the source-folder rescan: pick up on-disk
// changes to the linked file as a new version, then re-import embedded
// PDF annotations (external editors write them into the file itself).
documentsRouter.post("/:documentId/rescan", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const doc = await loadAccessibleDocument(documentId, userId, userEmail, db);
  if (!doc) return void res.status(404).json({ detail: "Document not found" });

  const rescan = await rescanLinkedDocument({ db, userId, documentId });
  if (rescan.status === "error") {
    return void res.status(500).json({ detail: rescan.detail });
  }

  let annotationsSynced = false;
  if (doc.file_type === "pdf") {
    const active = await loadActiveVersion(documentId, db, null);
    if (active) {
      const imported = await importEmbeddedPdfAnnotationsFromVersion({
        db,
        doc,
        userId,
        active,
      });
      annotationsSynced = imported.ok;
    }
  }

  res.json({ ...rescan, annotations_synced: annotationsSynced });
});

// POST /single-documents/:documentId/annotations/export-pdf
// Flattens saved highlights/comments into a new generated PDF version. This
// intentionally never writes back to linked source files or uploaded originals.
documentsRouter.post(
  "/:documentId/annotations/export-pdf",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
      typeof req.body?.version_id === "string" ? req.body.version_id : null;
    const db = createServerSupabase();

    const doc = await loadAccessibleDocument(documentId, userId, userEmail, db);
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    if (doc.file_type !== "pdf") {
      return void res.status(400).json({
        detail: "Annotated PDF export is currently available for PDF files.",
      });
    }

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const exported = await exportPdfAnnotationsToNewVersion({
      db,
      doc,
      userId,
      sourceVersionId: active.id,
      requireAnnotations: true,
    });
    if (!exported.ok) {
      const status =
        exported.detail === "No annotations to export." ? 400 : 500;
      return void res.status(status).json({ detail: exported.detail });
    }

    res.status(201).json(exported.version);
  },
);

type FormattedPdfAnnotation = ReturnType<typeof formatAnnotationRow>;
type ActivePdfVersion = NonNullable<
  Awaited<ReturnType<typeof loadActiveVersion>>
>;
type AnnotatedPdfExportVersion = {
  id: string;
  version_number: number | null;
  source: string | null;
  created_at?: string;
  display_name: string | null;
};
const exportQueues = new Map<string, Promise<unknown>>();

async function exportPdfAnnotationsToNewVersion({
  db,
  doc,
  userId,
  sourceVersionId,
  requireAnnotations = false,
}: {
  db: ReturnType<typeof createServerSupabase>;
  doc: AccessibleDocument;
  userId: string;
  sourceVersionId: string | null;
  requireAnnotations?: boolean;
}): Promise<
  | { ok: true; version: AnnotatedPdfExportVersion; annotationCount: number }
  | { ok: false; detail: string }
> {
  return enqueuePdfAnnotationExport(
    `${doc.id}:${sourceVersionId ?? "current"}`,
    () =>
      exportPdfAnnotationsToNewVersionNow({
        db,
        doc,
        userId,
        sourceVersionId,
        requireAnnotations,
      }),
  );
}

async function exportPdfAnnotationsToNewVersionNow({
  db,
  doc,
  userId,
  sourceVersionId,
  requireAnnotations = false,
}: {
  db: ReturnType<typeof createServerSupabase>;
  doc: AccessibleDocument;
  userId: string;
  sourceVersionId: string | null;
  requireAnnotations?: boolean;
}): Promise<
  | { ok: true; version: AnnotatedPdfExportVersion; annotationCount: number }
  | { ok: false; detail: string }
> {
  if (doc.file_type !== "pdf") {
    return {
      ok: false,
      detail: "Annotated PDF export is currently available for PDF files.",
    };
  }
  const active = await loadActiveVersion(doc.id, db, sourceVersionId);
  if (!active) return { ok: false, detail: "No file available" };

  const { data: rows, error } = await db
    .from("pdf_annotations")
    .select("*")
    .eq("document_id", doc.id)
    .eq("version_id", active.id)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, detail: error.message };

  const allRows = (rows ?? []) as PdfAnnotationRow[];
  const annotations = allRows
    .filter((row) => !row.deleted_at)
    .map(formatAnnotationRow);
  const hasAnnotationRemovals = allRows.some((row) => row.deleted_at);
  if (requireAnnotations && annotations.length === 0 && !hasAnnotationRemovals) {
    return { ok: false, detail: "No annotations to export." };
  }

  const raw = await downloadFile(active.storage_path);
  if (!raw) return { ok: false, detail: "Document bytes not available" };

  const pdfDoc = await PDFDocument.load(raw);
  removeManagedPdfAnnotations(
    pdfDoc,
    new Set(allRows.map((ann) => ann.id)),
  );
  addEditablePdfAnnotations(pdfDoc, annotations);
  const bytes = await pdfDoc.save();
  const bytesBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  const displayBase = doc.filename.replace(/\.pdf$/i, "");
  const versionSlug = crypto.randomUUID().replace(/-/g, "");
  const key = versionStorageKey(userId, doc.id, versionSlug, doc.filename);
  await uploadFile(key, bytesBuffer, "application/pdf");

  const { data: maxRow } = await db
    .from("document_versions")
    .select("version_number")
    .eq("document_id", doc.id)
    .order("version_number", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const nextVersionNumber =
    ((maxRow?.version_number as number | null) ?? 1) + 1;

  const { data: versionRow, error: verErr } = await db
    .from("document_versions")
    .insert({
      document_id: doc.id,
      storage_path: key,
      pdf_storage_path: key,
      source: "generated",
      version_number: nextVersionNumber,
      display_name: `${displayBase} [Annotated].pdf`,
    })
    .select("id, version_number, source, created_at, display_name")
    .single();
  if (verErr || !versionRow) {
    return {
      ok: false,
      detail: verErr?.message ?? "Failed to record annotated version",
    };
  }

  return {
    ok: true,
    annotationCount: annotations.length,
    version: versionRow as AnnotatedPdfExportVersion,
  };
}

function enqueuePdfAnnotationExport<T>(
  key: string,
  job: () => Promise<T>,
): Promise<T> {
  const previous = exportQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(job);
  exportQueues.set(key, next);
  return next.finally(() => {
    if (exportQueues.get(key) === next) {
      exportQueues.delete(key);
    }
  });
}

async function importEmbeddedPdfAnnotationsFromVersion({
  db,
  doc,
  userId,
  active,
}: {
  db: ReturnType<typeof createServerSupabase>;
  doc: AccessibleDocument;
  userId: string;
  active: ActivePdfVersion;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (doc.file_type !== "pdf" || active.source === "generated") {
    return { ok: true };
  }
  const raw = await downloadFile(active.storage_path);
  if (!raw) return { ok: true };
  let imported: ImportedPdfAnnotation[];
  try {
    imported = await readPdfAnnotationsForSync(raw);
  } catch (err) {
    return {
      ok: false,
      detail:
        err instanceof Error
          ? err.message
          : "Failed to import embedded PDF annotations",
    };
  }

  const { data: rows, error } = await db
    .from("pdf_annotations")
    .select("*")
    .eq("document_id", doc.id)
    .eq("version_id", active.id)
    .eq("user_id", userId);
  if (error) return { ok: false, detail: error.message };
  const existingRows = (rows ?? []) as PdfAnnotationRow[];
  if (existingRows.length === 0 && imported.length === 0) return { ok: true };

  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  for (const ann of imported) {
    const existing = existingById.get(ann.id);
    if (existing) {
      // Rows imported before quote recovery existed have an empty quote;
      // fill it in now that the text under the rects is derivable.
      if (
        !existing.deleted_at &&
        ann.quote?.trim() &&
        !(existing.quote ?? "").trim()
      ) {
        await db
          .from("pdf_annotations")
          .update({
            quote: ann.quote,
            updated_at: new Date().toISOString(),
          })
          .eq("id", ann.id);
      }
      continue;
    }
    const now = new Date().toISOString();
    await db.from("pdf_annotations").insert({
      id: ann.id,
      document_id: doc.id,
      version_id: active.id,
      user_id: userId,
      page_number: ann.page_number,
      annotation_type: ann.annotation_type,
      color: ann.color,
      quote: ann.quote,
      comment: ann.comment,
      rects_json: JSON.stringify(ann.rects),
      source: "user",
      source_citation_json: null,
      created_at: now,
      updated_at: now,
    });
  }

  return { ok: true };
}

async function loadAccessibleDocument(
  documentId: string,
  userId: string,
  userEmail: string | undefined,
  db: ReturnType<typeof createServerSupabase>,
): Promise<AccessibleDocument | null> {
  const { data: doc } = await db
    .from("documents")
    .select("id, filename, file_type, user_id, project_id, current_version_id")
    .eq("id", documentId)
    .single();
  if (!doc) return null;
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok) return null;
  return doc as AccessibleDocument;
}

function formatAnnotationRow(row: PdfAnnotationRow) {
  return {
    id: row.id,
    document_id: row.document_id,
    version_id: row.version_id,
    user_id: row.user_id,
    page_number: row.page_number,
    annotation_type: row.annotation_type,
    color: row.color,
    quote: row.quote,
    comment: row.comment,
    rects: parseJsonArray<PdfAnnotationRect>(row.rects_json),
    source: row.source,
    source_citation: row.source_citation_json
      ? parseJsonObject(row.source_citation_json)
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseAnnotationPayload(
  body: unknown,
  versionId: string,
):
  | {
      ok: true;
      annotation: {
        version_id: string;
        page_number: number;
        annotation_type: "highlight" | "comment";
        color: string;
        quote: string | null;
        comment: string | null;
        rects: PdfAnnotationRect[];
        source: "user" | "citation_promotion";
        source_citation: Record<string, unknown> | null;
      };
    }
  | { ok: false; detail: string } {
  const raw = body as Record<string, unknown>;
  const annotationType = raw.annotation_type;
  if (annotationType !== "highlight" && annotationType !== "comment") {
    return {
      ok: false,
      detail: "annotation_type must be highlight or comment",
    };
  }
  const rectsResult = parseRects(raw.rects);
  if (!rectsResult.ok) return rectsResult;
  const pageNumber =
    typeof raw.page_number === "number"
      ? raw.page_number
      : rectsResult.rects[0]?.page;
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return { ok: false, detail: "page_number must be a positive integer" };
  }
  const color =
    typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color)
      ? raw.color
      : "#ffe066";
  const source =
    raw.source === "citation_promotion" ? "citation_promotion" : "user";
  const sourceCitation =
    raw.source_citation &&
    typeof raw.source_citation === "object" &&
    !Array.isArray(raw.source_citation)
      ? (raw.source_citation as Record<string, unknown>)
      : null;
  return {
    ok: true,
    annotation: {
      version_id: versionId,
      page_number: pageNumber,
      annotation_type: annotationType,
      color,
      quote: nullableString(raw.quote, 4000),
      comment: nullableString(raw.comment, 2000),
      rects: rectsResult.rects,
      source,
      source_citation: sourceCitation,
    },
  };
}

function parseAnnotationPatch(
  body: unknown,
):
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; detail: string } {
  const raw = body as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  if ("annotation_type" in raw) {
    if (
      raw.annotation_type !== "highlight" &&
      raw.annotation_type !== "comment"
    ) {
      return {
        ok: false,
        detail: "annotation_type must be highlight or comment",
      };
    }
    values.annotation_type = raw.annotation_type;
  }
  if ("color" in raw) {
    if (typeof raw.color !== "string" || !/^#[0-9a-f]{6}$/i.test(raw.color)) {
      return { ok: false, detail: "color must be a hex color" };
    }
    values.color = raw.color;
  }
  if ("quote" in raw) values.quote = nullableString(raw.quote, 4000);
  if ("comment" in raw) values.comment = nullableString(raw.comment, 2000);
  if ("source_citation" in raw) {
    if (raw.source_citation === null) {
      values.source_citation_json = null;
    } else if (
      raw.source_citation &&
      typeof raw.source_citation === "object" &&
      !Array.isArray(raw.source_citation)
    ) {
      values.source_citation_json = JSON.stringify(raw.source_citation);
    } else {
      return { ok: false, detail: "source_citation must be an object or null" };
    }
  }
  if ("rects" in raw) {
    const rectsResult = parseRects(raw.rects);
    if (!rectsResult.ok) return rectsResult;
    values.rects_json = JSON.stringify(rectsResult.rects);
    values.page_number = rectsResult.rects[0]?.page ?? 1;
  }
  return { ok: true, values };
}

function parseRects(
  input: unknown,
): { ok: true; rects: PdfAnnotationRect[] } | { ok: false; detail: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, detail: "rects must be a non-empty array" };
  }
  if (input.length > 80) {
    return { ok: false, detail: "rects contains too many entries" };
  }
  const rects: PdfAnnotationRect[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, detail: "rect entries must be objects" };
    }
    const r = raw as Record<string, unknown>;
    const rect = {
      page: Number(r.page),
      x: Number(r.x),
      y: Number(r.y),
      width: Number(r.width),
      height: Number(r.height),
    };
    if (
      !Number.isInteger(rect.page) ||
      rect.page < 1 ||
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return {
        ok: false,
        detail: "rect entries must contain finite PDF coordinates",
      };
    }
    rects.push(rect);
  }
  return { ok: true, rects };
}

function nullableString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  const clean = m?.[1] ?? "ffe066";
  return {
    r: parseInt(clean.slice(0, 2), 16) / 255,
    g: parseInt(clean.slice(2, 4), 16) / 255,
    b: parseInt(clean.slice(4, 6), 16) / 255,
  };
}

type ImportedPdfAnnotation = {
  id: string;
  page_number: number;
  annotation_type: "highlight" | "comment";
  color: string;
  quote: string | null;
  comment: string | null;
  rects: PdfAnnotationRect[];
};

function addEditablePdfAnnotations(
  pdfDoc: PDFDocument,
  annotations: FormattedPdfAnnotation[],
): void {
  for (const ann of annotations) {
    const color = parseHexColor(ann.color);
    ann.rects.forEach((rect, rectIndex) => {
      if (rect.page < 1 || rect.page > pdfDoc.getPageCount()) return;
      const page = pdfDoc.getPage(rect.page - 1);
      addPdfAnnotationObject(pdfDoc, page, ann, rect, color, rectIndex);
    });
  }
}

function removeManagedPdfAnnotations(
  pdfDoc: PDFDocument,
  managedIds: Set<string>,
): void {
  for (let pageIndex = 0; pageIndex < pdfDoc.getPageCount(); pageIndex++) {
    const page = pdfDoc.getPage(pageIndex);
    const annots = page.node.Annots();
    if (!annots) continue;
    const filtered = PDFArray.withContext(pdfDoc.context);
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = annots.lookup(i);
      if (
        dict instanceof PDFDict &&
        isManagedPdfAnnotation(dict, pageIndex + 1, managedIds)
      ) {
        continue;
      }
      filtered.push(raw);
    }
    page.node.set(PDFName.of("Annots"), filtered);
  }
}

type PdfPageTextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

// Positioned page text for the given 1-based pages. Highlights imported
// from other PDF editors store only rects — never the highlighted text —
// so the quote has to be recovered from the page text under those rects.
async function extractPdfTextItems(
  raw: ArrayBuffer,
  pageNumbers: Set<number>,
): Promise<Map<number, PdfPageTextItem[]>> {
  const byPage = new Map<number, PdfPageTextItem[]>();
  if (pageNumbers.size === 0) return byPage;
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{
            numPages: number;
            getPage: (n: number) => Promise<{
              getTextContent: () => Promise<{ items: unknown[] }>;
            }>;
          }>;
        };
      }
    ).getDocument({ data: new Uint8Array(raw) }).promise;
    for (const pageNumber of pageNumbers) {
      if (pageNumber < 1 || pageNumber > pdf.numPages) continue;
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const items: PdfPageTextItem[] = [];
      for (const entry of content.items) {
        const item = entry as {
          str?: unknown;
          transform?: unknown;
          width?: unknown;
          height?: unknown;
        };
        if (typeof item.str !== "string" || !item.str) continue;
        const transform = Array.isArray(item.transform)
          ? (item.transform as number[])
          : null;
        if (!transform || transform.length < 6) continue;
        const x = Number(transform[4]);
        const y = Number(transform[5]);
        const width = Number(item.width);
        const height =
          Number(item.height) || Math.abs(Number(transform[3])) || 0;
        if (![x, y, width].every(Number.isFinite)) continue;
        items.push({ text: item.str, x, y, width, height });
      }
      byPage.set(pageNumber, items);
    }
  } catch {
    // Text recovery is best-effort; annotations keep an empty quote.
  }
  return byPage;
}

// Text items and annotation rects share PDF user-space coordinates
// (y-up, origin bottom-left). pdfjs only reports per-run geometry, so
// characters are sliced proportionally within each run.
function quoteFromRects(
  items: PdfPageTextItem[],
  rects: PdfAnnotationRect[],
): string | null {
  const picked: { x: number; y: number; text: string }[] = [];
  for (const item of items) {
    const lineHeight = item.height || 1;
    for (const rect of rects) {
      const verticalOverlap =
        Math.min(rect.y + rect.height, item.y + lineHeight) -
        Math.max(rect.y, item.y);
      if (verticalOverlap < lineHeight * 0.35) continue;
      const charWidth = item.width / Math.max(item.text.length, 1);
      let text = "";
      for (let i = 0; i < item.text.length; i++) {
        const center = item.x + charWidth * (i + 0.5);
        if (
          center >= rect.x - charWidth * 0.25 &&
          center <= rect.x + rect.width + charWidth * 0.25
        ) {
          text += item.text[i];
        }
      }
      if (text.trim()) {
        picked.push({ x: item.x, y: item.y, text: text.trim() });
        break;
      }
    }
  }
  if (picked.length === 0) return null;
  picked.sort((a, b) => {
    const lineTolerance = 3;
    if (Math.abs(a.y - b.y) > lineTolerance) return b.y - a.y;
    return a.x - b.x;
  });
  const joined = picked
    .map((p) => p.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!joined) return null;
  return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
}

async function readPdfAnnotationsForSync(
  raw: ArrayBuffer,
): Promise<ImportedPdfAnnotation[]> {
  const pdfDoc = await PDFDocument.load(raw);
  const grouped = new Map<string, ImportedPdfAnnotation>();
  for (let pageIndex = 0; pageIndex < pdfDoc.getPageCount(); pageIndex++) {
    const page = pdfDoc.getPage(pageIndex);
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const candidate = annots.lookup(i);
      if (!(candidate instanceof PDFDict)) continue;
      const dict = candidate;
      const subtype = String(dict.get(PDFName.of("Subtype")));
      if (subtype !== "/Highlight" && subtype !== "/Text") continue;
      const rect = readRectFromAnnotation(dict, pageIndex + 1);
      if (!rect) continue;
      const contents = readPdfText(dict.get(PDFName.of("Contents")));
      const annotationType = subtype === "/Text" ? "comment" : "highlight";
      const color = readColorFromAnnotation(dict);
      const id =
        docketAnnotationIdFromDict(dict) ??
        externalAnnotationId({
          subtype,
          pageNumber: pageIndex + 1,
          rect,
          contents,
          color,
        });
      const existing = grouped.get(id);
      const next: ImportedPdfAnnotation = existing ?? {
        id,
        page_number: pageIndex + 1,
        annotation_type: annotationType,
        color,
        quote: annotationType === "highlight" ? contents : null,
        comment: annotationType === "comment" ? contents : null,
        rects: [],
      };
      next.rects.push(rect);
      grouped.set(id, next);
    }
  }
  const annotations = Array.from(grouped.values());

  // External-editor highlights carry no text in /Contents; recover their
  // quotes from the page text under the highlight rects.
  const pagesNeedingText = new Set(
    annotations
      .filter(
        (ann) => ann.annotation_type === "highlight" && !ann.quote?.trim(),
      )
      .map((ann) => ann.page_number),
  );
  if (pagesNeedingText.size > 0) {
    const textByPage = await extractPdfTextItems(raw, pagesNeedingText);
    for (const ann of annotations) {
      if (ann.annotation_type !== "highlight" || ann.quote?.trim()) continue;
      const items = textByPage.get(ann.page_number);
      if (!items?.length) continue;
      ann.quote = quoteFromRects(items, ann.rects);
    }
  }
  return annotations;
}

function addPdfAnnotationObject(
  pdfDoc: PDFDocument,
  page: PDFPage,
  ann: FormattedPdfAnnotation,
  rect: PdfAnnotationRect,
  color: { r: number; g: number; b: number },
  rectIndex: number,
): void {
  const annots = ensurePageAnnots(pdfDoc, page);
  const bounds = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
  const contents =
    ann.comment?.trim() || ann.quote?.trim() || "Docket annotation";
  const subtype =
    ann.annotation_type === "comment"
      ? PDFName.of("Text")
      : PDFName.of("Highlight");
  const dict = pdfDoc.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: subtype,
    Rect: bounds,
    C: [color.r, color.g, color.b],
    Contents: PDFHexString.fromText(contents),
    NM: PDFHexString.fromText(`docket:${ann.id}:${rectIndex}`),
    T: PDFHexString.fromText("Docket Local"),
    M: PDFHexString.fromText(
      new Date(ann.updated_at || ann.created_at).toISOString(),
    ),
    Subj: PDFHexString.fromText(
      ann.annotation_type === "comment" ? "Comment" : "Highlight",
    ),
    F: 4,
  });
  if (ann.annotation_type === "highlight") {
    dict.set(
      PDFName.of("QuadPoints"),
      pdfDoc.context.obj([
        rect.x,
        rect.y + rect.height,
        rect.x + rect.width,
        rect.y + rect.height,
        rect.x,
        rect.y,
        rect.x + rect.width,
        rect.y,
      ]),
    );
    dict.set(PDFName.of("CA"), pdfDoc.context.obj(0.34));
  } else {
    dict.set(PDFName.of("Name"), PDFName.of("Comment"));
    dict.set(PDFName.of("Open"), pdfDoc.context.obj(false));
  }
  annots.push(pdfDoc.context.register(dict));
}

function isDocketPdfAnnotation(dict: PDFDict): boolean {
  const id = docketAnnotationIdFromDict(dict);
  if (id) return true;
  return readPdfText(dict.get(PDFName.of("T"))) === "Docket Local";
}

function isManagedPdfAnnotation(
  dict: PDFDict,
  pageNumber: number,
  managedIds: Set<string>,
): boolean {
  const docketId = docketAnnotationIdFromDict(dict);
  if (docketId)
    return (
      managedIds.has(docketId) ||
      readPdfText(dict.get(PDFName.of("T"))) === "Docket Local"
    );
  const subtype = String(dict.get(PDFName.of("Subtype")));
  if (subtype !== "/Highlight" && subtype !== "/Text") return false;
  const rect = readRectFromAnnotation(dict, pageNumber);
  if (!rect) return false;
  const externalId = externalAnnotationId({
    subtype,
    pageNumber,
    rect,
    contents: readPdfText(dict.get(PDFName.of("Contents"))),
    color: readColorFromAnnotation(dict),
  });
  return managedIds.has(externalId);
}

function docketAnnotationIdFromDict(dict: PDFDict): string | null {
  const raw = readPdfText(dict.get(PDFName.of("NM")));
  const match = raw.match(/^docket:([^:]+)(?::\d+)?$/);
  return match?.[1] ?? null;
}

function readRectFromAnnotation(
  dict: PDFDict,
  pageNumber: number,
): PdfAnnotationRect | null {
  const rect = dict.get(PDFName.of("Rect"));
  if (!(rect instanceof PDFArray)) return null;
  const values = readPdfNumberArray(rect);
  if (values.length < 4) return null;
  const [x1, y1, x2, y2] = values;
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) {
    return null;
  }
  return { page: pageNumber, x, y, width, height };
}

function readColorFromAnnotation(dict: PDFDict): string {
  const color = dict.get(PDFName.of("C"));
  if (!(color instanceof PDFArray)) return "#ffe066";
  const values = readPdfNumberArray(color);
  if (values.length < 3) return "#ffe066";
  const toHex = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(values[0])}${toHex(values[1])}${toHex(values[2])}`;
}

function externalAnnotationId({
  subtype,
  pageNumber,
  rect,
  contents,
  color,
}: {
  subtype: string;
  pageNumber: number;
  rect: PdfAnnotationRect;
  contents: string;
  color: string;
}): string {
  const signature = JSON.stringify({
    subtype,
    pageNumber,
    rect: {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    },
    contents,
    color,
  });
  return `external-${createHash("sha1")
    .update(signature)
    .digest("hex")
    .slice(0, 24)}`;
}

function readPdfNumberArray(array: PDFArray): number[] {
  const values: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const item = array.lookup(i);
    if (item instanceof PDFNumber) values.push(item.asNumber());
  }
  return values;
}

function readPdfText(value: unknown): string {
  if (value instanceof PDFHexString || value instanceof PDFString) {
    return value.decodeText();
  }
  return "";
}

function ensurePageAnnots(pdfDoc: PDFDocument, page: PDFPage): PDFArray {
  const existing = page.node.Annots();
  if (existing) return existing;
  const annots = PDFArray.withContext(pdfDoc.context);
  page.node.set(PDFName.of("Annots"), annots);
  return annots;
}

// Compose a download-friendly filename that carries the edit version
// marker: "Purchase Agreement.docx" → "Purchase Agreement [Edited V2].docx".
// Preserves the original extension (fallback: .docx).
function versionedFilename(filename: string, version: number | null): string {
  if (!version || version < 1) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".docx";
  return `${stem} [Edited V${version}]${ext}`;
}

// Produce the filename a download should present to the user for a given
// (document, version) pair. Prefers the version's display_name (appending
// the original extension if the user didn't include one), falling back to
// the versionedFilename heuristic.
function resolveDownloadFilename(
  originalFilename: string,
  displayName: string | null | undefined,
  versionNumber: number | null,
): string {
  const dot = originalFilename.lastIndexOf(".");
  const origExt = dot > 0 ? originalFilename.slice(dot) : "";
  if (displayName && displayName.trim()) {
    const trimmed = displayName.trim();
    const trimmedDot = trimmed.lastIndexOf(".");
    const hasExt =
      trimmedDot > 0 &&
      trimmed
        .slice(trimmedDot)
        .toLowerCase()
        .match(/^\.[a-z0-9]{1,6}$/);
    if (hasExt) return trimmed;
    return origExt ? `${trimmed}${origExt}` : trimmed;
  }
  return versionedFilename(originalFilename, versionNumber);
}

// GET /single-documents/:documentId/versions
// Returns every version row for the document in document order, with
// the human-friendly version number when present.
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const { data: rows } = await db
    .from("document_versions")
    .select("id, version_number, source, created_at, display_name")
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });

  res.json({
    current_version_id: doc.current_version_id,
    versions: rows ?? [],
  });
});

// POST /single-documents/:documentId/versions
// Upload a brand-new version of an existing document. The uploaded file
// becomes the new current_version_id. display_name defaults to the
// uploaded filename; client may override via the `display_name` form field.
documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;

    const file = req.file;
    if (!file) return void res.status(400).json({ detail: "file is required" });

    await runWithDatabaseContext(contextForDocumentId(documentId), async () => {
      const db = createServerSupabase();

      const { data: doc } = await db
        .from("documents")
        .select("id, filename, file_type, user_id, project_id")
        .eq("id", documentId)
        .single();
      if (!doc)
        return void res.status(404).json({ detail: "Document not found" });
      const access = await ensureDocAccess(doc, userId, userEmail, db);
      if (!access.ok)
        return void res.status(404).json({ detail: "Document not found" });

      // Reject if the uploaded file's extension doesn't match the document's
      // declared type — otherwise every downstream viewer/extractor breaks.
      const suffix = file.originalname.includes(".")
        ? file.originalname.split(".").pop()!.toLowerCase()
        : "";
      if (doc.file_type && suffix && doc.file_type !== suffix) {
        return void res.status(400).json({
          detail: `Uploaded file type (${suffix}) does not match document type (${doc.file_type}).`,
        });
      }

      // Peg the new version into a predictable /versions/:id path under the
      // existing document folder so ops can spot the history in storage.
      const versionSlug = crypto.randomUUID().replace(/-/g, "");
      const key = versionStorageKey(
        userId,
        documentId,
        versionSlug,
        file.originalname,
      );
      const contentType = mimeTypeForDocumentType(suffix);
      try {
        await uploadFile(
          key,
          file.buffer.buffer.slice(
            file.buffer.byteOffset,
            file.buffer.byteOffset + file.buffer.byteLength,
          ) as ArrayBuffer,
          contentType,
        );
      } catch (e) {
        console.error("[versions/upload] storage write failed", e);
        return void res
          .status(500)
          .json({ detail: "Failed to upload new version." });
      }

      // Render this version's bytes to PDF up front so /display can show
      // historical versions without on-demand conversion. Same logic as the
      // initial-upload pipeline; failures don't block the version row.
      let pdfStoragePath: string | null = null;
      if (suffix === "docx" || suffix === "doc") {
        try {
          const pdfBuf = await docxToPdf(file.buffer);
          const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
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
            `[versions/upload] DOCX→PDF conversion failed for ${file.originalname}:`,
            err,
          );
        }
      } else if (suffix === "pdf") {
        // For PDF uploads, the uploaded bytes are themselves the PDF rendition.
        pdfStoragePath = key;
      }

      // Per-document sequential version_number — the upload is V1 and
      // user_upload + assistant_edit count forward from there.
      const { data: maxRow } = await db
        .from("document_versions")
        .select("version_number")
        .eq("document_id", documentId)
        .in("source", ["upload", "user_upload", "assistant_edit"])
        .order("version_number", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      const nextVersionNumber =
        ((maxRow?.version_number as number | null) ?? 1) + 1;

      const defaultDisplayName =
        typeof req.body?.display_name === "string" &&
        req.body.display_name.trim()
          ? req.body.display_name.trim().slice(0, 200)
          : file.originalname;

      const { data: versionRow, error: verErr } = await db
        .from("document_versions")
        .insert({
          document_id: documentId,
          storage_path: key,
          pdf_storage_path: pdfStoragePath,
          source: "user_upload",
          version_number: nextVersionNumber,
          display_name: defaultDisplayName,
        })
        .select("id, version_number, source, created_at, display_name")
        .single();
      if (verErr || !versionRow) {
        console.error("[versions/upload] insert failed", verErr);
        return void res
          .status(500)
          .json({ detail: "Failed to record new version." });
      }

      // Also propagate the user-provided display_name to the parent document's
      // filename so the document's display name stays in sync across the UI.
      // Preserve a sensible extension: if the display_name has none, append
      // the uploaded file's extension (fallback: the existing doc's extension).
      const documentsUpdate: Record<string, unknown> = {
        current_version_id: versionRow.id,
      };
      const providedDisplayName =
        typeof req.body?.display_name === "string" &&
        req.body.display_name.trim()
          ? req.body.display_name.trim().slice(0, 200)
          : null;
      if (providedDisplayName) {
        const hasExt = /\.[a-z0-9]{1,6}$/i.test(providedDisplayName);
        const existingExt = (doc.filename as string | null)?.match(
          /\.[a-z0-9]{1,6}$/i,
        )?.[0];
        const uploadedExt = suffix ? `.${suffix}` : "";
        const ext = hasExt ? "" : uploadedExt || existingExt || "";
        documentsUpdate.filename = `${providedDisplayName}${ext}`;
      }
      await db.from("documents").update(documentsUpdate).eq("id", documentId);
      enqueueDocumentIndex(documentId, versionRow.id as string);

      res.status(201).json(versionRow);
    });
  },
);

// PATCH /single-documents/:documentId/versions/:versionId
// Rename a version's display_name. Pass `{ "display_name": "…" }`; an empty
// or missing value clears the override so the UI falls back to V{n}.
documentsRouter.patch(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const raw = req.body?.display_name;
    const displayName =
      typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

    const { data: updated, error } = await db
      .from("document_versions")
      .update({ display_name: displayName })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .select("id, version_number, source, created_at, display_name")
      .single();
    if (error || !updated) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json(updated);
  },
);

// GET /single-documents/:documentId/tracked-change-ids
// Returns the ordered list of { kind, w_id } for every w:ins / w:del in
// the current (or specified) version's document.xml. The frontend uses
// this to tag each rendered <ins>/<del> with data-w-id, since
// docx-preview drops the w:id attribute during parsing.
documentsRouter.get(
  "/:documentId/tracked-change-ids",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
      typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const raw = await downloadFile(active.storage_path);
    if (!raw)
      return void res
        .status(404)
        .json({ detail: "Document bytes not available" });

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    res.json({ ids });
  },
);

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
  req: import("express").Request,
  res: import("express").Response,
  mode: "accept" | "reject",
) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId, editId } = req.params;
  const db = createServerSupabase();

  console.log(`[edit-resolution] incoming ${mode}`, {
    userId,
    documentId,
    editId,
  });

  const { data: edit, error: editErr } = await db
    .from("document_edits")
    .select("id, document_id, change_id, del_w_id, ins_w_id, status")
    .eq("id", editId)
    .eq("document_id", documentId)
    .single();
  console.log(`[edit-resolution] fetched edit row`, { edit, editErr });
  if (!edit) {
    console.log(`[edit-resolution] edit not found, returning 404`);
    return void res.status(404).json({ detail: "Edit not found" });
  }
  // Idempotent: if the edit is already resolved, return the current doc
  // state so stale UI (e.g. an old chat reloaded in a new session) can
  // reconcile without throwing.
  if (edit.status !== "pending") {
    console.log(`[edit-resolution] edit already resolved`, {
      editId,
      status: edit.status,
    });
    const { data: doc } = await db
      .from("documents")
      .select("current_version_id, filename, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc) {
      console.log(`[edit-resolution] doc not found for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(doc, userId, userEmail, db);
    if (!accessResolved.ok) {
      console.log(`[edit-resolution] doc access denied for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const activeForResolved = await loadActiveVersion(documentId, db);
    const payload = {
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: doc.current_version_id ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(
            activeForResolved.storage_path,
            (doc.filename as string) ?? "document.docx",
          )
        : null,
      remaining_pending: 0,
    };
    console.log(
      `[edit-resolution] returning already-resolved payload`,
      payload,
    );
    return void res.status(200).json(payload);
  }

  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  console.log(`[edit-resolution] fetched doc`, { doc, docErr });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db);
  const latestPath = active?.storage_path ?? null;
  console.log(`[edit-resolution] resolved latestPath`, {
    latestPath,
    current_version_id: doc.current_version_id,
  });
  if (!latestPath)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath);
  console.log(`[edit-resolution] downloaded bytes`, {
    byteLength: raw?.byteLength ?? 0,
  });
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document bytes not available" });

  const wIds = [edit.del_w_id, edit.ins_w_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(raw),
    wIds,
    mode,
  );
  console.log(`[edit-resolution] resolveTrackedChange result`, {
    mode,
    change_id: edit.change_id,
    wIds,
    found,
    resolvedByteLength: resolvedBytes?.byteLength ?? 0,
  });
  if (!found) {
    console.log(
      `[edit-resolution] change_id not found in docx — updating status only`,
    );
    // Still update DB status so the UI reflects the decision — the change
    // may have been auto-consumed by a previous accept/reject pass.
    const { error: updErr } = await db
      .from("document_edits")
      .update({
        status: mode === "accept" ? "accepted" : "rejected",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", editId);
    console.log(`[edit-resolution] status-only update`, { updErr });
    const { data: filenameRow } = await db
      .from("documents")
      .select("filename")
      .eq("id", documentId)
      .single();
    const payload = {
      ok: true,
      version_id: doc.current_version_id,
      download_url: buildDownloadUrl(
        latestPath,
        (filenameRow?.filename as string) ?? "document.docx",
      ),
      remaining_pending: 0,
    };
    console.log(`[edit-resolution] returning not-found payload`, payload);
    return void res.status(200).json(payload);
  }

  // Overwrite bytes in place at the current version's storage path —
  // accept/reject mutates the existing version rather than spawning a
  // new row. This keeps document_versions lean (one row per assistant
  // edit, not one per accept/reject click) and avoids the N-versions-
  // per-doc churn as users resolve pending changes.
  const ab = resolvedBytes.buffer.slice(
    resolvedBytes.byteOffset,
    resolvedBytes.byteOffset + resolvedBytes.byteLength,
  ) as ArrayBuffer;
  console.log(`[edit-resolution] overwriting bytes in place`, {
    latestPath,
    byteLength: ab.byteLength,
  });
  await uploadFile(
    latestPath,
    ab,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  if (doc.current_version_id) {
    bumpDocumentVersionContentRevision(
      documentId,
      doc.current_version_id as string,
    );
    enqueueDocumentIndex(documentId, doc.current_version_id as string, {
      rerunIfActive: true,
    });
  }

  const { error: statusErr } = await db
    .from("document_edits")
    .update({
      status: mode === "accept" ? "accepted" : "rejected",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", editId);
  console.log(`[edit-resolution] updated document_edits status`, {
    editId,
    newStatus: mode === "accept" ? "accepted" : "rejected",
    statusErr,
  });

  const { count: remainingPending } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending");
  console.log(`[edit-resolution] remaining pending count`, {
    remainingPending,
  });

  const { data: filenameRow } = await db
    .from("documents")
    .select("filename")
    .eq("id", documentId)
    .single();
  const payload = {
    ok: true,
    version_id: doc.current_version_id,
    download_url: buildDownloadUrl(
      latestPath,
      (filenameRow?.filename as string) ?? "document.docx",
    ),
    remaining_pending: remainingPending ?? 0,
  };
  console.log(`[edit-resolution] returning success payload`, payload);
  res.json(payload);
}

documentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  async (req, res) => {
    try {
      await handleEditResolution(req, res, "accept");
    } catch (err) {
      console.error("[edits/accept] handler threw:", err);
      if (!res.headersSent) res.status(500).json({ detail: "Internal error" });
    }
  },
);

documentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  async (req, res) => {
    try {
      await handleEditResolution(req, res, "reject");
    } catch (err) {
      console.error("[edits/reject] handler threw:", err);
      if (!res.headersSent) res.status(500).json({ detail: "Internal error" });
    }
  },
);

async function handleDocumentUpload(
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
  const roleGuess = inferDocRole({ filename });
  const partyGuess = inferPartyRole({ filename });
  const briefSequence = inferBriefSequence({
    filename,
    docRole: roleGuess.role,
  });
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
      brief_sequence: briefSequence,
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
    const pageAwareBriefSequence = inferBriefSequence({
      filename,
      docRole: pageAwareRoleGuess.role,
    });

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

    // storage_path / pdf_storage_path live on document_versions now —
    // create the V1 "upload" row and point documents.current_version_id
    // at it.
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
        brief_sequence: pageAwareBriefSequence,
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
    // Surface storage paths to the caller for backward compatibility.
    const responseDoc = updated
      ? { ...updated, storage_path: key, pdf_storage_path: pdfStoragePath }
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
  _filename: string,
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
      if (outline?.length)
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
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
