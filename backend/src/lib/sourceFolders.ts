import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { createServerSupabase } from "./supabase";
import { docxToPdf } from "./convert";
import { enqueueDocumentIndex } from "./indexing/indexer";
import { linkedSourceKey, uploadFile } from "./storage";
import { isAllowedDocumentType } from "./documentTypes";

type Supa = ReturnType<typeof createServerSupabase>;

const MAX_LINKED_SOURCE_FILES = 5000;

export type LinkedSourceDocument = Record<string, unknown>;

export type SourceFolderScanResult = {
  imported: LinkedSourceDocument[];
  updated: LinkedSourceDocument[];
  unchanged: string[];
  missing: string[];
  skipped: string[];
  limit_reached: boolean;
};

type LinkedRow = {
  document_id: string;
  relative_path: string;
  size_bytes: number;
  mtime_ms: number;
};

export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  );
}

export function sourceFileType(filePath: string): string | null {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return isAllowedDocumentType(ext) ? ext : null;
}

export function resolveSourceFolderPath(folderPath: string): string {
  const stat = fs.statSync(folderPath);
  if (!stat.isDirectory()) throw new Error("path must be a directory");
  return fs.realpathSync(folderPath);
}

export function walkSourceFolder(root: string): string[] {
  const out: string[] = [];
  const skip = new Set([".git", ".docket", "node_modules"]);
  const realRoot = fs.realpathSync(root);
  const visit = (dir: string) => {
    if (out.length >= MAX_LINKED_SOURCE_FILES) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        sourceFileType(full)
      ) {
        out.push(full);
      }
      if (out.length >= MAX_LINKED_SOURCE_FILES) return;
    }
  };
  visit(root);
  return out;
}

async function nextVersionNumber(
  db: Supa,
  documentId: string,
): Promise<number> {
  const { data } = await db
    .from("document_versions")
    .select("version_number")
    .eq("document_id", documentId);
  const max = Math.max(
    0,
    ...((data ?? []) as { version_number?: number | null }[])
      .map((row) => row.version_number ?? 0)
      .filter((n) => Number.isFinite(n)),
  );
  return max + 1;
}

async function buildPdfRendition(args: {
  userId: string;
  documentId: string;
  relativePath: string;
  realFile: string;
  fileType: string;
  storageKey: string;
  versionNumber: number;
}): Promise<string | null> {
  if (args.fileType === "pdf") return args.storageKey;
  if (args.fileType !== "docx" && args.fileType !== "doc") return null;

  try {
    const buf = fs.readFileSync(args.realFile);
    const pdfBuf = await docxToPdf(buf);
    const pdfKey = `converted-pdfs/${args.userId}/${args.documentId}/source-v${args.versionNumber}.pdf`;
    await uploadFile(
      pdfKey,
      pdfBuf.buffer.slice(
        pdfBuf.byteOffset,
        pdfBuf.byteOffset + pdfBuf.byteLength,
      ) as ArrayBuffer,
      "application/pdf",
    );
    return pdfKey;
  } catch (err) {
    console.warn(
      `[source-folder] DOCX/DOC PDF rendition failed for ${args.relativePath}:`,
      err,
    );
    return null;
  }
}

async function createVersionForLinkedFile(args: {
  db: Supa;
  userId: string;
  documentId: string;
  sourceFolderId: string;
  relativePath: string;
  realFile: string;
  fileType: string;
  versionNumber: number;
  source: "upload" | "user_upload";
}): Promise<{
  versionId: string;
  storagePath: string;
  pdfStoragePath: string | null;
} | null> {
  const storagePath = linkedSourceKey(args.sourceFolderId, args.relativePath);
  const fileBytes = fs.readFileSync(args.realFile);
  const hash = crypto.createHash("sha256").update(fileBytes).digest("hex");
  const pdfStoragePath = await buildPdfRendition({
    userId: args.userId,
    documentId: args.documentId,
    relativePath: args.relativePath,
    realFile: args.realFile,
    fileType: args.fileType,
    storageKey: storagePath,
    versionNumber: args.versionNumber,
  });

  const { data: versionRow, error } = await args.db
    .from("document_versions")
    .insert({
      document_id: args.documentId,
      storage_path: storagePath,
      pdf_storage_path: pdfStoragePath,
      source: args.source,
      version_number: args.versionNumber,
      display_name: args.relativePath,
      original_path: args.realFile,
      imported_at: new Date().toISOString(),
      content_hash: hash,
    })
    .select("id")
    .single();
  if (error || !versionRow?.id) return null;
  return {
    versionId: versionRow.id as string,
    storagePath,
    pdfStoragePath,
  };
}

export type LinkedDocumentRescanResult =
  | { status: "not_linked" }
  | { status: "missing"; relative_path: string }
  | { status: "unchanged"; relative_path: string }
  | { status: "updated"; relative_path: string; version_id: string }
  | { status: "error"; detail: string };

// Single-document variant of scanSourceFolder: stat the linked source
// file and pick up a new version when it changed on disk (external PDF
// editors touch the file in place). Annotation re-import happens in the
// route on top of the resulting active version.
export async function rescanLinkedDocument(args: {
  db: Supa;
  userId: string;
  documentId: string;
}): Promise<LinkedDocumentRescanResult> {
  const { data: linked } = await args.db
    .from("linked_source_files")
    .select("source_folder_id, relative_path, size_bytes, mtime_ms")
    .eq("document_id", args.documentId)
    .maybeSingle();
  const linkedRow = linked as
    | (LinkedRow & { source_folder_id: string })
    | null;
  if (!linkedRow) return { status: "not_linked" };

  const { data: folder } = await args.db
    .from("source_folders")
    .select("id, root_path")
    .eq("id", linkedRow.source_folder_id)
    .single();
  const rootPath = (folder as { root_path?: string } | null)?.root_path;
  if (!rootPath) return { status: "error", detail: "Source folder not found" };

  let realFile: string;
  let stat: fs.Stats;
  try {
    const root = fs.realpathSync(rootPath);
    const candidate = path.resolve(root, linkedRow.relative_path);
    realFile = fs.realpathSync(candidate);
    if (!isInsideRoot(root, realFile)) {
      return { status: "error", detail: "Source file escapes folder" };
    }
    stat = fs.statSync(realFile);
  } catch {
    return { status: "missing", relative_path: linkedRow.relative_path };
  }

  const fileType = sourceFileType(realFile);
  if (!fileType) {
    return { status: "error", detail: "Unsupported file type" };
  }
  const mtimeMs = Math.round(stat.mtimeMs);
  if (linkedRow.size_bytes === stat.size && linkedRow.mtime_ms === mtimeMs) {
    return { status: "unchanged", relative_path: linkedRow.relative_path };
  }

  const versionNumber = await nextVersionNumber(args.db, args.documentId);
  const version = await createVersionForLinkedFile({
    db: args.db,
    userId: args.userId,
    documentId: args.documentId,
    sourceFolderId: linkedRow.source_folder_id,
    relativePath: linkedRow.relative_path,
    realFile,
    fileType,
    versionNumber,
    source: "user_upload",
  });
  if (!version) {
    return { status: "error", detail: "Failed to record new version" };
  }

  await args.db
    .from("linked_source_files")
    .update({
      size_bytes: stat.size,
      mtime_ms: mtimeMs,
      updated_at: new Date().toISOString(),
    })
    .eq("source_folder_id", linkedRow.source_folder_id)
    .eq("relative_path", linkedRow.relative_path);

  await args.db
    .from("documents")
    .update({
      current_version_id: version.versionId,
      size_bytes: stat.size,
      status: "ready",
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.documentId);
  enqueueDocumentIndex(args.documentId, version.versionId);

  return {
    status: "updated",
    relative_path: linkedRow.relative_path,
    version_id: version.versionId,
  };
}

export async function scanSourceFolder(args: {
  db: Supa;
  sourceFolderId: string;
  projectId: string;
  userId: string;
  rootPath: string;
}): Promise<SourceFolderScanResult> {
  const root = fs.realpathSync(args.rootPath);
  const files = walkSourceFolder(root);
  const result: SourceFolderScanResult = {
    imported: [],
    updated: [],
    unchanged: [],
    missing: [],
    skipped: [],
    limit_reached: files.length >= MAX_LINKED_SOURCE_FILES,
  };

  const { data: linkedRows } = await args.db
    .from("linked_source_files")
    .select("document_id, relative_path, size_bytes, mtime_ms")
    .eq("source_folder_id", args.sourceFolderId);
  const linkedByPath = new Map<string, LinkedRow>();
  for (const row of (linkedRows ?? []) as LinkedRow[]) {
    linkedByPath.set(row.relative_path, row);
  }

  const seen = new Set<string>();
  for (const fullPath of files) {
    let realFile: string;
    try {
      realFile = fs.realpathSync(fullPath);
    } catch {
      result.skipped.push(path.relative(root, fullPath));
      continue;
    }

    if (!isInsideRoot(root, realFile)) {
      result.skipped.push(path.relative(root, fullPath));
      continue;
    }

    const relativePath = path
      .relative(root, realFile)
      .split(path.sep)
      .join("/");
    seen.add(relativePath);

    const fileType = sourceFileType(realFile);
    if (!fileType) continue;
    const stat = fs.statSync(realFile);
    const mtimeMs = Math.round(stat.mtimeMs);
    const existing = linkedByPath.get(relativePath);
    if (
      existing &&
      existing.size_bytes === stat.size &&
      existing.mtime_ms === mtimeMs
    ) {
      result.unchanged.push(relativePath);
      continue;
    }

    if (existing) {
      const versionNumber = await nextVersionNumber(
        args.db,
        existing.document_id,
      );
      const version = await createVersionForLinkedFile({
        db: args.db,
        userId: args.userId,
        documentId: existing.document_id,
        sourceFolderId: args.sourceFolderId,
        relativePath,
        realFile,
        fileType,
        versionNumber,
        source: "user_upload",
      });
      if (!version) {
        result.skipped.push(relativePath);
        continue;
      }

      await args.db
        .from("linked_source_files")
        .update({
          size_bytes: stat.size,
          mtime_ms: mtimeMs,
          updated_at: new Date().toISOString(),
        })
        .eq("source_folder_id", args.sourceFolderId)
        .eq("relative_path", relativePath);

      const { data: updatedDoc } = await args.db
        .from("documents")
        .update({
          current_version_id: version.versionId,
          size_bytes: stat.size,
          status: "ready",
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.document_id)
        .select("*")
        .single();
      enqueueDocumentIndex(existing.document_id, version.versionId);
      if (updatedDoc) result.updated.push(updatedDoc);
      continue;
    }

    const { data: doc, error: docErr } = await args.db
      .from("documents")
      .insert({
        project_id: args.projectId,
        user_id: args.userId,
        filename: path.basename(realFile),
        file_type: fileType,
        size_bytes: stat.size,
        status: "processing",
      })
      .select("*")
      .single();
    if (docErr || !doc?.id) {
      result.skipped.push(relativePath);
      continue;
    }

    const version = await createVersionForLinkedFile({
      db: args.db,
      userId: args.userId,
      documentId: doc.id as string,
      sourceFolderId: args.sourceFolderId,
      relativePath,
      realFile,
      fileType,
      versionNumber: 1,
      source: "upload",
    });
    if (!version) {
      result.skipped.push(relativePath);
      continue;
    }

    await args.db.from("linked_source_files").insert({
      source_folder_id: args.sourceFolderId,
      document_id: doc.id,
      relative_path: relativePath,
      size_bytes: stat.size,
      mtime_ms: mtimeMs,
    });

    const { data: updatedDoc } = await args.db
      .from("documents")
      .update({
        current_version_id: version.versionId,
        size_bytes: stat.size,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", doc.id)
      .select("*")
      .single();
    enqueueDocumentIndex(doc.id as string, version.versionId);
    result.imported.push(updatedDoc ?? doc);
  }

  for (const relativePath of linkedByPath.keys()) {
    if (!seen.has(relativePath)) result.missing.push(relativePath);
  }

  await args.db
    .from("source_folders")
    .update({
      last_scanned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.sourceFolderId);

  return result;
}
