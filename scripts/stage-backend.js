#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Stage a production-only copy of the backend for electron-builder's
 * extraResources. Avoids mutating backend/node_modules (so `npm run dev`
 * keeps working) and avoids shipping ~hundreds of MB of dev deps inside
 * the NSIS installer.
 *
 * Output: backend/.dist-bundle/
 *   ├─ package.json        (production deps only)
 *   ├─ package-lock.json   (so npm ci is deterministic)
 *   ├─ dist/               (compiled JS, copied from backend/dist)
 *   ├─ migrations/         (copied)
 *   └─ node_modules/       (npm ci --omit=dev, populated here)
 *
 * The electron-builder `extraResources` config points at this directory.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BACKEND = path.join(ROOT, "backend");
const STAGE = path.join(BACKEND, ".dist-bundle");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function main() {
  console.log(`[stage-backend] cleaning ${STAGE}`);
  rmrf(STAGE);
  fs.mkdirSync(STAGE, { recursive: true });

  // Ensure backend has been compiled.
  const distSrc = path.join(BACKEND, "dist");
  if (!fs.existsSync(distSrc)) {
    console.error(
      "[stage-backend] backend/dist missing — run `npm run build:backend` first",
    );
    process.exit(1);
  }

  console.log("[stage-backend] copying dist/, migrations/");
  copyDir(distSrc, path.join(STAGE, "dist"));
  copyDir(path.join(BACKEND, "migrations"), path.join(STAGE, "migrations"));

  // Write a CLEANED package.json that strips the `docketlocal-desktop: file:..`
  // self-reference. That dep is harmless for local development (it symlinks
  // the parent project so backend can `import` from it if needed) but
  // catastrophic in a packaged installer — npm/electron-builder follow the
  // symlink and pack the entire root project recursively. Stripping it here
  // means we don't fight whatever keeps re-adding it to backend/package.json.
  const pkgRaw = fs.readFileSync(
    path.join(BACKEND, "package.json"),
    "utf8",
  );
  const pkg = JSON.parse(pkgRaw);
  if (pkg.dependencies && "docketlocal-desktop" in pkg.dependencies) {
    delete pkg.dependencies["docketlocal-desktop"];
    console.log(
      "[stage-backend] stripped docketlocal-desktop self-reference from staged package.json",
    );
  }
  // Also drop devDependencies entirely — npm install --omit=dev would skip
  // them, but removing them from the manifest keeps the staged dir tidy.
  delete pkg.devDependencies;
  fs.writeFileSync(
    path.join(STAGE, "package.json"),
    JSON.stringify(pkg, null, 2),
  );

  console.log("[stage-backend] installing production deps");
  // Deliberately NOT copying backend/package-lock.json — the lock may have
  // entries for the self-reference / dev deps we just stripped. Let npm
  // resolve from scratch against the cleaned manifest.
  execSync("npm install --omit=dev --no-audit --no-fund --no-package-lock", {
    cwd: STAGE,
    stdio: "inherit",
  });

  // Native modules (better-sqlite3 in particular) get built against the
  // SYSTEM Node ABI by `npm install`, but at runtime they're loaded by
  // Electron's bundled Node — different ABI. Without this rebuild step the
  // packaged app crashes with NODE_MODULE_VERSION mismatch the first time
  // the backend tries to `require("better-sqlite3")`.
  console.log("[stage-backend] rebuilding native modules for Electron's ABI");
  const rebuildBin = path.join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-rebuild.cmd" : "electron-rebuild",
  );
  if (!fs.existsSync(rebuildBin)) {
    console.error(
      `[stage-backend] electron-rebuild not found at ${rebuildBin}. ` +
        "electron-builder should provide it; run `npm install` at the repo root.",
    );
    process.exit(1);
  }
  // -m points at the directory CONTAINING node_modules, not at node_modules
  // itself. -w scopes the rebuild to the natives we actually ship:
  //   - better-sqlite3: backend's main DB
  //   - @napi-rs/canvas: transitive dep of pdfjs-dist (used by chat /
  //     tabular / documents routes for page rendering). If pdfjs lazily
  //     loads it, an unrebuilt binary would crash with NODE_MODULE_VERSION
  //     mismatch the same way better-sqlite3 did.
  // -w accepts a comma-separated module list (NOT repeated flags — the CLI
  // calls argv.w.split(',') and crashes on an array).
  execSync(
    `"${rebuildBin}" -m "${STAGE}" -w better-sqlite3,@napi-rs/canvas,onnxruntime-node --force`,
    {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
    },
  );

  // Sanity check + report size.
  const nm = path.join(STAGE, "node_modules");
  if (!fs.existsSync(nm)) {
    console.error("[stage-backend] npm ci finished but node_modules missing");
    process.exit(1);
  }
  console.log("[stage-backend] done. Stage tree:");
  for (const entry of fs.readdirSync(STAGE)) {
    console.log(`  ${entry}/`);
  }
}

main();
