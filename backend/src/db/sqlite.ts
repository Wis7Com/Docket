import Database from "better-sqlite3";
import { AsyncLocalStorage } from "async_hooks";
import * as fs from "fs";
import * as path from "path";

export interface DatabaseContext {
  kind: "app" | "project";
  dbPath: string;
  dataRoot: string;
  projectId?: string;
}

let appDb: Database.Database | null = null;
const dbByPath = new Map<string, Database.Database>();
const dbContext = new AsyncLocalStorage<DatabaseContext>();

export interface RetryOptions {
  attempts: number;
  delayMs: number;
}

type DatabaseOpener = (file: string) => Database.Database;

export const DB_OPEN_RETRY: RetryOptions = {
  attempts: 20,
  delayMs: 500,
};

// Project databases may live in cloud-synced folders. Request handlers must
// fail fast when one is unavailable instead of synchronously sleeping on the
// Node event loop for the app database's startup retry budget.
export const PROJECT_DB_OPEN_RETRY: RetryOptions = {
  attempts: 1,
  delayMs: 0,
};

function sqliteErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isTransientSqliteOpenError(err: unknown): boolean {
  const code = sqliteErrorCode(err);
  return code === "SQLITE_CANTOPEN" || (code?.startsWith("SQLITE_IOERR") ?? false);
}

function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function hydrateExistingSqliteFile(file: string): void {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return;
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // SQLite will surface the real open error below. This preflight is only to
    // nudge cloud/on-demand files into a locally readable state before opening.
  }
}

const PROJECT_DATA_DIR = ".docket";
/** Data-dir name used by the app before the Mike → Docket rebrand. */
const LEGACY_PROJECT_DATA_DIR = ".mike";

/**
 * Prefer `dir`, but if only the pre-rebrand `legacy` dir exists, rename it in
 * place once. Falls back to `legacy` when the rename fails (e.g. the dir is
 * held open by another process) so existing data keeps working.
 */
function migrateLegacyDir(dir: string, legacy: string): string {
  if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, dir);
    } catch {
      return legacy;
    }
  }
  return dir;
}

/** Managed data dir under `root` (`<root>/.docket`), migrating a legacy `.mike` dir. */
export function resolveDataDir(root: string): string {
  return migrateLegacyDir(
    path.join(root, PROJECT_DATA_DIR),
    path.join(root, LEGACY_PROJECT_DATA_DIR),
  );
}

export function appDataPath(): string {
  const appPath = process.env.APP_DATA_PATH;
  if (appPath) return path.resolve(appPath);

  // Backward compatibility for old local tests/dev scripts that launched the
  // backend with the pre-project WORKSPACE_PATH only.
  const ws = process.env.WORKSPACE_PATH;
  if (ws) return resolveDataDir(path.resolve(ws));

  return migrateLegacyDir(
    path.resolve(process.cwd(), ".docket-app"),
    path.resolve(process.cwd(), ".mike-app"),
  );
}

export function appDbPath(): string {
  fs.mkdirSync(appDataPath(), { recursive: true });
  return path.join(appDataPath(), "app.db");
}

export function projectDataDir(projectPath: string): string {
  return resolveDataDir(path.resolve(projectPath));
}

export function projectDbPath(projectPath: string): string {
  const dir = projectDataDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "project.db");
}

function configureManagedDb(
  db: Database.Database,
  kind: DatabaseContext["kind"],
  file: string,
): void {
  if (kind === "app") {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  } else {
    try {
      db.pragma("journal_mode = DELETE");
    } catch (err) {
      console.warn(
        `[sqlite] unable to switch project database to DELETE journal at ${file}: ${(err as Error).message}`,
      );
    }
  }
  db.pragma("foreign_keys = ON");
}

function openManagedDb(
  file: string,
  kind: DatabaseContext["kind"] = "project",
): Database.Database {
  const resolved = path.resolve(file);
  const existing = dbByPath.get(resolved);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = openDatabaseWithRetry(
    resolved,
    undefined,
    kind === "project" ? PROJECT_DB_OPEN_RETRY : DB_OPEN_RETRY,
  );
  configureManagedDb(db, kind, resolved);
  dbByPath.set(resolved, db);
  return db;
}

export function openDatabaseWithRetry(
  file: string,
  openDb: DatabaseOpener = (dbFile) => new Database(dbFile),
  opts: RetryOptions = DB_OPEN_RETRY,
): Database.Database {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      hydrateExistingSqliteFile(file);
      return openDb(file);
    } catch (err) {
      if (!isTransientSqliteOpenError(err) || attempt === opts.attempts) {
        throw err;
      }
      lastErr = err;
      console.warn(
        `[sqlite] unable to open database at ${file}; retrying (${attempt}/${opts.attempts})`,
      );
      sleepSync(opts.delayMs);
    }
  }

  throw lastErr;
}

export function getDb(): Database.Database {
  const ctx = dbContext.getStore();
  if (ctx) return openManagedDb(ctx.dbPath, ctx.kind);
  return getAppDb();
}

export function getAppDb(): Database.Database {
  if (appDb) return appDb;
  appDb = openManagedDb(appDbPath(), "app");
  return appDb;
}

export function getDbForPath(file: string): Database.Database {
  return openManagedDb(file, "project");
}

export function getCurrentDatabaseContext(): DatabaseContext {
  const ctx = dbContext.getStore();
  if (ctx) return ctx;
  return {
    kind: "app",
    dbPath: appDbPath(),
    dataRoot: appDataPath(),
  };
}

export function runWithDatabaseContext<T>(
  ctx: DatabaseContext,
  fn: () => T,
): T {
  return dbContext.run(
    {
      ...ctx,
      dbPath: path.resolve(ctx.dbPath),
      dataRoot: path.resolve(ctx.dataRoot),
    },
    fn,
  );
}

export function enterDatabaseContext(ctx: DatabaseContext): void {
  dbContext.enterWith({
    ...ctx,
    dbPath: path.resolve(ctx.dbPath),
    dataRoot: path.resolve(ctx.dataRoot),
  });
}

export function closeDb(): void {
  if (appDb) {
    appDb.close();
    appDb = null;
  }
  for (const db of dbByPath.values()) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  dbByPath.clear();
}
