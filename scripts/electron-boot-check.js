// Boots the compiled Electron main long enough to catch immediate startup
// crashes, then quits. Used as a non-interactive smoke test.
//
// Run: node scripts/electron-boot-check.js
// Exit code 0 = the window loaded without crashing.

const { spawn } = require("child_process");
const path = require("path");

const electron = require("electron");
const proc = spawn(
  electron,
  [path.resolve(__dirname, "..", "dist-electron", "main.js")],
  {
    env: {
      ...electronEnv(),
      NODE_ENV: "development",
      DOCKET_BOOT_CHECK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
proc.stdout.on("data", (b) => (stdout += b.toString()));
proc.stderr.on("data", (b) => (stderr += b.toString()));

const killAfter = setTimeout(() => {
  proc.kill();
}, 4000);

proc.on("exit", (code, signal) => {
  clearTimeout(killAfter);
  console.log("---STDOUT---");
  console.log(stdout);
  console.log("---STDERR---");
  console.log(stderr);
  console.log(`exit code=${code} signal=${signal}`);
  // SIGTERM from our timeout = success (window opened, we killed it)
  if (signal === "SIGTERM" || code === 0) {
    console.log("BOOT CHECK: PASS");
    process.exit(0);
  }
  console.log("BOOT CHECK: FAIL");
  process.exit(1);
});

function electronEnv() {
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  return env;
}
