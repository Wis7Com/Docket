// pdf.js needs the 14 PDF standard fonts (Helvetica, Times, Courier, Symbol,
// ZapfDingbats) whenever a document references one without embedding it —
// common in legal PDFs. Upstream defaults to fetching them from a CDN, which
// would be the only network call the viewer makes: offline it degrades to
// missing glyphs, and online it tells a third party when a document is opened.
// Docket is local-first, so we serve them from our own origin instead.
//
// The fonts are copied out of the pinned pdfjs-dist package rather than
// committed, so they cannot drift from the library that loads them. public/ is
// staged into the packaged app by scripts/stage-frontend.js, so landing them
// there is enough for both `next dev` and the Electron build.
//
// LICENSE_FOXIT (BSD-3-Clause) and LICENSE_LIBERATION (SIL OFL 1.1) sit in the
// source directory and are copied with the fonts on purpose: both licenses
// require the notice to travel with the binaries.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const frontend = path.join(root, "frontend");
const dest = path.join(frontend, "public", "standard_fonts");

let src;
try {
  // Resolve through the package so a hoisted node_modules tree still works.
  src = path.join(
    path.dirname(
      require.resolve("pdfjs-dist/package.json", { paths: [frontend] }),
    ),
    "standard_fonts",
  );
} catch {
  console.error(
    "[stage-pdf-fonts] cannot resolve pdfjs-dist — run `npm install` in frontend/",
  );
  process.exit(1);
}

// Fail loudly rather than skipping: a silent skip ships a viewer that renders
// the wrong glyphs only for certain documents, which is far harder to notice
// than a failed build.
if (!fs.existsSync(src)) {
  console.error(`[stage-pdf-fonts] standard_fonts not found at ${src}`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

let count = 0;
for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
  count += 1;
}

console.log(`[stage-pdf-fonts] staged ${count} files into public/standard_fonts`);
