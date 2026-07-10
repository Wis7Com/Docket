import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

/**
 * Root directory under which `backend/` and `frontend/` live.
 *
 * In dev: the repo root (since dist-electron/main.js sits next to backend/
 * and frontend/ on disk).
 * In production: `process.resourcesPath`, because we copy backend/ and
 * frontend/.next/standalone/ via electron-builder's `extraResources` —
 * outside the asar archive, on real disk where Node's spawn() can use them
 * as cwd and where module resolution works without asar overlay games.
 */
export function appResources(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.resolve(__dirname, "..");
}

/**
 * Backend directory containing dist/, node_modules/, migrations/.
 */
export function backendDir(): string {
  return path.join(appResources(), "backend");
}

/**
 * Resolves the Next.js standalone server entry. In monorepo-shaped projects
 * Next.js may relocate it from `.next/standalone/server.js` to
 * `.next/standalone/<package>/server.js` to preserve the trace-root path —
 * try both locations.
 */
export function frontendServerEntry(): { serverJs: string; serverDir: string } | null {
  const standalone = path.join(
    appResources(),
    "frontend",
    ".next",
    "standalone",
  );
  const candidates = [
    path.join(standalone, "server.js"),
    path.join(standalone, "frontend", "server.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return { serverJs: c, serverDir: path.dirname(c) };
    }
  }
  return null;
}
