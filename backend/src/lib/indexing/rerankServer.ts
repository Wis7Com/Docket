/**
 * On-demand `llama-server --rerank` sidecar.
 *
 * The reranker is a 0.6B GGUF model served by llama.cpp. Nothing in the app
 * needs it until a search asks for reranking, and a legal user may not search
 * for hours, so the backend spawns the server lazily on the first request and
 * stops it after an idle period instead of keeping ~1–2 GB of GPU memory
 * resident. One instance per backend process; concurrent first requests share
 * the same start-up promise.
 *
 * Failure policy: a failed start is retried on the next request. After three
 * consecutive failures the sidecar is disabled for the rest of the session so
 * a broken install cannot add a 30 s stall to every search. Callers always
 * fall back to the hybrid ranking when this module returns null.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { appDataPath } from "../../db/sqlite";

export const DEFAULT_RERANK_MODEL_FILENAME = "qwen3-reranker-0.6b-q8_0.gguf";
export const DEFAULT_RERANK_IDLE_SECONDS = 600;
export const RERANK_STARTUP_TIMEOUT_MS = 30_000;
export const RERANK_MAX_CONSECUTIVE_FAILURES = 3;
const HEALTH_POLL_INTERVAL_MS = 250;
const STDERR_TAIL_LINES = 20;
const PID_FILE_NAME = "rerank-server.json";

const LLAMA_SERVER_FALLBACK_PATHS = [
  "/opt/homebrew/bin/llama-server",
  "/usr/local/bin/llama-server",
];

export type RerankServerStatus =
  | "running"
  | "starting"
  | "stopped"
  | "disabled";

export type RerankServerHandle = { baseUrl: string };

export type EnsureRerankServerOptions = {
  binaryPath: string;
  modelPath: string;
  idleSeconds?: number;
};

export type RerankServerState = {
  status: RerankServerStatus;
  baseUrl: string | null;
  pid: number | null;
  consecutiveFailures: number;
  lastError: string | null;
};

type SpawnedProcess = Pick<
  ChildProcess,
  "pid" | "kill" | "on" | "once" | "stderr" | "exitCode"
>;

type ManagerDeps = {
  spawn: (binary: string, args: string[]) => SpawnedProcess;
  fetch: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<{ ok: boolean; status: number }>;
  pickFreePort: () => Promise<number>;
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout) => void;
  now: () => number;
  log: (message: string) => void;
  warn: (message: string) => void;
  pidFilePath: (() => string | null) | null;
  installExitHooks: boolean;
  startupTimeoutMs: number;
  healthPollIntervalMs: number;
};

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isReadableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Configured path, then PATH, then the Homebrew / local prefixes. The packaged
 * Electron app inherits a minimal PATH on macOS, so the explicit prefixes are
 * what makes a `brew install llama.cpp` discoverable in production.
 */
export function findLlamaServerBinary(
  configured?: string | null,
): string | null {
  const explicit = configured?.trim();
  if (explicit) {
    const resolved = expandHome(explicit);
    return isExecutableFile(resolved) ? resolved : null;
  }
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = path.join(dir, "llama-server");
    if (isExecutableFile(candidate)) return candidate;
  }
  for (const candidate of LLAMA_SERVER_FALLBACK_PATHS) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function defaultRerankModelCandidates(): string[] {
  const candidates = [
    path.join(appDataPath(), "models", DEFAULT_RERANK_MODEL_FILENAME),
  ];
  if (process.platform === "darwin") {
    candidates.push(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "docket-desktop",
        "models",
        DEFAULT_RERANK_MODEL_FILENAME,
      ),
    );
  }
  return Array.from(new Set(candidates));
}

/** Returns the model file to use, or null when no readable GGUF exists. */
export function resolveRerankModelPath(
  configured?: string | null,
): string | null {
  const explicit = configured?.trim();
  if (explicit) {
    const resolved = expandHome(explicit);
    return isReadableFile(resolved) ? resolved : null;
  }
  for (const candidate of defaultRerankModelCandidates()) {
    if (isReadableFile(candidate)) return candidate;
  }
  return null;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close();
        reject(new Error("could not read the assigned port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function defaultPidFilePath(): string | null {
  try {
    return path.join(appDataPath(), ".docket", PID_FILE_NAME);
  } catch {
    return null;
  }
}

const defaultDeps: ManagerDeps = {
  spawn: (binary, args) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    // Neither the child handle nor its stderr pipe may keep the event loop
    // alive: a CLI script that used the reranker must be able to exit, and the
    // exit hook then stops the sidecar.
    child.unref();
    (child.stderr as { unref?: () => void } | null)?.unref?.();
    return child;
  },
  fetch: (url, init) => fetch(url, init),
  pickFreePort,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  now: () => Date.now(),
  log: (message) => console.log(`[rerank] ${message}`),
  warn: (message) => console.warn(`[rerank] ${message}`),
  pidFilePath: defaultPidFilePath,
  installExitHooks: true,
  startupTimeoutMs: RERANK_STARTUP_TIMEOUT_MS,
  healthPollIntervalMs: HEALTH_POLL_INTERVAL_MS,
};

export function llamaServerArgs(modelPath: string, port: number): string[] {
  return [
    "-m",
    modelPath,
    "--rerank",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "-c",
    "32768",
    "-np",
    "8",
    "-b",
    "8192",
    "-ub",
    "8192",
    "-ngl",
    "99",
    "-fa",
    "on",
  ];
}

export type RerankServerManager = {
  ensure: (
    options: EnsureRerankServerOptions,
  ) => Promise<RerankServerHandle | null>;
  markUsed: () => void;
  /** Hold the sidecar open for an in-flight request (pair with endRequest). */
  beginRequest: () => void;
  endRequest: () => void;
  stop: (reason: string) => void;
  getState: () => RerankServerState;
  isDisabled: () => boolean;
};

type Running = {
  child: SpawnedProcess;
  baseUrl: string;
  pid: number | null;
  modelPath: string;
  idleMs: number;
};

export function createRerankServerManager(
  overrides: Partial<ManagerDeps> = {},
): RerankServerManager {
  const deps: ManagerDeps = { ...defaultDeps, ...overrides };
  let running: Running | null = null;
  let startingChild: SpawnedProcess | null = null;
  let starting: Promise<RerankServerHandle | null> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let consecutiveFailures = 0;
  let disabledReason: string | null = null;
  let lastError: string | null = null;
  let exitHooksInstalled = false;
  let staleReaped = false;

  const clearIdleTimer = (): void => {
    if (idleTimer) {
      deps.clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const writePidFile = (
    pid: number | null,
    port: number,
    modelPath: string,
  ): void => {
    const file = deps.pidFilePath?.();
    if (!file || pid == null) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ pid, port, modelPath, startedAt: deps.now() }),
      );
    } catch {
      /* pid file is best effort */
    }
  };

  const removePidFile = (): void => {
    const file = deps.pidFilePath?.();
    if (!file) return;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  };

  /**
   * A backend killed with SIGKILL cannot run its exit hooks, so a previous
   * sidecar may still be alive. Terminate it before starting a new one so a
   * crash loop cannot accumulate GPU-resident servers.
   */
  const reapStaleServer = (): void => {
    if (staleReaped) return;
    staleReaped = true;
    const file = deps.pidFilePath?.();
    if (!file) return;
    let record: { pid?: unknown } | null = null;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    } catch {
      return;
    }
    const pid = typeof record?.pid === "number" ? record.pid : null;
    removePidFile();
    if (!pid || pid === process.pid) return;
    try {
      process.kill(pid, 0);
    } catch {
      return; // already gone
    }
    const probe = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    });
    const command = probe.stdout ?? "";
    if (!command.includes("llama-server") || !command.includes("--rerank"))
      return;
    try {
      process.kill(pid, "SIGTERM");
      deps.warn(
        `terminated stale sidecar pid ${pid} left by a previous backend`,
      );
    } catch {
      /* ignore */
    }
  };

  const terminate = (reason: string): void => {
    clearIdleTimer();
    if (startingChild) {
      try {
        startingChild.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      startingChild = null;
    }
    const current = running;
    running = null;
    if (!current) return;
    deps.log(`stopping sidecar pid ${current.pid ?? "?"} (${reason})`);
    try {
      current.child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    removePidFile();
  };

  const installExitHooks = (): void => {
    if (exitHooksInstalled || !deps.installExitHooks) return;
    exitHooksInstalled = true;
    process.on("exit", () => terminate("backend exit"));
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(signal, () => {
        terminate(`backend ${signal}`);
        // Preserve the default behaviour (terminate) unless another module
        // has taken responsibility for the shutdown sequence.
        if (process.listenerCount(signal) <= 1) process.exit(0);
      });
    }
  };

  let inflightRequests = 0;

  const armIdleTimer = (): void => {
    clearIdleTimer();
    const current = running;
    if (!current || current.idleMs <= 0) return;
    idleTimer = deps.setTimeout(() => {
      idleTimer = null;
      // A request that outlives the idle window (a slow depth-50 batch, or
      // a deliberately short DOCKET_RERANK_IDLE_SECONDS) must not have its
      // server killed under it; wait for it to finish and re-arm instead.
      if (inflightRequests > 0) {
        armIdleTimer();
        return;
      }
      terminate(`idle for ${Math.round(current.idleMs / 1000)} s`);
    }, current.idleMs);
    idleTimer.unref?.();
  };

  const waitForHealth = async (
    child: SpawnedProcess,
    baseUrl: string,
    stderrTail: string[],
  ): Promise<void> => {
    const deadline = deps.now() + deps.startupTimeoutMs;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
      null;
    child.once("exit", (code, signal) => {
      exited = { code, signal };
    });
    while (deps.now() < deadline) {
      if (exited) {
        const { code, signal } = exited as {
          code: number | null;
          signal: NodeJS.Signals | null;
        };
        throw new Error(
          `llama-server exited during start-up (code ${code ?? "null"}, signal ${signal ?? "null"})` +
            (stderrTail.length ? `: ${stderrTail.slice(-3).join(" | ")}` : ""),
        );
      }
      try {
        const controller = new AbortController();
        const abortTimer = deps.setTimeout(() => controller.abort(), 2_000);
        try {
          const response = await deps.fetch(`${baseUrl}/health`, {
            signal: controller.signal,
          });
          if (response.ok) return;
        } finally {
          deps.clearTimeout(abortTimer);
        }
      } catch {
        /* not listening yet */
      }
      // Deliberately not unref'd: a CLI caller must stay alive until the
      // sidecar is healthy or the start-up deadline passes.
      await new Promise<void>((resolve) => {
        deps.setTimeout(resolve, deps.healthPollIntervalMs);
      });
    }
    throw new Error(
      `llama-server did not become healthy within ${Math.round(deps.startupTimeoutMs / 1000)} s` +
        (stderrTail.length ? `: ${stderrTail.slice(-3).join(" | ")}` : ""),
    );
  };

  const start = async (
    options: EnsureRerankServerOptions,
  ): Promise<RerankServerHandle | null> => {
    reapStaleServer();
    const port = await deps.pickFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const args = llamaServerArgs(options.modelPath, port);
    const startedAt = deps.now();
    deps.log(`starting sidecar: ${options.binaryPath} ${args.join(" ")}`);
    const stderrTail: string[] = [];
    // Hooks go in before the spawn so a process that dies during start-up
    // (Ctrl-C, crash) still takes the half-started sidecar with it.
    installExitHooks();
    const child = deps.spawn(options.binaryPath, args);
    startingChild = child;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        stderrTail.push(line.trim());
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });
    const spawnError = new Promise<never>((_, reject) => {
      child.once("error", (err) => reject(err));
    });

    try {
      await Promise.race([
        waitForHealth(child, baseUrl, stderrTail),
        spawnError,
      ]);
    } catch (err) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      if (startingChild === child) startingChild = null;
    }

    const idleMs = Math.max(
      0,
      (options.idleSeconds ?? DEFAULT_RERANK_IDLE_SECONDS) * 1000,
    );
    running = {
      child,
      baseUrl,
      pid: child.pid ?? null,
      modelPath: options.modelPath,
      idleMs,
    };
    writePidFile(child.pid ?? null, port, options.modelPath);
    child.once("exit", (code, signal) => {
      if (running?.child !== child) return;
      running = null;
      clearIdleTimer();
      removePidFile();
      deps.warn(
        `sidecar pid ${child.pid ?? "?"} exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}); it will be restarted on the next request`,
      );
    });
    deps.log(
      `sidecar ready on ${baseUrl} after ${Math.round(deps.now() - startedAt)} ms (pid ${child.pid ?? "?"}, idle stop ${Math.round(idleMs / 1000)} s)`,
    );
    armIdleTimer();
    return { baseUrl };
  };

  const ensure = async (
    options: EnsureRerankServerOptions,
  ): Promise<RerankServerHandle | null> => {
    if (disabledReason) return null;
    if (running) {
      if (running.modelPath !== options.modelPath) {
        terminate("model path changed");
      } else {
        armIdleTimer();
        return { baseUrl: running.baseUrl };
      }
    }
    if (starting) return starting;
    starting = start(options)
      .then((handle) => {
        consecutiveFailures = 0;
        lastError = null;
        return handle;
      })
      .catch((err: unknown) => {
        consecutiveFailures += 1;
        lastError = err instanceof Error ? err.message : String(err);
        if (consecutiveFailures >= RERANK_MAX_CONSECUTIVE_FAILURES) {
          disabledReason = lastError;
          deps.warn(
            `sidecar failed ${consecutiveFailures} times in a row; reranking is disabled for this session. Last error: ${lastError}`,
          );
        } else {
          deps.warn(
            `sidecar start failed (${consecutiveFailures}/${RERANK_MAX_CONSECUTIVE_FAILURES}): ${lastError}`,
          );
        }
        return null;
      })
      .finally(() => {
        starting = null;
      });
    return starting;
  };

  return {
    ensure,
    markUsed: () => armIdleTimer(),
    beginRequest: () => {
      inflightRequests += 1;
    },
    endRequest: () => {
      inflightRequests = Math.max(0, inflightRequests - 1);
      armIdleTimer();
    },
    stop: (reason) => terminate(reason),
    isDisabled: () => disabledReason !== null,
    getState: () => ({
      status: disabledReason
        ? "disabled"
        : running
          ? "running"
          : starting
            ? "starting"
            : "stopped",
      baseUrl: running?.baseUrl ?? null,
      pid: running?.pid ?? null,
      consecutiveFailures,
      lastError: disabledReason ?? lastError,
    }),
  };
}

export const rerankServerManager: RerankServerManager =
  createRerankServerManager();

export function ensureRerankServer(
  options: EnsureRerankServerOptions,
): Promise<RerankServerHandle | null> {
  return rerankServerManager.ensure(options);
}
