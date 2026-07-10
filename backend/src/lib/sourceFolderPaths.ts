import * as fs from "fs";
import * as path from "path";
import { getCurrentDatabaseContext } from "../db/sqlite";

export const LEGACY_WORKSPACE_SOURCE_PREFIX = "workspace:";
export const PROJECT_SOURCE_PREFIX = "project:";

function sourceRootPath(): string {
  const ctx = getCurrentDatabaseContext();
  return ctx.dataRoot;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  );
}

function toPortableRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export function toStoredSourceFolderPath(realFolderPath: string): string {
  const realProject = fs.realpathSync(sourceRootPath());
  const realFolder = fs.realpathSync(realFolderPath);
  if (!isInsideRoot(realProject, realFolder)) return realFolder;

  const relative = toPortableRelativePath(
    path.relative(realProject, realFolder),
  );
  return `${PROJECT_SOURCE_PREFIX}${relative || "."}`;
}

export function resolveStoredSourceFolderPath(storedPath: string): string {
  const isProjectRelative = storedPath.startsWith(PROJECT_SOURCE_PREFIX);
  const isLegacyWorkspaceRelative = storedPath.startsWith(
    LEGACY_WORKSPACE_SOURCE_PREFIX,
  );
  if (!isProjectRelative && !isLegacyWorkspaceRelative) {
    return fs.realpathSync(storedPath);
  }

  const prefix = isProjectRelative
    ? PROJECT_SOURCE_PREFIX
    : LEGACY_WORKSPACE_SOURCE_PREFIX;
  const relative = storedPath.slice(prefix.length) || ".";
  if (path.isAbsolute(relative)) {
    throw new Error("Project-relative source folder path must be relative");
  }

  const realProject = fs.realpathSync(sourceRootPath());
  const candidate = path.resolve(realProject, relative);
  if (!isInsideRoot(realProject, candidate)) {
    throw new Error("Project-relative source folder path escapes project");
  }

  const realCandidate = fs.realpathSync(candidate);
  if (!isInsideRoot(realProject, realCandidate)) {
    throw new Error(
      "Project-relative source folder path escapes project via symlink",
    );
  }
  return realCandidate;
}

export function displaySourceFolderPath(storedPath: string): string {
  const isProjectRelative = storedPath.startsWith(PROJECT_SOURCE_PREFIX);
  const isLegacyWorkspaceRelative = storedPath.startsWith(
    LEGACY_WORKSPACE_SOURCE_PREFIX,
  );
  if (!isProjectRelative && !isLegacyWorkspaceRelative) return storedPath;
  const prefix = isProjectRelative
    ? PROJECT_SOURCE_PREFIX
    : LEGACY_WORKSPACE_SOURCE_PREFIX;
  const relative = storedPath.slice(prefix.length) || ".";
  return relative === "." ? "." : `./${relative}`;
}
