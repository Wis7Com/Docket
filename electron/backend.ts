import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { backendDir as resolveBackendDir } from "./paths";
import { runtimeFilePath } from "./appData";
import { setLogRedactions } from "./logging";

const BACKEND_FRONTEND_URL =
  process.env.DOCKET_FRONTEND_URL ?? "http://localhost:3000";

interface SpawnOptions {
  appDataPath: string;
  activeProjectPath?: string | null;
  legacyWorkspacePath?: string | null;
  jwtSecret: string;
  sessionToken?: string | null;
  downloadSecret: string;
  userId: string;
  userEmail: string;
  apiKeys: Record<string, string | undefined>;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

let backendProc: ChildProcess | null = null;
let backendPort: number | null = null;
let backendAppDataPath: string | null = null;
let lastExitInfo: ExitInfo | null = null;

export function isBackendRunning(): boolean {
  return (
    backendProc !== null && !backendProc.killed && backendProc.exitCode === null
  );
}

export function spawnBackend(opts: SpawnOptions): void {
  if (isBackendRunning()) return;
  lastExitInfo = null;
  backendPort = null;
  backendAppDataPath = opts.appDataPath;

  // C1: redact secrets from log file
  setLogRedactions([
    opts.jwtSecret,
    opts.sessionToken,
    opts.downloadSecret,
    ...Object.values(opts.apiKeys),
  ]);

  // Clear any stale runtime.json before the new backend writes its assigned
  // port — otherwise waitForBackend could read the previous run's port.
  try {
    fs.unlinkSync(runtimeFilePath(opts.appDataPath));
  } catch {
    // not present — fine
  }

  const isDev = process.env.NODE_ENV === "development";
  const backendDir = resolveBackendDir();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "0", // C3: OS picks an available port
    FRONTEND_URL: BACKEND_FRONTEND_URL,
    JWT_SECRET: opts.jwtSecret,
    DOWNLOAD_SIGNING_SECRET: opts.downloadSecret,
    APP_DATA_PATH: opts.appDataPath,
    ACTIVE_PROJECT_PATH: opts.activeProjectPath ?? "",
    LEGACY_WORKSPACE_PATH: opts.legacyWorkspacePath ?? "",
    LOCAL_USER_ID: opts.userId,
    LOCAL_USER_EMAIL: opts.userEmail,
  };
  for (const [k, v] of Object.entries(opts.apiKeys)) {
    if (v) env[k] = v;
  }

  let cmd: string;
  let args: string[];
  let useShell = false;
  if (isDev) {
    const tsxBin =
      process.platform === "win32"
        ? path.join(backendDir, "node_modules", ".bin", "tsx.cmd")
        : path.join(backendDir, "node_modules", ".bin", "tsx");
    const nodeBin = findCompatibleDevNode(backendDir);
    cmd = nodeBin ?? tsxBin;
    args = nodeBin ? [tsxBin, "watch", "src/index.ts"] : ["watch", "src/index.ts"];
    // Win32 .cmd shims require shell:true to invoke. All args here are
    // static literals, so no user input can flow into the shell. Cmd.exe
    // /c with the path passed as an arg breaks the dev spawn silently —
    // the child exits before stdout is even wired, leaving no log trail.
    useShell = process.platform === "win32" && !nodeBin;
  } else {
    env.ELECTRON_RUN_AS_NODE = "1";
    cmd = process.execPath;
    args = [path.join(backendDir, "dist", "index.js")];
  }

  console.log(
    `[backend] spawning: ${cmd} ${args.join(" ")} (cwd=${backendDir})`,
  );
  const proc = spawn(cmd, args, {
    cwd: backendDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: useShell,
  });
  backendProc = proc;
  proc.on("error", (err) => {
    console.error(`[backend] spawn error:`, err);
  });

  proc.stdout?.on("data", (b: Buffer) => {
    const s = b.toString();
    process.stdout.write(`[backend] ${s}`);
    console.log(`[backend.stdout] ${s.replace(/\n+$/, "")}`);
  });
  proc.stderr?.on("data", (b: Buffer) => {
    const s = b.toString();
    process.stderr.write(`[backend] ${s}`);
    console.error(`[backend.stderr] ${s.replace(/\n+$/, "")}`);
  });
  proc.on("exit", (code, signal) => {
    console.log(`[backend] exited code=${code} signal=${signal}`);
    if (backendProc !== proc) return;
    lastExitInfo = { code, signal };
    backendProc = null;
  });
}

function findCompatibleDevNode(backendDir: string): string | null {
  const requestedMajor = readRequestedNodeMajor(path.dirname(backendDir));
  const candidates = [
    process.env.DOCKET_BACKEND_NODE,
    requestedMajor
      ? `/opt/homebrew/opt/node@${requestedMajor}/bin/node`
      : undefined,
    requestedMajor
      ? `/usr/local/opt/node@${requestedMajor}/bin/node`
      : undefined,
    "node",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      [
        "-p",
        "JSON.stringify({ execPath: process.execPath, major: Number(process.versions.node.split('.')[0]), abi: process.versions.modules })",
      ],
      { encoding: "utf8" },
    );
    if (probe.status !== 0 || !probe.stdout) continue;
    try {
      const parsed = JSON.parse(probe.stdout.trim()) as {
        execPath?: string;
        major?: number;
        abi?: string;
      };
      const major = Number(parsed.major);
      if (major >= 20 && major < 25) {
        const execPath = parsed.execPath || candidate;
        console.log(
          `[backend] using Node ${major} ABI ${parsed.abi ?? "unknown"} for dev backend (${execPath})`,
        );
        return execPath;
      }
    } catch {
      // Try the next candidate.
    }
  }

  console.warn(
    "[backend] no compatible Node 20-24 executable found; falling back to tsx shim",
  );
  return null;
}

function readRequestedNodeMajor(rootDir: string): number | null {
  for (const fileName of [".node-version", ".nvmrc"]) {
    try {
      const raw = fs.readFileSync(path.join(rootDir, fileName), "utf8").trim();
      const major = Number.parseInt(raw, 10);
      if (Number.isFinite(major)) return major;
    } catch {
      // Try the next version file.
    }
  }
  return null;
}

export function stopBackend(): void {
  if (backendProc && !backendProc.killed) {
    backendProc.kill();
  }
  backendProc = null;
  backendPort = null;
  backendAppDataPath = null;
  setLogRedactions([]);
}

export async function stopBackendAndWait(timeoutMs = 5_000): Promise<void> {
  const proc = backendProc;
  stopBackend();
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function readRuntimeFile(): { port?: number } | null {
  if (!backendAppDataPath) return null;
  try {
    const raw = fs.readFileSync(runtimeFilePath(backendAppDataPath), "utf8");
    return JSON.parse(raw) as { port?: number };
  } catch {
    return null;
  }
}

/**
 * Wait until the backend has written its runtime.json (containing the
 * dynamically-assigned port) AND responds on /health. Returns false on
 * timeout or if the backend has already exited.
 */
export async function waitForBackend(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lastExitInfo) return false; // backend died — give up immediately

    if (backendPort === null) {
      const rt = readRuntimeFile();
      if (rt?.port) backendPort = rt.port;
    }
    if (backendPort !== null) {
      try {
        const resp = await fetch(`http://localhost:${backendPort}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (resp.ok) return true;
      } catch {
        // not ready yet
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export function getBackendPort(): number {
  // Renderer asks for this via window.docket.getApiPort. The port is only known
  // once the backend has written its runtime file; guessing a legacy default
  // like 3001 risks handing the session token to whatever unrelated local app
  // happens to own that port, so an unknown port is an error instead.
  const rt = readRuntimeFile();
  if (rt?.port) {
    backendPort = rt.port;
    return rt.port;
  }
  if (backendPort !== null) return backendPort;
  throw new Error(
    "Backend port is not available yet: runtime file missing and backend not started",
  );
}

export function getBackendExitInfo(): ExitInfo | null {
  return lastExitInfo;
}
