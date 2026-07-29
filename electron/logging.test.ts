import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  closeLogging,
  flushLoggingForTests,
  initLogging,
  logRendererConsoleMessage,
  setLogRedactions,
} from "./logging";

test("renderer warn/error messages append to the redacted app log", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "docket-logging-"));
  const secret = "secret-token-123";
  try {
    const logPath = initLogging(tempDir);
    setLogRedactions([secret]);

    logRendererConsoleMessage(1, `info ${secret}`, 3, "http://localhost:3000/a.js");
    logRendererConsoleMessage(2, `warn ${secret}`, 7, "http://localhost:3000/b.js");
    logRendererConsoleMessage(3, `error ${secret}`, 11, "http://localhost:3000/c.js");
    await flushLoggingForTests();

    const log = fs.readFileSync(logPath, "utf8");
    assert.match(log, /\[renderer\] WARN warn \[REDACTED\]/);
    assert.match(log, /\[renderer\] ERROR error \[REDACTED\]/);
    assert.doesNotMatch(log, /info/);
    assert.doesNotMatch(log, new RegExp(secret));
  } finally {
    setLogRedactions([]);
    closeLogging();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
