import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

interface DesktopConfig {
  legacyWorkspacePath?: string;
  projectFolderBookmarks?: Record<string, string>;
  /**
   * Old config key from the workspace-era desktop flow. Keep reading it so
   * existing installs can migrate their old all-in-one folder once.
   */
  lastWorkspace?: string;
}

const CONFIG_FILE = "config.json";
const DOCKET_DIR = ".docket";
/** Data-dir name used by the app before the Mike → Docket rebrand. */
const LEGACY_DOCKET_DIR = ".mike";

/**
 * Resolve the managed data dir under `root`, renaming a pre-rebrand `.mike`
 * dir in place the first time we see one. Falls back to the legacy dir if the
 * rename fails (e.g. the dir is locked by another process) so existing data
 * keeps working.
 */
export function resolveDataDir(root: string): string {
  const dir = path.join(root, DOCKET_DIR);
  const legacy = path.join(root, LEGACY_DOCKET_DIR);
  if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, dir);
    } catch {
      return legacy;
    }
  }
  return dir;
}

/**
 * Move the whole userData dir from a pre-rebrand app name ("Mike") to the
 * current one ("Docket"). Only runs when the new location is missing or
 * empty, so it can never clobber real data.
 */
export function migrateLegacyUserDataDir(legacyAppNames: string[]): void {
  const userData = app.getPath("userData");
  try {
    if (fs.existsSync(userData) && fs.readdirSync(userData).length > 0) return;
  } catch {
    return;
  }
  for (const name of legacyAppNames) {
    const candidate = path.join(path.dirname(userData), name);
    if (candidate === userData || !isDirectoryUsable(candidate)) continue;
    try {
      fs.rmdirSync(userData); // only succeeds when empty — that's the point
    } catch {
      // dir may simply not exist yet
    }
    try {
      fs.renameSync(candidate, userData);
    } catch (err) {
      console.warn(
        `[appData] failed to migrate legacy user data from ${candidate}:`,
        err,
      );
    }
    return;
  }
}

function configPath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILE);
}

export function readConfig(): DesktopConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    return JSON.parse(raw) as DesktopConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: DesktopConfig): void {
  atomicWriteFileSync(configPath(), JSON.stringify(config, null, 2));
}

export function isDirectoryUsable(dir: string | undefined): boolean {
  if (!dir) return false;
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function ensureAppDataLayout(appDataPath: string): string {
  const docketDir = resolveDataDir(appDataPath);
  fs.mkdirSync(docketDir, { recursive: true });
  fs.mkdirSync(path.join(appDataPath, "files"), { recursive: true });
  return docketDir;
}

export function secretsFilePath(appDataPath: string): string {
  return path.join(resolveDataDir(appDataPath), "secrets.enc");
}

export function runtimeFilePath(appDataPath: string): string {
  return path.join(resolveDataDir(appDataPath), "runtime.json");
}

/**
 * Atomic write — writes to a temp file then renames over the destination.
 * Avoids leaving a half-written file if power loss / crash interrupts.
 */
export function atomicWriteFileSync(
  dest: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(tmp, data, { mode: opts.mode });
  fs.renameSync(tmp, dest);
}
