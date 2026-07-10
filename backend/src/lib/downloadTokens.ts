import crypto from "crypto";
import {
    getCurrentDatabaseContext,
    type DatabaseContext,
} from "../db/sqlite";

/**
 * HMAC-signed, expiring download tokens.
 *
 * The token encodes the local storage path, filename, and database context.
 * `/download/:token` validates the signature, restores the context, and
 * streams the file without R2 CORS headaches.
 */

const DOWNLOAD_TOKEN_TTL_SECONDS = 24 * 60 * 60;

function getSecret(): string {
    const secret = process.env.DOWNLOAD_SIGNING_SECRET;
    if (!secret) {
        throw new Error("DOWNLOAD_SIGNING_SECRET is not configured");
    }
    return secret;
}

function b64urlEncode(buf: Buffer): string {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return Buffer.from(t, "base64");
}

function timingSafeEqStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export type VerifiedDownload = {
    path: string;
    filename: string;
    context: DatabaseContext;
};

export function signDownload(
    path: string,
    filename: string,
    ttlSeconds = DOWNLOAD_TOKEN_TTL_SECONDS,
): string {
    const now = Math.floor(Date.now() / 1000);
    const ctx = getCurrentDatabaseContext();
    const payload = JSON.stringify({
        p: path,
        f: filename,
        ctx: {
            kind: ctx.kind,
            dbPath: ctx.dbPath,
            dataRoot: ctx.dataRoot,
            projectId: ctx.projectId ?? null,
        },
        iat: now,
        exp: now + ttlSeconds,
    });
    const enc = b64urlEncode(Buffer.from(payload, "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyDownload(token: string): VerifiedDownload | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    if (!timingSafeEqStr(sigEnc, b64urlEncode(expected))) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            p: string;
            f: string;
            exp?: unknown;
            ctx?: unknown;
        };
        if (!parsed?.p || !parsed?.f) return null;
        if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) {
            return null;
        }
        if (parsed.exp * 1000 < Date.now()) return null;
        const rawCtx =
            typeof parsed.ctx === "object" && parsed.ctx !== null
                ? (parsed.ctx as Record<string, unknown>)
                : null;
        if (!rawCtx) return null;
        const context: DatabaseContext = {
            kind: rawCtx.kind === "project" ? "project" : "app",
            dbPath:
                typeof rawCtx.dbPath === "string"
                    ? rawCtx.dbPath
                    : getCurrentDatabaseContext().dbPath,
            dataRoot:
                typeof rawCtx.dataRoot === "string"
                    ? rawCtx.dataRoot
                    : getCurrentDatabaseContext().dataRoot,
            projectId:
                typeof rawCtx.projectId === "string"
                    ? rawCtx.projectId
                    : undefined,
        };
        return { path: parsed.p, filename: parsed.f, context };
    } catch {
        return null;
    }
}

/**
 * Returns a relative download URL (e.g. "/download/abc.def"). The frontend
 * prefixes it with NEXT_PUBLIC_API_BASE_URL when rendering `<a href=…>`.
 */
export function buildDownloadUrl(path: string, filename: string): string {
    return `/download/${signDownload(path, filename)}`;
}
