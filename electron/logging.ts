import * as fs from "fs";
import * as path from "path";
import { resolveDataDir } from "./appData";

let logStream: fs.WriteStream | null = null;
let logPath: string | null = null;
let redactor: ((s: string) => string) | null = null;

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

/**
 * Mirrors console + child-process output to a per-launch log file inside the
 * app-data `.docket/logs/` directory. Lets users (or us, remotely) inspect what
 * happened on a packaged build where there's no terminal attached.
 */
export function initLogging(appDataPath: string): string {
  const dir = path.join(resolveDataDir(appDataPath), "logs");
  fs.mkdirSync(dir, { recursive: true });
  rotateLogs(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  logPath = path.join(dir, `docket-${stamp}.log`);
  logStream = fs.createWriteStream(logPath, { flags: "a" });

  const writeLog = (prefix: string, args: unknown[]): void => {
    if (!logStream) return;
    const line = args
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
    const redacted = redactor ? redactor(line) : line;
    logStream.write(`[${new Date().toISOString()}] ${prefix} ${redacted}\n`);
  };

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...args: unknown[]) => {
    writeLog("LOG ", args);
    origLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    writeLog("WARN", args);
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    writeLog("ERR ", args);
    origErr(...args);
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
}
