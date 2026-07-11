import crypto from "crypto";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import type { NextFunction, Request, Response } from "express";
import {
  enterDatabaseContext,
  getAppDb,
  getDb,
  getDbForPath,
  openDatabaseWithRetry,
  projectDbPath,
  projectDataDir,
  runWithDatabaseContext,
  type DatabaseContext,
} from "../db/sqlite";
import { runMigrationsForDb } from "../db/migrate";

const MANIFEST_FILE = "project.json";
const legacyChatRepairAttempted = new Set<string>();

export interface ProjectRegistryRow {
  id: string;
  user_id: string;
  name: string;
  cm_number?: string | null;
  path: string;
  status?: string | null;
  last_opened_at?: string | null;
  created_at?: string;
  updated_at?: string;
  document_count_cache?: number | null;
  chat_count_cache?: number | null;
  review_count_cache?: number | null;
}

export interface ProjectRegistryCounts {
  document_count: number;
  chat_count: number;
  review_count: number;
}

interface ProjectManifest {
  id: string;
  name: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function manifestPath(projectPath: string): string {
  return path.join(projectDataDir(projectPath), MANIFEST_FILE);
}

function readManifest(projectPath: string): ProjectManifest | null {
  try {
    return JSON.parse(
      fs.readFileSync(manifestPath(projectPath), "utf8"),
    ) as ProjectManifest;
  } catch {
    return null;
  }
}

function writeManifest(projectPath: string, manifest: ProjectManifest): void {
  const dest = manifestPath(projectPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, dest);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return !!row;
}

function legacyRows(
  db: Database.Database,
  table: string,
  where = "",
  params: unknown[] = [],
): Row[] {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT * FROM ${table}${where}`).all(...params) as Row[];
}

function insertRows(db: Database.Database, table: string, rows: Row[]): void {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => "?").join(",");
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ${table} (${columns.map((c) => `"${c}"`).join(",")})
    VALUES (${placeholders})
  `);
  const txn = db.transaction((batch: Row[]) => {
    for (const row of batch) stmt.run(columns.map((col) => row[col]));
  });
  txn(rows);
}

export function resolveProjectFolder(folderPath: string): string {
  const resolved = path.resolve(folderPath);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error("Project path must be a directory");
  return fs.realpathSync(resolved);
}

const migratedDbPaths = new Set<string>();

export function ensureProjectDatabase(projectPath: string): string {
  const dbPath = projectDbPath(projectPath);
  if (!migratedDbPaths.has(dbPath)) {
    runMigrationsForDb(getDbForPath(dbPath));
    migratedDbPaths.add(dbPath);
  }
  return dbPath;
}

export function projectContextFor(
  row: Pick<ProjectRegistryRow, "id" | "path">,
): DatabaseContext {
  const projectPath = resolveProjectFolder(row.path);
  return {
    kind: "project",
    projectId: row.id,
    dataRoot: projectPath,
    dbPath: ensureProjectDatabase(projectPath),
  };
}

export function getRegisteredProject(
  projectId: string,
): ProjectRegistryRow | null {
  const row = getAppDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as ProjectRegistryRow | undefined;
  if (!row?.path) return null;
  return row;
}

export function getRegisteredProjectByPath(
  folderPath: string,
): ProjectRegistryRow | null {
  const projectPath = resolveProjectFolder(folderPath);
  const row = getAppDb()
    .prepare("SELECT * FROM projects WHERE path = ?")
    .get(projectPath) as ProjectRegistryRow | undefined;
  if (!row?.path) return null;
  return row;
}

export function unregisterProject(projectId: string): void {
  getAppDb().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
}

export function listRegisteredProjects(
  userId: string,
  userEmail?: string | null,
): ProjectRegistryRow[] {
  const rows = getAppDb()
    .prepare(
      "SELECT * FROM projects ORDER BY COALESCE(last_opened_at, created_at) DESC",
    )
    .all() as ProjectRegistryRow[];
  void userEmail;
  return rows.filter((row) => row.user_id === userId);
}

export function registerProjectFolder(args: {
  folderPath: string;
  userId: string;
  projectId?: string;
  name?: string;
  cmNumber?: string | null;
}): ProjectRegistryRow {
  const projectPath = resolveProjectFolder(args.folderPath);
  fs.mkdirSync(projectDataDir(projectPath), { recursive: true });
  const now = new Date().toISOString();
  const existingManifest = readManifest(projectPath);
  const existingByPath = getAppDb()
    .prepare("SELECT * FROM projects WHERE path = ?")
    .get(projectPath) as ProjectRegistryRow | undefined;

  const id =
    args.projectId ??
    existingManifest?.id ??
    existingByPath?.id ??
    crypto.randomUUID();
  const name =
    args.name?.trim() ||
    existingManifest?.name ||
    path.basename(projectPath) ||
    "Project";
  const manifest: ProjectManifest = {
    id,
    name,
    schemaVersion: 1,
    createdAt: existingManifest?.createdAt ?? now,
    updatedAt: now,
  };
  writeManifest(projectPath, manifest);
  ensureProjectDatabase(projectPath);

  getAppDb()
    .prepare(
      `
      INSERT INTO projects (
        id, user_id, name, cm_number, shared_with, path, status,
        last_opened_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        cm_number = excluded.cm_number,
        shared_with = excluded.shared_with,
        path = excluded.path,
        status = 'available',
        last_opened_at = excluded.last_opened_at,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      args.userId,
      name,
      args.cmNumber ?? existingByPath?.cm_number ?? null,
      "[]",
      projectPath,
      now,
      existingByPath?.created_at ?? now,
      now,
    );

  return (
    getRegisteredProject(id) ?? {
      id,
      user_id: args.userId,
      name,
      cm_number: args.cmNumber ?? null,
      path: projectPath,
      status: "available",
      last_opened_at: now,
    }
  );
}

function countRows(table: string, projectId: string): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`)
    .get(projectId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function refreshProjectRegistryCounts(
  row: Pick<ProjectRegistryRow, "id" | "path">,
): ProjectRegistryCounts {
  const ctx = projectContextFor(row);
  const counts = runWithDatabaseContext(ctx, () => ({
    document_count: countRows("documents", row.id),
    chat_count: countRows("chats", row.id),
    review_count: countRows("tabular_reviews", row.id),
  }));
  getAppDb()
    .prepare(
      `
      UPDATE projects
      SET document_count_cache = ?,
          chat_count_cache = ?,
          review_count_cache = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )
    .run(counts.document_count, counts.chat_count, counts.review_count, row.id);
  return counts;
}

export function ensureProjectRowInProjectDb(
  row: ProjectRegistryRow,
): DatabaseContext {
  const ctx = projectContextFor(row);
  runWithDatabaseContext(ctx, () => {
    const db = getDbForPath(ctx.dbPath);
    db.prepare(
      `
      INSERT INTO projects (id, user_id, name, cm_number, shared_with, path, status, last_opened_at)
      VALUES (?, ?, ?, ?, ?, ?, 'available', ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        cm_number = excluded.cm_number,
        shared_with = excluded.shared_with,
        path = excluded.path,
        status = 'available',
        last_opened_at = excluded.last_opened_at,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(
      row.id,
      row.user_id,
      row.name,
      row.cm_number ?? null,
      "[]",
      row.path,
      row.last_opened_at ?? new Date().toISOString(),
    );
  });
  return ctx;
}

function repairLegacyChatsForProject(
  row: ProjectRegistryRow,
  ctx: DatabaseContext,
): boolean {
  if (legacyChatRepairAttempted.has(row.id)) return false;
  legacyChatRepairAttempted.add(row.id);

  const legacyDbPath = path.join(projectDataDir(row.path), "mike.db");
  if (
    !fs.existsSync(legacyDbPath) ||
    path.resolve(legacyDbPath) === path.resolve(ctx.dbPath)
  ) {
    return false;
  }

  let legacyDb: Database.Database;
  try {
    legacyDb = openDatabaseWithRetry(
      legacyDbPath,
      (file) => new Database(file, { readonly: true, fileMustExist: true }),
      { attempts: 1, delayMs: 0 },
    );
  } catch (err) {
    console.warn(
      `[legacy-repair] unable to inspect legacy chat DB at ${legacyDbPath}: ${(err as Error).message}`,
    );
    return false;
  }
  try {
    const projectRows = legacyRows(legacyDb, "projects");
    const candidateProjectIds = new Set(
      projectRows
        .filter((project) => project.id === row.id || project.name === row.name)
        .map((project) => project.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    candidateProjectIds.add(row.id);

    const chats = legacyRows(legacyDb, "chats").filter((chat) => {
      const projectId = chat.project_id;
      return projectId === null || candidateProjectIds.has(String(projectId));
    });
    if (chats.length === 0) return false;

    const normalizedChats: Row[] = chats.map((chat) => ({
      ...chat,
      project_id: row.id,
      user_id:
        typeof chat.user_id === "string" && chat.user_id
          ? chat.user_id
          : row.user_id,
    }));
    const chatIds = normalizedChats
      .map((chat) => chat.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const projectDb = getDbForPath(ctx.dbPath);
    insertRows(projectDb, "chats", normalizedChats);
    if (chatIds.length > 0) {
      insertRows(
        projectDb,
        "chat_messages",
        legacyRows(
          legacyDb,
          "chat_messages",
          ` WHERE chat_id IN (${chatIds.map(() => "?").join(",")})`,
          chatIds,
        ),
      );
    }
    return true;
  } finally {
    legacyDb.close();
  }
}

// Entity-id routing: document/chat/review ids arrive without a projectId, so
// they must be resolved to the owning project DB. Scanning every registered
// project per request is slow and touches cloud-synced folders, so resolve
// once, cache the mapping, and probe candidate DBs read-only (no realpath,
// no migrations, no registry writes) during the scan.
type EntityKind = "document" | "chat";

const ENTITY_TABLE: Record<EntityKind, string> = {
  document: "documents",
  chat: "chats",
};

const ENTITY_PROJECT_CACHE_MAX = 5000;
const entityProjectCache = new Map<string, string>();

function readableProjectDbPath(
  row: Pick<ProjectRegistryRow, "path">,
): string | null {
  if (!row.path) return null;
  const dbPath = path.join(projectDataDir(row.path), "project.db");
  return fs.existsSync(dbPath) ? dbPath : null;
}

function assertProjectDbReadableOnce(
  row: Pick<ProjectRegistryRow, "path">,
): void {
  const dbPath = readableProjectDbPath(row);
  if (!dbPath) throw new Error("unable to open database file");

  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 100,
  });
  try {
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
  } finally {
    db.close();
  }
}

function projectDbHasEntity(
  dbPath: string,
  kind: EntityKind,
  entityId: string,
): boolean {
  let db: Database.Database | null = null;
  try {
    // Entity routing is a hot lookup path. Probe each candidate once and
    // read-only so an unavailable cloud-synced project cannot invoke the
    // managed database's long, synchronous open-retry loop and stall every
    // backend request.
    db = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: 100,
    });
    return !!db
      .prepare(`SELECT 1 FROM ${ENTITY_TABLE[kind]} WHERE id = ? LIMIT 1`)
      .get(entityId);
  } catch {
    // Unreadable or pre-migration project DBs cannot own this entity.
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // The one-shot probe may already have failed or closed.
    }
  }
}

function appDbHasEntity(kind: EntityKind, entityId: string): boolean {
  try {
    return !!getAppDb()
      .prepare(`SELECT 1 FROM ${ENTITY_TABLE[kind]} WHERE id = ? LIMIT 1`)
      .get(entityId);
  } catch {
    return false;
  }
}

function rememberEntityProject(
  kind: EntityKind,
  entityId: string,
  projectId: string,
): void {
  if (entityProjectCache.size >= ENTITY_PROJECT_CACHE_MAX) {
    entityProjectCache.clear();
  }
  entityProjectCache.set(`${kind}:${entityId}`, projectId);
}

export function findProjectRowForEntity(
  kind: EntityKind,
  entityId: string,
): ProjectRegistryRow | null {
  const cacheKey = `${kind}:${entityId}`;
  const cachedProjectId = entityProjectCache.get(cacheKey);
  if (cachedProjectId) {
    const row = getRegisteredProject(cachedProjectId);
    const dbPath = row ? readableProjectDbPath(row) : null;
    if (row && dbPath && projectDbHasEntity(dbPath, kind, entityId)) {
      return row;
    }
    entityProjectCache.delete(cacheKey);
  }

  const rows = getAppDb()
    .prepare(
      "SELECT * FROM projects ORDER BY COALESCE(last_opened_at, created_at) DESC",
    )
    .all() as ProjectRegistryRow[];
  for (const row of rows) {
    const dbPath = readableProjectDbPath(row);
    if (!dbPath) continue;
    if (projectDbHasEntity(dbPath, kind, entityId)) {
      rememberEntityProject(kind, entityId, row.id);
      return row;
    }
  }
  return null;
}

export function projectDbRequestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const projectId = req.params.projectId;
  if (!projectId || projectId === "open-folder") {
    next();
    return;
  }
  const row = getRegisteredProject(projectId);
  if (!row) {
    res.status(404).json({ detail: "Project not found" });
    return;
  }
  try {
    assertProjectDbReadableOnce(row);
    const ctx = ensureProjectRowInProjectDb(row);
    if (repairLegacyChatsForProject(row, ctx)) {
      refreshProjectRegistryCounts(row);
    }
    enterDatabaseContext(ctx);
    next();
  } catch (err) {
    sendProjectAccessFailure(res, err);
  }
}

export function documentDbRequestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const documentId = req.params.documentId;
  if (!documentId) {
    next();
    return;
  }

  const row = findProjectRowForEntity("document", documentId);
  if (row) {
    try {
      enterDatabaseContext(projectContextFor(row));
      next();
      return;
    } catch {
      // Ignore missing/unreadable projects; app-level routes can still handle
      // standalone documents if no project DB owns this document id.
    }
  }
  next();
}

export function chatDbRequestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const chatId = req.params.chatId;
  // `/chat/create` is a static route mounted behind `/chat/:chatId` at the
  // app level. It creates an app-DB chat and must not treat "create" as an
  // entity id or scan project databases before the handler runs.
  if (!chatId || chatId === "create") {
    next();
    return;
  }

  // Most newly created and legacy chats live in the app DB. Resolve that
  // ownership first; only scan project DBs when the app DB does not contain
  // the chat.
  if (appDbHasEntity("chat", chatId)) {
    next();
    return;
  }

  const row = findProjectRowForEntity("chat", chatId);
  if (row) {
    try {
      enterDatabaseContext(projectContextFor(row));
      next();
      return;
    } catch {
      // Fall back to app DB if no readable project owns this chat.
    }
  }
  next();
}

function sendProjectAccessFailure(res: Response, err: unknown): void {
  const message = (err as Error).message || "Project folder is not accessible";
  res.status(503).json({
    detail: `Project folder is registered but cannot be opened: ${message}`,
  });
}
