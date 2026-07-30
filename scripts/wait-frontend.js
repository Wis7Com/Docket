#!/usr/bin/env node
// Waits for the frontend to answer before Electron launches.
//
// Replaces `wait-on http://localhost:3000`, which hardcoded the port and, on
// timeout, said only that the wait failed. The launchers now assign the port
// dynamically and publish it as DOCKET_FRONTEND_URL, so the wait has to follow
// that variable — and when it does give up, it names the URL it was waiting on
// so the log points at the real problem instead of a generic timeout.
const DEFAULT_URL = "http://localhost:3000";
const url = process.env.DOCKET_FRONTEND_URL || DEFAULT_URL;
const timeoutMs = Number(process.env.DOCKET_FRONTEND_WAIT_MS || 120_000);
const intervalMs = 250;

async function reachable() {
  try {
    // Any HTTP answer means the server is listening; a 404 on / is still up.
    await fetch(url, { method: "GET", redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await reachable()) return;
    if (Date.now() >= deadline) {
      console.error(
        `wait-frontend: ${url} did not respond within ${Math.round(timeoutMs / 1000)}s.\n` +
          "The frontend server never came up. Check the launcher log for its\n" +
          "startup errors (a port already in use is the usual cause).",
      );
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

void main();
