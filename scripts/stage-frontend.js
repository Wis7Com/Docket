// Next.js standalone output drops a self-contained Node server, but doesn't
// include the static assets (.next/static) or public/ alongside it. We have
// to copy those in so the spawned server can serve them.
//
// In monorepo-shaped projects, Next.js relocates server.js to preserve the
// path from the trace root: it can land at either
//   .next/standalone/server.js          (single-package projects)
// or
//   .next/standalone/<frontend>/server.js  (when other node_modules trees exist)
// We probe both and stage assets next to whichever exists.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const standalone = path.join(root, "frontend", ".next", "standalone");
const publicSrc = path.join(root, "frontend", "public");
const staticSrc = path.join(root, "frontend", ".next", "static");

if (!fs.existsSync(standalone)) {
  console.log(
    "[stage-frontend] standalone dir not found — did `next build` run?",
  );
  process.exit(0);
}

const candidates = [
  path.join(standalone, "server.js"),
  path.join(standalone, "frontend", "server.js"),
];
const serverEntry = candidates.find((p) => fs.existsSync(p));
if (!serverEntry) {
  console.error(
    "[stage-frontend] could not find server.js in:\n  " +
      candidates.join("\n  "),
  );
  process.exit(1);
}
const serverDir = path.dirname(serverEntry);
console.log(`[stage-frontend] server.js at ${serverEntry}`);

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

copyDir(publicSrc, path.join(serverDir, "public"));
copyDir(staticSrc, path.join(serverDir, ".next", "static"));
console.log(`[stage-frontend] staged public/ and .next/static into ${serverDir}`);
