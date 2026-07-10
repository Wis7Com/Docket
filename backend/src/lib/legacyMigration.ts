import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import {
  getDbForPath,
  openDatabaseWithRetry,
  projectDataDir,
  projectDbPath,
  resolveDataDir,
  runWithDatabaseContext,
} from "../db/sqlite";
import { runMigrationsForDb } from "../db/migrate";
import {
  ensureProjectRowInProjectDb,
  projectContextFor,
  registerProjectFolder,
  type ProjectRegistryRow,
} from "./projectRegistry";

const MIGRATION_MARKER = "legacy-workspace-migration.json";

type Row = Record<string, unknown>;

const PROJECT_TABLES = [
  "project_subfolders",
  "documents",
  "source_folders",
  "chats",
  "tabular_reviews",
];

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return !!row;
}

function allRows(db: Database.Database, table: string, where = "", params: unknown[] = []): Row[] {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT * FROM ${table}${where}`).all(...params) as Row[];
}

function insertRows(db: Database.Database, table: string, rows: Row[]): void {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => "?").join(",");
  const sql = `
    INSERT OR REPLACE INTO ${table} (${columns.map((c) => `"${c}"`).join(",")})
    VALUES (${placeholders})
  `;
  const stmt = db.prepare(sql);
  const txn = db.transaction((batch: Row[]) => {
    for (const row of batch) stmt.run(columns.map((col) => row[col]));
  });
  txn(rows);
}

function resolveLegacySourcePath(legacyWorkspace: string, storedPath: string): string {
  if (storedPath.startsWith("workspace:")) {
    const rel = storedPath.slice("workspace:".length) || ".";
    return fs.realpathSync(path.resolve(legacyWorkspace, rel));
  }
  if (storedPath.startsWith("project:")) {
    const rel = storedPath.slice("project:".length) || ".";
    return fs.realpathSync(path.resolve(legacyWorkspace, rel));
  }
  return fs.realpathSync(storedPath);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function portableProjectPath(projectRoot: string, folderPath: string): string {
  const realRoot = fs.realpathSync(projectRoot);
  const realFolder = fs.realpathSync(folderPath);
  if (!isInsideRoot(realRoot, realFolder)) return realFolder;
  const rel = path.relative(realRoot, realFolder).split(path.sep).join("/") || ".";
  return `project:${rel}`;
}

function uniqueFolder(parent: string, name: string): string {
  let candidate = path.join(parent, name);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${name} (${n})`);
    n += 1;
  }
  return candidate;
}

function copyFolderContents(srcRoot: string, destRoot: string): void {
  const skip = new Set([".git", ".mike", ".docket", "node_modules"]);
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const src = path.join(dir, entry.name);
      const rel = path.relative(srcRoot, src);
      const dest = path.join(destRoot, rel);
      if (entry.isDirectory()) {
        visit(src);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const realSrc = fs.realpathSync(src);
        if (!isInsideRoot(srcRoot, realSrc)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(realSrc, dest);
      }
    }
  };
  fs.mkdirSync(destRoot, { recursive: true });
  visit(srcRoot);
}

function projectRootFor(legacyDb: Database.Database, legacyWorkspace: string, projectId: string): string {
  const source = allRows(
    legacyDb,
    "source_folders",
    " WHERE project_id = ? ORDER BY created_at ASC LIMIT 1",
    [projectId],
  )[0];
  if (typeof source?.root_path === "string") {
    return resolveLegacySourcePath(legacyWorkspace, source.root_path);
  }
  return path.join(legacyWorkspace, String(projectId));
}

function copyStorageFile(legacyWorkspace: string, projectRoot: string, key: unknown): void {
  if (typeof key !== "string" || !key || key.startsWith("linked-source:")) return;
  const src = path.join(legacyWorkspace, "files", key);
  if (!fs.existsSync(src)) return;
  const dest = path.join(projectDataDir(projectRoot), "files", key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function markerPath(appDataPath: string): string {
  return path.join(resolveDataDir(appDataPath), MIGRATION_MARKER);
}

export function migrateLegacyWorkspaceIfNeeded(args: {
  legacyWorkspacePath?: string | null;
  appDataPath: string;
  userId: string;
}): void {
  if (!args.legacyWorkspacePath) return;
  const legacyWorkspace = path.resolve(args.legacyWorkspacePath);
  const legacyDbPath = path.join(legacyWorkspace, ".mike", "mike.db");
  if (!fs.existsSync(legacyDbPath)) return;
  if (fs.existsSync(markerPath(args.appDataPath))) return;

  const legacyDb = openDatabaseWithRetry(
    legacyDbPath,
    (file) => new Database(file, { readonly: true, fileMustExist: true }),
  );
  try {
    const projects = allRows(legacyDb, "projects");
    for (const project of projects) {
      if (typeof project.id !== "string") continue;
      const projectRoot = projectRootFor(legacyDb, legacyWorkspace, project.id);
      fs.mkdirSync(projectRoot, { recursive: true });
      const registryRow = registerProjectFolder({
        folderPath: projectRoot,
        userId: typeof project.user_id === "string" ? project.user_id : args.userId,
        projectId: project.id,
        name: typeof project.name === "string" ? project.name : path.basename(projectRoot),
        cmNumber: typeof project.cm_number === "string" ? project.cm_number : null,
        sharedWith: typeof project.shared_with === "string"
          ? JSON.parse(project.shared_with) as string[]
          : Array.isArray(project.shared_with)
            ? project.shared_with as string[]
            : [],
      });
      ensureProjectRowInProjectDb(registryRow);
      const ctx = projectContextFor(registryRow as ProjectRegistryRow);
      runWithDatabaseContext(ctx, () => {
        const projectDb = getDbForPath(projectDbPath(projectRoot));
        runMigrationsForDb(projectDb);
        insertRows(projectDb, "projects", [{ ...project, path: projectRoot, status: "available" }]);

        for (const table of PROJECT_TABLES) {
          const rows = allRows(legacyDb, table, " WHERE project_id = ?", [project.id]);
          if (table === "source_folders") {
            for (const row of rows) {
              if (typeof row.root_path !== "string") continue;
              const sourceRoot = resolveLegacySourcePath(legacyWorkspace, row.root_path);
              if (isInsideRoot(projectRoot, sourceRoot)) {
                row.root_path = portableProjectPath(projectRoot, sourceRoot);
              } else {
                const importedRoot = uniqueFolder(projectRoot, path.basename(sourceRoot));
                copyFolderContents(sourceRoot, importedRoot);
                row.root_path = portableProjectPath(projectRoot, importedRoot);
              }
            }
          }
          insertRows(projectDb, table, rows);
        }

        const docs = allRows(legacyDb, "documents", " WHERE project_id = ?", [project.id]);
        const docIds = docs.map((row) => row.id).filter((id): id is string => typeof id === "string");
        if (docIds.length > 0) {
          const marks = docIds.map(() => "?").join(",");
          insertRows(projectDb, "document_versions", allRows(legacyDb, "document_versions", ` WHERE document_id IN (${marks})`, docIds));
          insertRows(projectDb, "document_edits", allRows(legacyDb, "document_edits", ` WHERE document_id IN (${marks})`, docIds));
          insertRows(projectDb, "linked_source_files", allRows(legacyDb, "linked_source_files", ` WHERE document_id IN (${marks})`, docIds));
          insertRows(projectDb, "document_index_files", allRows(legacyDb, "document_index_files", ` WHERE document_id IN (${marks})`, docIds));
          insertRows(projectDb, "document_index_chunks", allRows(legacyDb, "document_index_chunks", ` WHERE document_id IN (${marks})`, docIds));
          insertRows(projectDb, "document_index_chunks_fts", allRows(legacyDb, "document_index_chunks_fts", ` WHERE document_id IN (${marks})`, docIds));
          insertRows(projectDb, "document_index_chunks_fts_trigram", allRows(legacyDb, "document_index_chunks_fts_trigram", ` WHERE document_id IN (${marks})`, docIds));
        }

        const chunks = allRows(projectDb, "document_index_chunks").map((row) => row.id).filter((id): id is string => typeof id === "string");
        if (chunks.length > 0) {
          insertRows(projectDb, "document_index_vectors", allRows(legacyDb, "document_index_vectors", ` WHERE chunk_id IN (${chunks.map(() => "?").join(",")})`, chunks));
        }

        const chats = allRows(legacyDb, "chats", " WHERE project_id = ?", [project.id]);
        const chatIds = chats.map((row) => row.id).filter((id): id is string => typeof id === "string");
        if (chatIds.length > 0) {
          insertRows(projectDb, "chat_messages", allRows(legacyDb, "chat_messages", ` WHERE chat_id IN (${chatIds.map(() => "?").join(",")})`, chatIds));
        }

        const reviews = allRows(legacyDb, "tabular_reviews", " WHERE project_id = ?", [project.id]);
        const reviewIds = reviews.map((row) => row.id).filter((id): id is string => typeof id === "string");
        if (reviewIds.length > 0) {
          insertRows(projectDb, "tabular_cells", allRows(legacyDb, "tabular_cells", ` WHERE review_id IN (${reviewIds.map(() => "?").join(",")})`, reviewIds));
          insertRows(projectDb, "tabular_review_chats", allRows(legacyDb, "tabular_review_chats", ` WHERE review_id IN (${reviewIds.map(() => "?").join(",")})`, reviewIds));
        }
        const reviewChats = allRows(projectDb, "tabular_review_chats").map((row) => row.id).filter((id): id is string => typeof id === "string");
        if (reviewChats.length > 0) {
          insertRows(projectDb, "tabular_review_chat_messages", allRows(legacyDb, "tabular_review_chat_messages", ` WHERE chat_id IN (${reviewChats.map(() => "?").join(",")})`, reviewChats));
        }

        insertRows(projectDb, "workflows", allRows(legacyDb, "workflows"));
        for (const version of allRows(projectDb, "document_versions")) {
          copyStorageFile(legacyWorkspace, projectRoot, version.storage_path);
          copyStorageFile(legacyWorkspace, projectRoot, version.pdf_storage_path);
        }
      });
    }

    fs.mkdirSync(path.dirname(markerPath(args.appDataPath)), { recursive: true });
    fs.writeFileSync(
      markerPath(args.appDataPath),
      JSON.stringify({ migratedAt: new Date().toISOString(), legacyWorkspace }, null, 2),
    );
  } finally {
    legacyDb.close();
  }
}
