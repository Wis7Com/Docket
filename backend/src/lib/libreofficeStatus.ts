/**
 * LibreOffice availability detection.
 *
 * The Windows installer bundles LibreOffice under
 * `<resources>/libreoffice/program/soffice.exe` so DOCX→PDF conversion works
 * out of the box; the bundled tree wins whenever it is present. macOS and
 * Linux builds bundle nothing, so there we look for a system install.
 *
 * Detection is file-existence only — we never run `soffice --version`.
 * Launching the binary just to read a version string is what used to pop
 * macOS quarantine/crash dialogs during automated runs, and it buys nothing:
 * the converter resolves a binary from the same paths we check here, so a hit
 * means conversion will work and a miss means it won't.
 */

import * as fs from "fs";
import * as path from "path";

interface Probe {
  available: boolean;
  version: string | null;
  path: string | null;
}

let cached: Probe | null = null;

/**
 * Version pinned by `scripts/fetch-libreoffice.js`. Keep in sync when
 * bumping LO_VERSION in that script — the bundled probe reports this
 * string verbatim rather than asking the binary.
 */
const BUNDLED_LO_VERSION = "25.8.6";

/**
 * System install locations, per platform. These mirror the paths
 * `libreoffice-convert` searches so detection can never claim an install the
 * converter would then fail to find. We also pin the converter to whatever we
 * resolve here (see convert.ts), which keeps the two in step even when a user
 * has LibreOffice somewhere unusual.
 */
const SYSTEM_INSTALL_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/LibreOffice.app/Contents/MacOS/soffice"],
  linux: [
    "/usr/bin/libreoffice",
    "/usr/bin/soffice",
    "/snap/bin/libreoffice",
    "/opt/libreoffice/program/soffice",
    "/usr/local/bin/soffice",
  ],
  win32: [
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  ],
};

function firstExistingFile(candidates: string[]): string | null {
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
  return firstExistingFile(candidates);
}

/** A user-installed LibreOffice, or null when none of the known paths exist. */
export function systemSofficePath(): string | null {
  return firstExistingFile(SYSTEM_INSTALL_PATHS[process.platform] ?? []);
}

/**
 * The binary conversion should use: bundled first, system install second.
 * `DOCKET_SKIP_LIBREOFFICE_PROBE=1` forces "not found" so smoke tests can
 * exercise the missing-LibreOffice path on a machine that has it installed.
 */
export function sofficePath(): string | null {
  if (process.env.DOCKET_SKIP_LIBREOFFICE_PROBE === "1") return null;
  return bundledSofficePath() ?? systemSofficePath();
}

/**
 * Best-effort version string, read from install metadata rather than by
 * running the binary. macOS keeps it in the app bundle's (XML) Info.plist;
 * elsewhere we have no cheap source and report null, which the UI renders as
 * a bare "Installed".
 */
function readSystemVersion(sofficeBinary: string): string | null {
  if (process.platform !== "darwin") return null;
  // …/LibreOffice.app/Contents/MacOS/soffice → …/Contents/Info.plist
  const plist = path.resolve(sofficeBinary, "..", "..", "Info.plist");
  try {
    const xml = fs.readFileSync(plist, "utf8");
    const match =
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
        xml,
      );
    return match ? `LibreOffice ${match[1].trim()}` : null;
  } catch {
    return null;
  }
}

export async function probeLibreOffice(): Promise<Probe> {
  if (cached) return cached;

  // Resolved through sofficePath() so Settings can never report an install
  // that conversion would decline to use, or vice versa.
  const found = sofficePath();
  if (!found) {
    cached = { available: false, version: null, path: null };
    return cached;
  }
  cached = {
    available: true,
    version:
      found === bundledSofficePath()
        ? `LibreOffice ${BUNDLED_LO_VERSION} (bundled)`
        : readSystemVersion(found),
    path: found,
  };
  return cached;
}

export function getCachedProbe(): Probe | null {
  return cached;
}

/**
 * Where to send a user whose LibreOffice is missing. On Windows there is
 * nowhere to send them — LibreOffice ships inside the installer, so a missing
 * binary means a damaged install rather than a missing download, and the
 * frontend says so instead of offering a link.
 */
export function libreOfficeInstallUrl(): string | null {
  return process.platform === "win32"
    ? null
    : "https://www.libreoffice.org/download/download-libreoffice/";
}
