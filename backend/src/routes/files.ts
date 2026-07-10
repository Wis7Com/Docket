import { Router } from "express";
import * as fs from "fs";
import * as path from "path";
import {
  verifyFileToken,
  resolveStoragePath,
  buildContentDisposition,
  streamableExists,
} from "../lib/storage";
import { runWithDatabaseContext } from "../db/sqlite";

export const filesRouter = Router();

const EXT_CONTENT_TYPE: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXT_CONTENT_TYPE[ext] ?? "application/octet-stream";
}

function parseRange(
  header: string,
  total: number,
): { start: number; end: number } | null {
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  let start: number;
  let end: number;
  if (startStr === "" && endStr === "") return null;
  if (startStr === "") {
    // suffix: last N bytes
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? total - 1 : Number(endStr);
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= total
  ) {
    return null;
  }
  if (end >= total) end = total - 1;
  return { start, end };
}

// GET /files?t=<token>
//
// Pre-signed-URL replacement. The token bakes in the storage key + intended
// download filename. Auth-header–free so the URL can be used in <a href>
// or <iframe src>. Token TTL is short (1h) to limit replay.
filesRouter.get("/", (req, res) => {
  const token = req.query.t;
  if (typeof token !== "string" || !token) {
    return void res.status(400).json({ detail: "Missing token" });
  }
  let claim;
  try {
    claim = verifyFileToken(token);
  } catch (err) {
    return void res
      .status(401)
      .json({ detail: (err as Error).message || "Invalid token" });
  }
  const abs = runWithDatabaseContext(claim.context, () => {
    if (!streamableExists(claim.key)) return null;
    return resolveStoragePath(claim.key);
  });
  if (!abs) return void res.status(404).json({ detail: "File not found" });
  const filename = claim.filename ?? claim.key.split("/").pop() ?? "download";

  // A4: this route is consumed by the renderer or as an <a href>/<iframe src>
  // from inside the renderer — same-origin always. These headers stop browsers
  // on other sites from cross-origin-loading the response if a token leaks.
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentTypeFor(filename));
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition("inline", filename),
  );

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return void res.status(404).json({ detail: "File not found" });
  }
  const total = stat.size;

  const rangeHeader = req.headers["range"];
  let start = 0;
  let end = total - 1;
  if (typeof rangeHeader === "string") {
    const parsed = parseRange(rangeHeader, total);
    if (parsed) {
      start = parsed.start;
      end = parsed.end;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    } else {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${total}`);
      return void res.end();
    }
  }
  res.setHeader("Content-Length", String(end - start + 1));

  const stream = fs.createReadStream(abs, { start, end });
  stream.on("error", (err) => {
    console.error("[files] stream error:", err);
    res.destroy(err);
  });
  stream.pipe(res);
});
