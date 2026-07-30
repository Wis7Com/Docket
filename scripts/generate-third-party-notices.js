#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Regenerate THIRD-PARTY-NOTICES.md.
 *
 * Docket ships as an Electron installer that bundles far more than its own
 * source: the production npm trees of `backend/` and `frontend/`, the Electron
 * runtime, and (on Windows) LibreOffice. Several of those carry notice
 * obligations that the AGPL text in `LICENSE` does not cover on its own.
 *
 * The npm section is generated from the installed trees so it cannot drift
 * silently; the components above npm (Electron, LibreOffice, the PaddleOCR
 * models, the built-in workflow prompts) are curated here because they are not
 * npm packages and have no package.json to read.
 *
 * Run after changing dependencies:
 *   npm run notices
 *
 * Requires backend/node_modules and frontend/node_modules to be installed.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "THIRD-PARTY-NOTICES.md");
const TREES = ["backend", "frontend"];

/**
 * Optional platform-specific binaries (`@img/sharp-linux-x64`,
 * `@esbuild/win32-x64`, …) are only installed for the current platform, so
 * `npm ls` reports the rest with no version and no license. They are not
 * dropped — they do ship in the per-platform installer — so fall back to the
 * license the umbrella package declares for them.
 */
const PLATFORM_PACKAGE_FALLBACKS = [
  [/^@img\/sharp-libvips-/, "LGPL-3.0-or-later"],
  [/^@img\/sharp-/, "Apache-2.0"],
  [/^@esbuild\//, "MIT"],
  [/^@next\/swc-/, "MIT"],
  [/^@napi-rs\/canvas-/, "MIT"],
];

/** Licenses that need more than a line in a table. */
const NEEDS_CALLOUT = /LGPL|MPL|EPL|CDDL|CC-BY|^GPL|AGPL/i;

function fallbackLicense(name) {
  for (const [pattern, license] of PLATFORM_PACKAGE_FALLBACKS) {
    if (pattern.test(name)) return license;
  }
  return null;
}

/**
 * `npm ls` omits `license` for packages that use the deprecated `licenses`
 * array, or that only declare it in a LICENSE file, so read the manifest off
 * disk before giving up.
 */
function licenseFromDisk(dir) {
  if (!dir) return null;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    if (typeof pkg.license === "string") return pkg.license;
    if (pkg.license && pkg.license.type) return pkg.license.type;
    if (Array.isArray(pkg.licenses)) {
      return pkg.licenses.map((l) => l.type).join(" OR ") || null;
    }
  } catch {
    // Not installed on this platform, or unreadable — fall through.
  }
  return null;
}

function walk(node, packages) {
  for (const [name, dep] of Object.entries(node.dependencies || {})) {
    if (!packages.has(name)) {
      packages.set(name, {
        version: dep.version || null,
        license:
          dep.license ||
          licenseFromDisk(dep.path) ||
          fallbackLicense(name) ||
          "UNKNOWN",
      });
    }
    walk(dep, packages);
  }
}

/**
 * `npm ls` exits non-zero for benign reasons — a peer-dep warning is enough —
 * so its exit code cannot gate this script. But it *also* exits non-zero when
 * packages are simply not installed, and in that case it still prints a tree:
 * a degraded one, with the unresolved dependencies flagged and their subtrees
 * gone. Walking that tree silently under-reports.
 *
 * That is not hypothetical. A frontend/ whose node_modules npm could no longer
 * reconcile — every declared dependency reported missing while all 592 were
 * present on disk, fixed by reinstalling — took this file from 866 packages to
 * 504. The LGPL-3.0 libvips paragraph and the CC-BY-4.0 caniuse-lite entry went
 * with them. Nothing failed; the file just got shorter.
 *
 * A notices file that quietly drops disclosures is worse than one that refuses
 * to build, so an unresolved tree is a hard error. Only top-level dependencies
 * are checked: platform-specific optional packages further down (the @esbuild
 * and @img/sharp-libvips sets) are legitimately absent on any one machine and
 * are reported with a null version by design.
 */
function assertTreeResolved(tree, parsed) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, tree, "package.json"), "utf8"),
  );
  const declared = Object.keys(manifest.dependencies || {});
  const resolved = parsed.dependencies || {};
  const missing = declared.filter(
    (name) => !resolved[name] || resolved[name].missing,
  );
  if (missing.length === 0) return;

  const shown = missing.slice(0, 5).join(", ");
  const more = missing.length > 5 ? `, +${missing.length - 5} more` : "";
  const err = new Error(
    `${tree}/ has ${missing.length} of ${declared.length} dependencies ` +
      `unresolved (${shown}${more}).\n` +
      `Refusing to write THIRD-PARTY-NOTICES.md from an incomplete tree — ` +
      `it would silently drop disclosures.\n` +
      `Run \`npm install --prefix ${tree}\` and try again.`,
  );
  err.expected = true;
  throw err;
}

function collect() {
  const packages = new Map();
  for (const tree of TREES) {
    const prefix = path.join(ROOT, tree);
    const cmd = `npm ls --omit=dev --all --json --long --prefix ${prefix}`;
    let parsed;
    try {
      parsed = JSON.parse(
        execSync(cmd, {
          encoding: "utf8",
          maxBuffer: 1 << 28,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch (err) {
      // `npm ls` exits non-zero on peer-dep warnings but still prints the tree.
      if (!err.stdout) {
        const fatal = new Error(
          `Unable to read the dependency tree for ${tree}/. ` +
            `Run \`npm install\` in ${tree}/ first. (${err.message})`,
        );
        fatal.expected = true;
        throw fatal;
      }
      parsed = JSON.parse(err.stdout);
    }
    assertTreeResolved(tree, parsed);
    walk(parsed, packages);
  }
  // Docket's own workspace package is not a third party.
  packages.delete("docket-desktop");
  return packages;
}

function groupByLicense(packages) {
  const groups = new Map();
  for (const [name, info] of packages) {
    if (!groups.has(info.license)) groups.set(info.license, []);
    groups.get(info.license).push(`${name}@${info.version ?? "*"}`);
  }
  for (const list of groups.values()) list.sort();
  return [...groups].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
}

const PREAMBLE = `# Third-party notices

Docket itself is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0-only); see \`LICENSE\` for that text and \`README.md\` for the
attribution of the upstream projects Docket derives from.

This file covers the *other* people's work that Docket redistributes — inside
the installer, inside the packaged app, or as content shipped in the UI — and
the notices those licenses ask for. It is partly generated: run
\`npm run notices\` after changing dependencies.

---

## Bundled components (not npm packages)

### Electron, Chromium, and Node.js

The desktop shell is [Electron](https://github.com/electron/electron)
(MIT), which embeds Chromium (BSD-3-Clause and a large set of compatible
third-party licenses) and Node.js (MIT). Electron's aggregated license text
lives in \`LICENSE\` and \`LICENSES.chromium.html\` in the \`electron\`
package; electron-builder does not copy them into the macOS \`.app\`, so this
file and the repository stand in for them there. Chromium's full notice set
is at <https://chromium.googlesource.com/chromium/src/+/main/LICENSE>.

### Fonts

The UI self-hosts three font families, all under the **SIL Open Font License
1.1**: **Inter** and **EB Garamond** (fetched at build time by
\`next/font/google\` and served from the app's own origin, not from Google)
and the **KaTeX** math fonts that ship with the \`katex\` package. OFL-1.1
permits bundling and redistribution; it forbids selling the fonts on their
own and requires this notice to travel with them. License text:
<https://openfontlicense.org/>.

The PDF viewer additionally serves the **14 PDF standard fonts** that ship
with \`pdfjs-dist\`, used when a document references Helvetica, Times, Courier,
Symbol, or ZapfDingbats without embedding them. These are two separate sets
under two licenses: the **Liberation** fonts (Red Hat, with digitized data by
Google) under **SIL OFL 1.1** as above, and the **Foxit** substitution fonts
(\`Foxit*.pfb\`) under **BSD-3-Clause**, copyright the PDFium Authors. Upstream
pdf.js loads these from a CDN at run time; Docket copies them out of the
pinned package into \`frontend/public/standard_fonts/\` at build time
(\`scripts/stage-pdf-standard-fonts.js\`) and serves them from the app's own
origin, so viewing a document works offline and reaches no third party. Both
license texts — \`LICENSE_LIBERATION\` and \`LICENSE_FOXIT\` — are copied
alongside the fonts, which is what each license asks for.

### LibreOffice — Windows installer only

The Windows installer bundles [LibreOffice](https://www.libreoffice.org/)
25.8.6, used headlessly to convert DOCX/DOC to PDF for preview. LibreOffice is
licensed under the **Mozilla Public License v2.0**, with portions under the
GNU Lesser General Public License; see
<https://www.libreoffice.org/download/license/>. The unmodified upstream MSI is
downloaded at build time by \`scripts/fetch-libreoffice.js\` and extracted into
the installer — Docket does not patch it. Docket never links against
LibreOffice: \`backend/src/lib/convert.ts\` runs the \`soffice\` binary as a
separate child process, so the two are aggregated on a storage medium rather
than combined into one work, and MPL-2.0's source obligation stays with the
unmodified upstream files. LibreOffice is a trademark of The Document
Foundation; Docket is not affiliated with or endorsed by The Document
Foundation.

macOS and Linux builds do not bundle LibreOffice; they use a system install if
one is present.

### PaddleOCR models — downloaded at run time

Korean/English OCR uses PP-OCRv5 ONNX models published by PaddlePaddle on
Hugging Face (\`PaddlePaddle/PP-OCRv5_mobile_det_onnx\`,
\`PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx\`,
\`PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx\`). The models are **Apache-2.0** and
are fetched onto the user's machine on first use by
\`backend/src/lib/ocr/modelDownloader.ts\` — they are not redistributed in the
installer.

### Apple Vision (macOS)

The macOS OCR helper \`native/macos-vision-ocr\` is original Docket code that
calls Apple's Vision framework through the OS. No Apple code is redistributed.

---

## Built-in workflow content

The built-in workflow prompts and tabular column definitions shipped in
\`frontend/src/app/components/workflows/builtinWorkflows.ts\` and
\`backend/src/lib/builtinWorkflows.ts\` come from Open Legal Products, except
**Issue-by-Issue Comparison** and **New Arguments Across Brief Sequence**, which
are original Docket work.

Open Legal Products publishes these workflows at
[Open-Legal-Products/mike-workflows](https://github.com/Open-Legal-Products/mike-workflows)
under the MIT license, with \`author: "Open Legal Products"\` declared in each
\`SKILL.md\`. Docket reproduces the prompt text with light edits (tool names and
citation requirements adjusted for Docket's retrieval tools). The MIT notice
that accompanies that material:

\`\`\`
MIT License

Copyright (c) 2026 Mike

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
\`\`\`

---
`;

const CALLOUT_NOTES = {
  "LGPL-3.0-or-later": `These are the prebuilt **libvips** shared libraries used by \`sharp\` for image
processing. They are dynamically linked and shipped unmodified. Under
LGPL-3.0 §4 you may replace them with your own build: Docket's complete
corresponding source is public, \`sharp\` resolves libvips through the normal
Node native-module lookup, and rebuilding with \`npm rebuild sharp\` relinks
against a libvips of your choosing. libvips source:
<https://github.com/libvips/libvips>.`,
  "CC-BY-4.0": `\`caniuse-lite\` embeds browser-support data from the caniuse.com database,
licensed CC-BY-4.0. Attribution: © Alexis Deveria and contributors,
<https://caniuse.com/>.`,
  "(MIT OR GPL-3.0-or-later)": `Dual-licensed; Docket uses these under the **MIT** option.`,
  "(MIT OR CC0-1.0)": `Dual-licensed; Docket uses these under the **MIT** option.`,
  "(MIT OR WTFPL)": `Dual-licensed; Docket uses these under the **MIT** option.`,
  "(WTFPL OR MIT)": `Dual-licensed; Docket uses these under the **MIT** option.`,
  "(BSD-2-Clause OR MIT OR Apache-2.0)": `Multi-licensed; Docket uses these under the **MIT** option.`,
  UNKNOWN: `These packages declare no SPDX identifier in their \`package.json\`. Most are
optional peers that npm does not install on this platform and that carry a
license in their own manifest once installed.

One is a real gap: **\`buffers@0.1.1\`** (a 2011 package by James Halliday,
reached through \`exceljs\` → \`unzipper\` → \`binary\`) ships with no license
field, no LICENSE file, and an upstream repository that no longer exists.
Strictly it grants no rights. It is a 60-line Buffer helper with no practical
alternative short of replacing \`exceljs\`; the exposure is noted here rather
than left silent.`,
};

function render(packages) {
  const groups = groupByLicense(packages);
  const total = packages.size;

  let md = PREAMBLE;
  md += `\n## npm dependencies\n\n`;
  md += `${total} production packages ship inside the app across the \`backend/\`\n`;
  md += `and \`frontend/\` trees (development-only dependencies are excluded — they\n`;
  md += `are not redistributed). Every package's own license text is preserved in\n`;
  md += `its directory under \`node_modules/\`.\n\n`;
  md += `| License | Packages |\n| --- | ---: |\n`;
  for (const [license, list] of groups) {
    md += `| ${license} | ${list.length} |\n`;
  }

  const callouts = groups.filter(
    ([license]) => NEEDS_CALLOUT.test(license) || CALLOUT_NOTES[license],
  );
  if (callouts.length > 0) {
    md += `\n### Licenses needing more than attribution\n`;
    for (const [license, list] of callouts) {
      md += `\n#### ${license}\n\n`;
      if (CALLOUT_NOTES[license]) md += `${CALLOUT_NOTES[license]}\n\n`;
      md += `${list.map((p) => `\`${p}\``).join(", ")}\n`;
    }
  }

  md += `\n### Full package list\n\n`;
  for (const [license, list] of groups) {
    md += `<details>\n<summary>${license} (${list.length})</summary>\n\n`;
    md += `${list.map((p) => `\`${p}\``).join(", ")}\n\n`;
    md += `</details>\n\n`;
  }

  md += `---\n\n`;
  md += `*The npm sections of this file are generated by \`npm run notices\`.*\n`;
  return md;
}

function main() {
  console.log("[notices] reading production dependency trees…");
  const packages = collect();
  console.log(`[notices] ${packages.size} third-party packages`);
  fs.writeFileSync(OUT, render(packages), "utf8");
  console.log(`[notices] wrote ${path.relative(ROOT, OUT)}`);
}

try {
  main();
} catch (err) {
  // An incomplete install is a normal thing to hit, not a defect in this
  // script: print it as something to act on. Anything else keeps its stack,
  // because that would be a real bug worth seeing in full.
  if (err && err.expected) {
    console.error(`[notices] ${err.message}`);
    process.exit(1);
  }
  throw err;
}
