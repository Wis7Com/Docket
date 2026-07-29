import * as fs from "fs";
import * as path from "path";
import { resolveDataDir } from "./appData";

let logStream: fs.WriteStream | null = null;
let logPath: string | null = null;
let redactor: ((s: string) => string) | null = null;
let originalConsole:
  | {
      log: typeof console.log;
      warn: typeof console.warn;
      error: typeof console.error;
    }
  | null = null;

const MAX_LOG_FILES = 10;

function rotateLogs(dir: string): void {
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("docket-") && name.endsWith(".log"))
      .map((name) => {
        const full = path.join(dir, name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          // ignore
        }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries.slice(MAX_LOG_FILES)) {
      try {
        fs.unlinkSync(e.full);
      } catch {
        // ignore
      }
    }
  } catch {
    // log dir gone — nothing to rotate
  }
}

function serializeLogArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
      try {
        return JSON.stringify(a, null, 2);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export function appendLogLine(prefix: string, args: unknown[]): void {
  if (!logStream) return;
  const line = serializeLogArgs(args);
  const redacted = redactor ? redactor(line) : line;
  logStream.write(`[${new Date().toISOString()}] ${prefix} ${redacted}\n`);
}

export function logRendererConsoleMessage(
  level: number,
  message: string,
  line: number,
  sourceId: string,
): void {
  if (level < 2) return;
  appendLogLine("[renderer]", [
    `${level >= 3 ? "ERROR" : "WARN"} ${message} (${sourceId}:${line})`,
  ]);
}

/**
 * Mirrors console + child-process output to a per-launch log file inside the
 * app-data `.docket/logs/` directory. Lets users (or us, remotely) inspect what
 * happened on a packaged build where there's no terminal attached.
 */
export function initLogging(appDataPath: string): string {
  if (logStream) closeLogging();
  const dir = path.join(resolveDataDir(appDataPath), "logs");
  fs.mkdirSync(dir, { recursive: true });
  rotateLogs(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  logPath = path.join(dir, `docket-${stamp}.log`);
  logStream = fs.createWriteStream(logPath, { flags: "a" });

  if (!originalConsole) {
    originalConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
  }
  console.log = (...args: unknown[]) => {
    appendLogLine("LOG ", args);
    originalConsole?.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    appendLogLine("WARN", args);
    originalConsole?.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    appendLogLine("ERR ", args);
    originalConsole?.error(...args);
  };

  return logPath;
}

/**
 * Register secrets to be redacted from any subsequent log output. Called by
 * the session-start path with the JWT secret + every API key from the
 * keychain so they never end up on disk.
 */
export function setLogRedactions(secrets: (string | undefined | null)[]): void {
  const filtered = secrets
    .filter((s): s is string => typeof s === "string" && s.length >= 8)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (filtered.length === 0) {
    redactor = null;
    return;
  }
  const re = new RegExp(filtered.join("|"), "g");
  redactor = (line: string) => line.replace(re, "[REDACTED]");
}

export function getLogPath(): string | null {
  return logPath;
}

export function closeLogging(): void {
  try {
    logStream?.end();
  } catch {
    // ignore
  }
  logStream = null;
  if (originalConsole) {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    originalConsole = null;
  }
}

export function flushLoggingForTests(): Promise<void> {
  if (!logStream) return Promise.resolve();
  return new Promise((resolve) => {
    logStream?.write("", () => resolve());
  });
}
