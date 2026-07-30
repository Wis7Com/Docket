import * as path from "path";
import type { createServerSupabase } from "./supabase";
import { resolveSourceFolderPath, scanSourceFolder } from "./sourceFolders";
import {
  resolveStoredSourceFolderPath,
  toStoredSourceFolderPath,
} from "./sourceFolderPaths";
import {
  ensureProjectRowInProjectDb,
  getRegisteredProjectByPath,
  registerProjectFolder,
  refreshProjectRegistryCounts,
  unregisterProject,
} from "./projectRegistry";
import { runWithDatabaseContext } from "../db/sqlite";

type Supa = ReturnType<typeof createServerSupabase>;

// Only ever called with a project's own root folder — a project *is* its
// folder, so there is no import-from-elsewhere path to handle here.
async function addSourceFolderToProject(args: {
  db: Supa;
  projectId: string;
  userId: string;
  folderPath: string;
}): Promise<{
  sourceFolder: Record<string, unknown>;
  scan: Awaited<ReturnType<typeof scanSourceFolder>>;
  root: string;
}> {
  const root = resolveSourceFolderPath(args.folderPath);
  const storedRoot = toStoredSourceFolderPath(root);
  const { data: existingFolders, error: existingErr } = await args.db
    .from("source_folders")
    .select("*")
    .eq("project_id", args.projectId);
  if (existingErr) throw new Error(existingErr.message);

  const existing = (existingFolders ?? []).find((folder) => {
    if (folder.root_path === storedRoot) return true;
    try {
      return (
        resolveSourceFolderPath(
          resolveStoredSourceFolderPath(folder.root_path as string),
        ) === root
      );
    } catch {
      return false;
    }
  });

  const normalizedExisting =
    existing && existing.root_path !== storedRoot
      ? await args.db
          .from("source_folders")
          .update({
            root_path: storedRoot,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id as string)
          .select("*")
          .single()
      : null;

  const inserted = normalizedExisting
    ? normalizedExisting
    : existing
      ? { data: existing, error: null }
      : await args.db
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
  const { data: sourceFolder, error: folderErr } = inserted;
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
  const existedBefore = getRegisteredProjectByPath(root) !== null;
  const registryProject = registerProjectFolder({
    folderPath: root,
    userId: args.userId,
  });

  try {
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
  } catch (err) {
    if (!existedBefore) unregisterProject(registryProject.id);
    throw err;
  }
}
