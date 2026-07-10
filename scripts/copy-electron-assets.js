// Copies non-TypeScript Electron assets into dist-electron
// after tsc compilation. Keeps a single load path for both dev and prod.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "dist-electron");
const src = path.join(root, "electron");

fs.mkdirSync(out, { recursive: true });
for (const stale of [
  "auth.js",
  "auth.js.map",
  "auth.d.ts",
  "workspace.js",
  "workspace.js.map",
  "workspace.d.ts",
]) {
  fs.rmSync(path.join(out, stale), { force: true });
}
fs.rmSync(path.join(out, "lock"), { recursive: true, force: true });
fs.copyFileSync(path.join(src, "preload.js"), path.join(out, "preload.js"));

console.log("Copied preload.js to dist-electron/");
