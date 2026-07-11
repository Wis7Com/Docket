import * as path from "path";
import * as fs from "fs";
import type { createServerSupabase } from "./supabase";
import { resolveSourceFolderPath, scanSourceFolder } from "./sourceFolders";
import { toStoredSourceFolderPath } from "./sourceFolderPaths";
import {
  ensureProjectRowInProjectDb,
  registerProjectFolder,
  refreshProjectRegistryCounts,
} from "./projectRegistry";
import { getCurrentDatabaseContext, runWithDatabaseContext } from "../db/sqlite";
import { isAllowedDocumentType } from "./documentTypes";

type Supa = ReturnType<typeof createServerSupabase>;

const IMPORT_SKIP = new Set([".git", ".docket", "node_modules"]);

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function uniquePath(parent: string, name: string): string {
  const parsed = path.parse(name);
  let candidate = path.join(parent, name);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${parsed.name} (${n})${parsed.ext}`);
    n += 1;
  }
  return candidate;
}

function copySupportedFilesIntoProject(args: {
  sourceRoot: string;
  projectRoot: string;
}): string {
  const destRoot = uniquePath(args.projectRoot, path.basename(args.sourceRoot));
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || IMPORT_SKIP.has(entry.name)) continue;
      const src = path.join(dir, entry.name);
      const rel = path.relative(args.sourceRoot, src);
      const dest = path.join(destRoot, rel);
      if (entry.isDirectory()) {
        visit(src);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (!isAllowedDocumentType(ext)) continue;
        const realSrc = fs.realpathSync(src);
        if (!isInsideRoot(args.sourceRoot, realSrc)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(realSrc, dest);
      }
    }
  };
  fs.mkdirSync(destRoot, { recursive: true });
  visit(args.sourceRoot);
  return destRoot;
}

export async function addSourceFolderToProject(args: {
  db: Supa;
  projectId: string;
  userId: string;
  folderPath: string;
}): Promise<{
  sourceFolder: Record<string, unknown>;
  scan: Awaited<ReturnType<typeof scanSourceFolder>>;
  root: string;
}> {
  const requestedRoot = resolveSourceFolderPath(args.folderPath);
  const ctx = getCurrentDatabaseContext();
  const projectRoot = ctx.kind === "project" ? fs.realpathSync(ctx.dataRoot) : null;
  const root =
    projectRoot && !isInsideRoot(projectRoot, requestedRoot)
      ? copySupportedFilesIntoProject({
          sourceRoot: requestedRoot,
          projectRoot,
        })
      : requestedRoot;
  const storedRoot = toStoredSourceFolderPath(root);
  const { data: sourceFolder, error: folderErr } = await args.db
    .from("source_folders")
    .insert({
      project_id: args.projectId,
      user_id: args.userId,
      root_path: storedRoot,
      display_name: path.basename(root),
      last_scanned_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (folderErr || !sourceFolder) {
    throw new Error(folderErr?.message ?? "Failed to open project folder");
  }

  const scan = await scanSourceFolder({
    db: args.db,
    sourceFolderId: sourceFolder.id as string,
    projectId: args.projectId,
    userId: args.userId,
    rootPath: root,
  });

  return { sourceFolder, scan, root };
}

export async function createProjectFromFolder(args: {
  db: Supa;
  userId: string;
  folderPath: string;
}): Promise<{
  project: Record<string, unknown>;
  sourceFolder: Record<string, unknown>;
  scan: Awaited<ReturnType<typeof scanSourceFolder>>;
}> {
  void args.db;
  const root = resolveSourceFolderPath(args.folderPath);
  const registryProject = registerProjectFolder({
    folderPath: root,
    userId: args.userId,
  });
  const ctx = ensureProjectRowInProjectDb(registryProject);

  return await runWithDatabaseContext(ctx, async () => {
    const { createServerSupabase } = await import("./supabase");
    const projectDb = createServerSupabase();
    const { sourceFolder, scan } = await addSourceFolderToProject({
      db: projectDb,
      projectId: registryProject.id,
      userId: args.userId,
      folderPath: root,
    });
    refreshProjectRegistryCounts(registryProject);
    return {
      project: registryProject as unknown as Record<string, unknown>,
      sourceFolder,
      scan,
    };
  });
}
