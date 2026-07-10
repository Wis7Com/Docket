#!/usr/bin/env node

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BACKEND = path.join(ROOT, "backend");
const MODULES = ["better-sqlite3", "@napi-rs/canvas"];

const targetNode = findProjectNode();
if (
  targetNode &&
  path.resolve(targetNode) !== path.resolve(process.execPath) &&
  process.env.DOCKET_DEV_NATIVE_REEXEC !== "1"
) {
  const result = spawnSync(targetNode, [__filename], {
    cwd: ROOT,
    env: { ...process.env, DOCKET_DEV_NATIVE_REEXEC: "1" },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function loadNativeModule(name) {
  try {
    const loaded = require(path.join(BACKEND, "node_modules", name));
    if (name === "better-sqlite3") {
      const db = new loaded(":memory:");
      db.close();
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

const failures = MODULES.map((name) => [name, loadNativeModule(name)]).filter(
  ([, result]) => !result.ok,
);

if (failures.length === 0) {
  console.log(
    `[dev-native] native modules match Node ${process.version} ABI ${process.versions.modules}`,
  );
  process.exit(0);
}

for (const [name, result] of failures) {
  console.warn(`[dev-native] ${name} failed to load: ${result.message}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const rebuild = spawnSync(npm, ["rebuild", ...MODULES], {
  cwd: BACKEND,
  env: process.env,
  stdio: "inherit",
});

if (rebuild.status !== 0) {
  process.exit(rebuild.status ?? 1);
}

const remainingFailures = MODULES.map((name) => [
  name,
  loadNativeModule(name),
]).filter(([, result]) => !result.ok);

if (remainingFailures.length > 0) {
  for (const [name, result] of remainingFailures) {
    console.error(`[dev-native] ${name} still failed: ${result.message}`);
  }
  process.exit(1);
}

console.log(
  `[dev-native] rebuilt native modules for Node ${process.version} ABI ${process.versions.modules}`,
);

function findProjectNode() {
  const requestedMajor = readRequestedNodeMajor();
  const candidates = [
    process.env.DOCKET_BACKEND_NODE,
    requestedMajor
      ? `/opt/homebrew/opt/node@${requestedMajor}/bin/node`
      : undefined,
    requestedMajor
      ? `/usr/local/opt/node@${requestedMajor}/bin/node`
      : undefined,
    "node",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      [
        "-p",
        "JSON.stringify({ execPath: process.execPath, major: Number(process.versions.node.split('.')[0]) })",
      ],
      { encoding: "utf8" },
    );
    if (probe.status !== 0 || !probe.stdout) continue;
    try {
      const parsed = JSON.parse(probe.stdout.trim());
      const major = Number(parsed.major);
      if (major >= 20 && major < 25) {
        return parsed.execPath || candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function readRequestedNodeMajor() {
  for (const fileName of [".node-version", ".nvmrc"]) {
    try {
      const raw = require("fs")
        .readFileSync(path.join(ROOT, fileName), "utf8")
        .trim();
      const major = Number.parseInt(raw, 10);
      if (Number.isFinite(major)) return major;
    } catch {
      // Try the next version file.
    }
  }
  return null;
}
