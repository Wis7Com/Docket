import { spawn, SpawnOptions, ChildProcess } from "child_process";

/**
 * A minimal allow-list env for child processes spawned by the backend. The
 * backend itself runs with sensitive secrets in its env (JWT_SECRET, all the
 * AI provider API keys, …). Anything we spawn — most notably the LibreOffice
 * `soffice` subprocess for DOC/DOCX→PDF rendition — has no business inheriting
 * those, and on Windows another unprivileged user-session process can read a
 * child's env block, so leaking is not theoretical.
 */
export function safeSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of [
    "PATH",
    "Path",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
  ]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export function safeSpawn(
  cmd: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(cmd, args, {
    ...options,
    env: { ...safeSpawnEnv(), ...(options.env ?? {}) },
  });
}
