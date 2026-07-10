import { ChildProcess, spawn } from "child_process";
import { frontendServerEntry } from "./paths";
// (log redaction is configured by backend.ts at session start; the frontend
//  child inherits the same redactor via the shared logging module.)

const FRONTEND_PORT = Number(process.env.DOCKET_FRONTEND_PORT ?? 3000);

let frontendProc: ChildProcess | null = null;

function isFrontendRunning(): boolean {
  return (
    frontendProc !== null &&
    !frontendProc.killed &&
    frontendProc.exitCode === null
  );
}

export function spawnFrontend(): void {
  if (process.env.NODE_ENV === "development") return; // dev runs `next dev` externally
  if (frontendProc !== null) return;

  const entry = frontendServerEntry();
  if (!entry) {
    console.error(
      "[frontend] could not locate server.js inside frontend/.next/standalone/. " +
        "Was `npm run build:frontend` (which runs scripts/stage-frontend.js) executed before packaging?",
    );
    return;
  }

  console.log(
    `[frontend] spawning: ${process.execPath} ${entry.serverJs} (cwd=${entry.serverDir})`,
  );
  frontendProc = spawn(process.execPath, [entry.serverJs], {
    cwd: entry.serverDir,
    env: {
      ...process.env,
      PORT: String(FRONTEND_PORT),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      // process.execPath is Docket.exe in a packaged app — this env makes it
      // act as a Node interpreter for the standalone server.js.
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  frontendProc.on("error", (err) => {
    console.error(`[frontend] spawn error:`, err);
  });
  frontendProc.stdout?.on("data", (b: Buffer) => {
    const s = b.toString();
    process.stdout.write(`[frontend] ${s}`);
    console.log(`[frontend.stdout] ${s.replace(/\n+$/, "")}`);
  });
  frontendProc.stderr?.on("data", (b: Buffer) => {
    const s = b.toString();
    process.stderr.write(`[frontend] ${s}`);
    console.error(`[frontend.stderr] ${s.replace(/\n+$/, "")}`);
  });
  frontendProc.on("exit", (code, signal) => {
    console.log(`[frontend] exited code=${code} signal=${signal}`);
    frontendProc = null;
  });
}

export function stopFrontend(): void {
  if (frontendProc && !frontendProc.killed) frontendProc.kill();
  frontendProc = null;
}

export async function waitForFrontend(timeoutMs = 30_000): Promise<boolean> {
  const url = `http://localhost:${FRONTEND_PORT}/`;
  const deadline = Date.now() + timeoutMs;
  const requireOwnProcess = process.env.NODE_ENV !== "development";
  while (Date.now() < deadline) {
    if (requireOwnProcess && !isFrontendRunning()) return false;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (resp.ok || resp.status < 500) {
        return !requireOwnProcess || isFrontendRunning();
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function getFrontendPort(): number {
  return FRONTEND_PORT;
}
