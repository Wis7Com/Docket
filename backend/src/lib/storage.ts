/**
 * Local-filesystem storage for the Docket desktop app.
 *
 * Files live under the current data context:
 *   - app mode: <APP_DATA_PATH>/files/<key>
 *   - project mode: <PROJECT>/.docket/files/<key>
 * Every read/write resolves the absolute path and rejects anything outside the
 * managed files root. The "signed URL" returned to the frontend is a
 * short-lived token URL that hits the `/files` route on the local backend.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getCurrentDatabaseContext, getDb, projectDataDir } from "../db/sqlite";
import { getServerPort } from "./serverPort";
import { resolveStoredSourceFolderPath } from "./sourceFolderPaths";

function filesRoot(): string {
  const ctx = getCurrentDatabaseContext();
  return ctx.kind === "project"
    ? path.join(projectDataDir(ctx.dataRoot), "files")
    : path.join(ctx.dataRoot, "files");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  );
}

/**
 * Resolve a storage key relative to the managed files root, rejecting anything
 * that escapes after path resolution. If the resolved path (or any prefix of
 * it) is a symlink/junction, follow it with realpath and re-check.
 *
 * NOTE: storage keys are server-generated only. Accepting client-supplied
 * keys would warrant a defence-in-depth review of every caller.
 */
function resolveSafe(key: string): string {
  const root = path.resolve(filesRoot());
  const candidate = path.resolve(root, key);
  if (!isInsideRoot(root, candidate)) {
      throw new Error(`Storage key escapes managed files root: ${key}`);
  }
  // realpath follows symlinks. We only have a real path if the file (or one
  // of its existing ancestors) exists; for newly-created keys, walk up until
  // we find an existing ancestor and check that.
  try {
    const realRoot = fs.realpathSync(root);
    let probe = candidate;
    // Walk up to the first existing ancestor.
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) {
      probe = path.dirname(probe);
    }
    if (fs.existsSync(probe)) {
      const realProbe = fs.realpathSync(probe);
      if (!isInsideRoot(realRoot, realProbe)) {
        throw new Error(`Storage key escapes managed files root via symlink: ${key}`);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // ancestor disappeared between checks — treat as safe (will fail later
      // with a clearer error from the actual fs op).
    } else {
      throw err;
    }
  }
  return candidate;
}

export const storageEnabled = true;

const LINKED_SOURCE_PREFIX = "linked-source:";

export function linkedSourceKey(
  sourceFolderId: string,
  relativePath: string,
): string {
  const cleanRelative = relativePath.split(path.sep).join("/");
  return `${LINKED_SOURCE_PREFIX}${sourceFolderId}:${encodeURIComponent(cleanRelative)}`;
}

function parseLinkedSourceKey(
  key: string,
): { sourceFolderId: string; relativePath: string } | null {
  if (!key.startsWith(LINKED_SOURCE_PREFIX)) return null;
  const rest = key.slice(LINKED_SOURCE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const sourceFolderId = rest.slice(0, sep);
  const relativePath = decodeURIComponent(rest.slice(sep + 1));
  if (!sourceFolderId || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Malformed linked source key");
  }
  return { sourceFolderId, relativePath };
}

function resolveLinkedSource(key: string): string | null {
  const parsed = parseLinkedSourceKey(key);
  if (!parsed) return null;
  const row = getDb()
    .prepare("SELECT root_path FROM source_folders WHERE id = ?")
    .get(parsed.sourceFolderId) as { root_path?: string } | undefined;
  if (!row?.root_path) throw new Error("Linked source folder not found");

  const root = resolveStoredSourceFolderPath(row.root_path);
  const candidate = path.resolve(root, parsed.relativePath);
  if (!isInsideRoot(root, candidate)) {
    throw new Error(`Linked source key escapes folder: ${key}`);
  }
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  if (!isInsideRoot(realRoot, realCandidate)) {
    throw new Error(`Linked source key escapes folder via symlink: ${key}`);
  }
  return realCandidate;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  _contentType: string,
): Promise<void> {
  const dest = resolveSafe(key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, Buffer.from(content));
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  try {
    const linked = resolveLinkedSource(key);
    if (linked) {
      const buf = await fs.promises.readFile(linked);
      return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
    }
    const src = resolveSafe(key);
    const buf = await fs.promises.readFile(src);
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
  if (key.startsWith(LINKED_SOURCE_PREFIX)) return;
  try {
    const target = resolveSafe(key);
    await fs.promises.unlink(target);
  } catch {
    // Missing file = already deleted; not an error.
  }
}

// ---------------------------------------------------------------------------
// Signed URL  → short-lived JWT-bearing URL to the local /files route
// ---------------------------------------------------------------------------

const FILE_TOKEN_TTL_SECONDS = 3600;

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getJwtSecret(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return Buffer.from(secret, "hex");
}

export function signFileToken(
  key: string,
  filename?: string,
  ttlSeconds = FILE_TOKEN_TTL_SECONDS,
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "FT" }));
  const now = Math.floor(Date.now() / 1000);
  const ctx = getCurrentDatabaseContext();
  const payload = b64url(
    JSON.stringify({
      key,
      fn: filename ?? null,
      ctx: {
        kind: ctx.kind,
        dbPath: ctx.dbPath,
        dataRoot: ctx.dataRoot,
        projectId: ctx.projectId ?? null,
      },
      iat: now,
      exp: now + ttlSeconds,
    }),
  );
  const signing = `${header}.${payload}`;
  const sig = crypto
    .createHmac("sha256", getJwtSecret())
    .update(signing)
    .digest();
  return `${signing}.${b64url(sig)}`;
}

export interface VerifiedFileToken {
  key: string;
  filename: string | null;
  context: ReturnType<typeof getCurrentDatabaseContext>;
}

export function verifyFileToken(token: string): VerifiedFileToken {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed file token");
  const [headerB64, payloadB64, sigB64] = parts;
  const expected = crypto
    .createHmac("sha256", getJwtSecret())
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const provided = Buffer.from(
    sigB64.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (sigB64.length % 4)) % 4),
    "base64",
  );
  if (
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    throw new Error("Invalid file token signature");
  }
  const payload = JSON.parse(
    Buffer.from(
      payloadB64.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (payloadB64.length % 4)) % 4),
      "base64",
    ).toString(),
  ) as { key: unknown; fn: unknown; exp: unknown; ctx?: unknown };
  // B3: payload shape validation. Reject anything that doesn't match what
  // signFileToken produces, even if the HMAC is correct.
  if (typeof payload.key !== "string" || payload.key.length === 0) {
    throw new Error("File token has invalid 'key' field");
  }
  if (payload.fn !== null && typeof payload.fn !== "string") {
    throw new Error("File token has invalid 'fn' field");
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("File token has invalid 'exp' field");
  }
  const rawCtx =
    typeof payload.ctx === "object" && payload.ctx !== null
      ? (payload.ctx as Record<string, unknown>)
      : null;
  const context = rawCtx
    ? {
        kind: rawCtx.kind === "project" ? "project" as const : "app" as const,
        dbPath:
          typeof rawCtx.dbPath === "string"
            ? rawCtx.dbPath
            : getCurrentDatabaseContext().dbPath,
        dataRoot:
          typeof rawCtx.dataRoot === "string"
            ? rawCtx.dataRoot
            : getCurrentDatabaseContext().dataRoot,
        projectId:
          typeof rawCtx.projectId === "string" ? rawCtx.projectId : undefined,
      }
    : getCurrentDatabaseContext();
  if (payload.exp * 1000 < Date.now()) throw new Error("File token expired");
  return { key: payload.key, filename: payload.fn, context };
}

export async function getSignedUrl(
  key: string,
  expiresIn = FILE_TOKEN_TTL_SECONDS,
  downloadFilename?: string,
): Promise<string | null> {
  try {
    const token = signFileToken(key, downloadFilename, expiresIn);
    // Use the actual listening port (set by index.ts after app.listen
    // resolves the OS-assigned port from PORT=0). Reading process.env.PORT
    // here would yield "0" and produce broken URLs.
    // 127.0.0.1 not "localhost" — on Windows, "localhost" can resolve to
    // ::1 (IPv6) first while the backend binds 127.0.0.1 only.
    return `http://127.0.0.1:${getServerPort()}/files?t=${encodeURIComponent(token)}`;
  } catch {
    return null;
  }
}

/**
 * True if the bytes plausibly contain a PDF. The `%PDF-` header must appear
 * within the first 1024 bytes (the spec allows leading junk before it).
 * Guards against mislabeled files — e.g. an HTML error page saved with a
 * .pdf extension — being served as application/pdf.
 */
export function looksLikePdf(content: ArrayBuffer): boolean {
  return Buffer.from(content.slice(0, 1024)).includes("%PDF-");
}

export function resolveStoragePath(key: string): string {
  return resolveLinkedSource(key) ?? resolveSafe(key);
}

export function streamableExists(key: string): boolean {
  try {
    return fs.statSync(resolveStoragePath(key)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers (unchanged from the R2 version — same key shapes)
// ---------------------------------------------------------------------------

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name)
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

function safeStorageSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label} for storage key`);
  }
  return value;
}

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${safeStorageSegment(userId, "user id")}/${safeStorageSegment(docId, "document id")}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${safeStorageSegment(userId, "user id")}/${safeStorageSegment(docId, "document id")}/${safeStorageSegment(stem, "PDF stem")}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${safeStorageSegment(userId, "user id")}/${safeStorageSegment(docId, "document id")}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${safeStorageSegment(userId, "user id")}/${safeStorageSegment(docId, "document id")}/versions/${safeStorageSegment(versionSlug, "version slug")}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}
