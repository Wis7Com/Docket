/**
 * LibreOffice availability detection.
 *
 * The desktop installer bundles LibreOffice under
 * `<resources>/libreoffice/program/soffice.exe` on Windows so DOCX→PDF
 * conversion works out of the box. We still probe at startup — if the
 * bundled tree is missing or corrupted, the frontend can surface that
 * clearly instead of failing silently. System installs (PATH, Program
 * Files) are tried as fallbacks for non-Windows dev environments.
 */

import * as fs from "fs";
import * as path from "path";
import { safeSpawn } from "./safeSpawn";

interface Probe {
  available: boolean;
  version: string | null;
  path: string | null;
}

let cached: Probe | null = null;
let inflight: Promise<Probe> | null = null;

/**
 * Version pinned by `scripts/fetch-libreoffice.js`. Keep in sync when
 * bumping LO_VERSION in that script — the bundled probe reports this
 * string verbatim instead of running soffice --version (see notes on
 * bundledSofficePath).
 */
const BUNDLED_LO_VERSION = "25.8.6";

const WIN_INSTALL_PATHS = [
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
];

const NIX_INSTALL_PATHS = [
  "/usr/bin/soffice",
  "/usr/local/bin/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/snap/bin/libreoffice",
];

function existingInstall(): string | null {
  const candidates = process.platform === "win32"
    ? WIN_INSTALL_PATHS
    : NIX_INSTALL_PATHS;
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // not present
    }
  }
  return null;
}

/**
 * Resolve the bundled soffice path shipped via electron-builder
 * `extraResources`. On Windows this is the canonical location used by
 * both packaged installs (process.resourcesPath) and dev runs
 * (vendor/libreoffice/ at repo root). Returns null on platforms where
 * we don't bundle (macOS/Linux).
 *
 * Note on Windows binaries: LibreOffice ships both `soffice.exe`
 * (GUI-subsystem) and `soffice.com` (console-subsystem) in the same
 * directory. We point at `.exe` because libreoffice-convert uses
 * `child_process.execFile` (no shell) to run conversions, and `.com`
 * hangs when spawned that way. For headless conversion the GUI
 * binary is fine — output goes to a file, stdout doesn't matter.
 * Probes intentionally do NOT run `--version` on the bundled binary
 * (soffice.exe produces no stdout when piped); see probeLibreOffice.
 */
export function bundledSofficePath(): string | null {
  if (process.platform !== "win32") return null;
  // Packaged Electron sets process.resourcesPath to the app's
  // resources/ folder. In plain Node (backend dev / tests) that path
  // points at the Node distribution and won't contain our tree, so
  // fall through to the repo-root vendor copy.
  const candidates: string[] = [];
  // Electron sets process.resourcesPath; plain Node doesn't, so it's
  // not in NodeJS.Process types. Read defensively.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    candidates.push(
      path.join(resourcesPath, "libreoffice", "program", "soffice.exe"),
    );
  }
  // Dev fallback: walk up from this file (backend/{src,dist}/lib) to
  // the repo root and look for vendor/libreoffice/.
  // backend/src/lib → backend/src → backend → repoRoot.
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  candidates.push(
    path.join(repoRoot, "vendor", "libreoffice", "program", "soffice.exe"),
  );
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // not present
    }
  }
  return null;
}

async function runProbe(executable: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let resolved = false;
    const finish = (v: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };
    try {
      const proc = safeSpawn(executable, ["--version"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
      proc.on("error", () => finish(null));
      proc.on("exit", (code) => {
        if (code === 0 && stdout.trim()) finish(stdout.trim());
        else finish(null);
      });
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        finish(null);
      }, 3000);
    } catch {
      finish(null);
    }
  });
}

export async function probeLibreOffice(): Promise<Probe> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    if (process.env.DOCKET_SKIP_LIBREOFFICE_PROBE === "1") {
      const result: Probe = { available: false, version: null, path: null };
      cached = result;
      return result;
    }

    // Bundled binary takes precedence. We trust file existence and
    // skip `--version` because `soffice.exe` is GUI-subsystem on
    // Windows and produces no stdout when its handles are pipes.
    // bundledSofficePath() already verified the file is on disk.
    const bundled = bundledSofficePath();
    if (bundled) {
      const result: Probe = {
        available: true,
        version: `LibreOffice ${BUNDLED_LO_VERSION} (bundled)`,
        path: bundled,
      };
      cached = result;
      return result;
    }

    // macOS/Linux system probes can launch a GUI-gated soffice binary and
    // show OS crash/quarantine dialogs during automated desktop smoke tests.
    // Keep Windows bundled detection automatic; require an explicit opt-in
    // before probing system LibreOffice on non-Windows developer machines.
    if (
      process.platform !== "win32" &&
      process.env.DOCKET_ENABLE_SYSTEM_LIBREOFFICE_PROBE !== "1"
    ) {
      const result: Probe = { available: false, version: null, path: null };
      cached = result;
      return result;
    }

    // Non-bundled fallback (dev on macOS/Linux, or Windows without
    // the vendor tree): try PATH then known install dirs.
    const candidates: string[] = ["soffice"];
    const installed = existingInstall();
    if (installed) candidates.push(installed);

    for (const c of candidates) {
      const version = await runProbe(c);
      if (version) {
        const result: Probe = {
          available: true,
          version: version.split(/\r?\n/)[0],
          path: c === "soffice" ? null : c,
        };
        cached = result;
        return result;
      }
    }
    const result: Probe = { available: false, version: null, path: null };
    cached = result;
    return result;
  })();

  return inflight;
}

export function getCachedProbe(): Probe | null {
  return cached;
}

/**
 * LibreOffice ships bundled inside Docket, so there is no external
 * download URL. Kept exported as `null` for API stability — the
 * frontend treats null as "no install link, surface a generic error".
 */
export const LIBREOFFICE_DOWNLOAD_URL: string | null = null;
