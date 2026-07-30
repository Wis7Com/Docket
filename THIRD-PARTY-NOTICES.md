# Third-party notices

Docket itself is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0-only); see `LICENSE` for that text and `README.md` for the
attribution of the upstream projects Docket derives from.

This file covers the *other* people's work that Docket redistributes — inside
the installer, inside the packaged app, or as content shipped in the UI — and
the notices those licenses ask for. It is partly generated: run
`npm run notices` after changing dependencies.

---

## Bundled components (not npm packages)

### Electron, Chromium, and Node.js

The desktop shell is [Electron](https://github.com/electron/electron)
(MIT), which embeds Chromium (BSD-3-Clause and a large set of compatible
third-party licenses) and Node.js (MIT). Electron's aggregated license text
lives in `LICENSE` and `LICENSES.chromium.html` in the `electron`
package; electron-builder does not copy them into the macOS `.app`, so this
file and the repository stand in for them there. Chromium's full notice set
is at <https://chromium.googlesource.com/chromium/src/+/main/LICENSE>.

### Fonts

The UI self-hosts three font families, all under the **SIL Open Font License
1.1**: **Inter** and **EB Garamond** (fetched at build time by
`next/font/google` and served from the app's own origin, not from Google)
and the **KaTeX** math fonts that ship with the `katex` package. OFL-1.1
permits bundling and redistribution; it forbids selling the fonts on their
own and requires this notice to travel with them. License text:
<https://openfontlicense.org/>.

The PDF viewer additionally serves the **14 PDF standard fonts** that ship
with `pdfjs-dist`, used when a document references Helvetica, Times, Courier,
Symbol, or ZapfDingbats without embedding them. These are two separate sets
under two licenses: the **Liberation** fonts (Red Hat, with digitized data by
Google) under **SIL OFL 1.1** as above, and the **Foxit** substitution fonts
(`Foxit*.pfb`) under **BSD-3-Clause**, copyright the PDFium Authors. Upstream
pdf.js loads these from a CDN at run time; Docket copies them out of the
pinned package into `frontend/public/standard_fonts/` at build time
(`scripts/stage-pdf-standard-fonts.js`) and serves them from the app's own
origin, so viewing a document works offline and reaches no third party. Both
license texts — `LICENSE_LIBERATION` and `LICENSE_FOXIT` — are copied
alongside the fonts, which is what each license asks for.

### LibreOffice — Windows installer only

The Windows installer bundles [LibreOffice](https://www.libreoffice.org/)
25.8.6, used headlessly to convert DOCX/DOC to PDF for preview. LibreOffice is
licensed under the **Mozilla Public License v2.0**, with portions under the
GNU Lesser General Public License; see
<https://www.libreoffice.org/download/license/>. The unmodified upstream MSI is
downloaded at build time by `scripts/fetch-libreoffice.js` and extracted into
the installer — Docket does not patch it. Docket never links against
LibreOffice: `backend/src/lib/convert.ts` runs the `soffice` binary as a
separate child process, so the two are aggregated on a storage medium rather
than combined into one work, and MPL-2.0's source obligation stays with the
unmodified upstream files. LibreOffice is a trademark of The Document
Foundation; Docket is not affiliated with or endorsed by The Document
Foundation.

macOS and Linux builds do not bundle LibreOffice; they use a system install if
one is present.

### PaddleOCR models — downloaded at run time

Korean/English OCR uses PP-OCRv5 ONNX models published by PaddlePaddle on
Hugging Face (`PaddlePaddle/PP-OCRv5_mobile_det_onnx`,
`PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx`,
`PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx`). The models are **Apache-2.0** and
are fetched onto the user's machine on first use by
`backend/src/lib/ocr/modelDownloader.ts` — they are not redistributed in the
installer.

### Apple Vision (macOS)

The macOS OCR helper `native/macos-vision-ocr` is original Docket code that
calls Apple's Vision framework through the OS. No Apple code is redistributed.

---

## Built-in workflow content

The built-in workflow prompts and tabular column definitions shipped in
`frontend/src/app/components/workflows/builtinWorkflows.ts` and
`backend/src/lib/builtinWorkflows.ts` come from Open Legal Products, except
**Issue-by-Issue Comparison** and **New Arguments Across Brief Sequence**, which
are original Docket work.

Open Legal Products publishes these workflows at
[Open-Legal-Products/mike-workflows](https://github.com/Open-Legal-Products/mike-workflows)
under the MIT license, with `author: "Open Legal Products"` declared in each
`SKILL.md`. Docket reproduces the prompt text with light edits (tool names and
citation requirements adjusted for Docket's retrieval tools). The MIT notice
that accompanies that material:

```
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
```

---

## npm dependencies

655 production packages ship inside the app across the `backend/`
and `frontend/` trees. Development-only dependencies are excluded, as is
the Electron shell's own build tooling at the repository root — none of
it is redistributed. Every package's own license text is preserved in its
directory under `node_modules/`.

| License | Packages |
| --- | ---: |
| MIT | 528 |
| ISC | 36 |
| Apache-2.0 | 33 |
| BSD-3-Clause | 18 |
| BSD-2-Clause | 10 |
| LGPL-3.0-or-later | 10 |
| UNKNOWN | 7 |
| MIT/X11 | 2 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| (MIT AND Zlib) | 1 |
| (MIT OR CC0-1.0) | 1 |
| (MIT OR GPL-3.0-or-later) | 1 |
| (MIT OR WTFPL) | 1 |
| 0BSD | 1 |
| BlueOak-1.0.0 | 1 |
| BSD | 1 |
| CC-BY-4.0 | 1 |
| MIT AND ISC | 1 |
| Unlicense | 1 |

### Licenses needing more than attribution

#### LGPL-3.0-or-later

These are the prebuilt **libvips** shared libraries used by `sharp` for image
processing. They are dynamically linked and shipped unmodified. Under
LGPL-3.0 §4 you may replace them with your own build: Docket's complete
corresponding source is public, `sharp` resolves libvips through the normal
Node native-module lookup, and rebuilding with `npm rebuild sharp` relinks
against a libvips of your choosing. libvips source:
<https://github.com/libvips/libvips>.

`@img/sharp-libvips-darwin-arm64@1.2.4`, `@img/sharp-libvips-darwin-x64@*`, `@img/sharp-libvips-linux-arm64@*`, `@img/sharp-libvips-linux-arm@*`, `@img/sharp-libvips-linux-ppc64@*`, `@img/sharp-libvips-linux-riscv64@*`, `@img/sharp-libvips-linux-s390x@*`, `@img/sharp-libvips-linux-x64@*`, `@img/sharp-libvips-linuxmusl-arm64@*`, `@img/sharp-libvips-linuxmusl-x64@*`

#### UNKNOWN

These packages declare no SPDX identifier in their `package.json`. Most are
optional peers that npm does not install on this platform and that carry a
license in their own manifest once installed.

One is a real gap: **`buffers@0.1.1`** (a 2011 package by James Halliday,
reached through `exceljs` → `unzipper` → `binary`) ships with no license
field, no LICENSE file, and an upstream repository that no longer exists.
Strictly it grants no rights. It is a 60-line Buffer helper with no practical
alternative short of replacing `exceljs`; the exposure is noted here rather
than left silent.

`@modelcontextprotocol/sdk@*`, `@opentelemetry/api@*`, `@playwright/test@*`, `buffers@0.1.1`, `bufferutil@*`, `sass@*`, `utf-8-validate@*`

#### (BSD-2-Clause OR MIT OR Apache-2.0)

Multi-licensed; Docket uses these under the **MIT** option.

`rc@1.2.8`

#### (MIT OR CC0-1.0)

Dual-licensed; Docket uses these under the **MIT** option.

`type-fest@0.20.2`

#### (MIT OR GPL-3.0-or-later)

Dual-licensed; Docket uses these under the **MIT** option.

`jszip@3.10.1`

#### (MIT OR WTFPL)

Dual-licensed; Docket uses these under the **MIT** option.

`expand-template@2.0.3`

#### CC-BY-4.0

`caniuse-lite` embeds browser-support data from the caniuse.com database,
licensed CC-BY-4.0. Attribution: © Alexis Deveria and contributors,
<https://caniuse.com/>.

`caniuse-lite@1.0.30001805`

### Full package list

<details>
<summary>MIT (528)</summary>

`@anthropic-ai/sdk@0.91.1`, `@babel/helper-string-parser@7.29.7`, `@babel/helper-validator-identifier@7.29.7`, `@babel/runtime@7.29.2`, `@babel/types@7.29.7`, `@emnapi/runtime@1.9.2`, `@fast-csv/format@4.3.5`, `@fast-csv/parse@4.3.6`, `@floating-ui/core@1.7.5`, `@floating-ui/dom@1.7.6`, `@floating-ui/react-dom@2.1.8`, `@floating-ui/utils@0.2.11`, `@img/colour@1.1.0`, `@napi-rs/canvas-android-arm64@*`, `@napi-rs/canvas-darwin-arm64@0.1.100`, `@napi-rs/canvas-darwin-x64@*`, `@napi-rs/canvas-linux-arm-gnueabihf@*`, `@napi-rs/canvas-linux-arm64-gnu@*`, `@napi-rs/canvas-linux-arm64-musl@*`, `@napi-rs/canvas-linux-riscv64-gnu@*`, `@napi-rs/canvas-linux-x64-gnu@*`, `@napi-rs/canvas-linux-x64-musl@*`, `@napi-rs/canvas-win32-arm64-msvc@*`, `@napi-rs/canvas-win32-x64-msvc@*`, `@napi-rs/canvas@0.1.100`, `@next/env@16.2.12`, `@next/swc-darwin-arm64@16.2.12`, `@next/swc-darwin-x64@*`, `@next/swc-linux-arm64-gnu@*`, `@next/swc-linux-arm64-musl@*`, `@next/swc-linux-x64-gnu@*`, `@next/swc-linux-x64-musl@*`, `@next/swc-win32-arm64-msvc@*`, `@next/swc-win32-x64-msvc@*`, `@nodable/entities@2.1.0`, `@pdf-lib/standard-fonts@1.0.0`, `@pdf-lib/upng@1.0.1`, `@radix-ui/primitive@1.1.3`, `@radix-ui/react-arrow@1.1.7`, `@radix-ui/react-collection@1.1.7`, `@radix-ui/react-compose-refs@1.1.2`, `@radix-ui/react-context@1.1.2`, `@radix-ui/react-direction@1.1.1`, `@radix-ui/react-dismissable-layer@1.1.11`, `@radix-ui/react-dropdown-menu@2.1.16`, `@radix-ui/react-focus-guards@1.1.3`, `@radix-ui/react-focus-scope@1.1.7`, `@radix-ui/react-icons@1.3.2`, `@radix-ui/react-id@1.1.1`, `@radix-ui/react-menu@2.1.16`, `@radix-ui/react-popper@1.2.8`, `@radix-ui/react-portal@1.1.9`, `@radix-ui/react-presence@1.1.5`, `@radix-ui/react-primitive@2.1.3`, `@radix-ui/react-roving-focus@1.1.11`, `@radix-ui/react-slot@1.2.3`, `@radix-ui/react-use-callback-ref@1.1.1`, `@radix-ui/react-use-controllable-state@1.2.2`, `@radix-ui/react-use-effect-event@0.0.2`, `@radix-ui/react-use-escape-keydown@1.1.1`, `@radix-ui/react-use-layout-effect@1.1.1`, `@radix-ui/react-use-rect@1.1.1`, `@radix-ui/react-use-size@1.1.1`, `@radix-ui/rect@1.1.1`, `@react-email/render@1.1.2`, `@reduxjs/toolkit@2.11.2`, `@remirror/core-constants@3.0.0`, `@selderee/plugin-htmlparser2@0.11.0`, `@standard-schema/spec@1.1.0`, `@standard-schema/utils@0.3.0`, `@tiptap/core@3.22.3`, `@tiptap/extension-blockquote@3.22.3`, `@tiptap/extension-bold@3.22.3`, `@tiptap/extension-bubble-menu@3.22.3`, `@tiptap/extension-bullet-list@3.22.3`, `@tiptap/extension-code-block@3.22.3`, `@tiptap/extension-code@3.22.3`, `@tiptap/extension-document@3.22.3`, `@tiptap/extension-dropcursor@3.22.3`, `@tiptap/extension-floating-menu@3.22.3`, `@tiptap/extension-gapcursor@3.22.3`, `@tiptap/extension-hard-break@3.22.3`, `@tiptap/extension-heading@3.22.3`, `@tiptap/extension-horizontal-rule@3.22.3`, `@tiptap/extension-italic@3.22.3`, `@tiptap/extension-link@3.22.3`, `@tiptap/extension-list-item@3.22.3`, `@tiptap/extension-list-keymap@3.22.3`, `@tiptap/extension-list@3.22.3`, `@tiptap/extension-ordered-list@3.22.3`, `@tiptap/extension-paragraph@3.22.3`, `@tiptap/extension-strike@3.22.3`, `@tiptap/extension-text@3.22.3`, `@tiptap/extension-underline@3.22.3`, `@tiptap/extensions@3.22.3`, `@tiptap/pm@3.22.3`, `@tiptap/react@3.22.3`, `@tiptap/starter-kit@3.22.3`, `@types/d3-array@3.2.2`, `@types/d3-color@3.1.3`, `@types/d3-ease@3.0.2`, `@types/d3-interpolate@3.0.4`, `@types/d3-path@3.1.1`, `@types/d3-scale@4.0.9`, `@types/d3-shape@3.1.8`, `@types/d3-time@3.0.4`, `@types/d3-timer@3.0.2`, `@types/debug@4.1.13`, `@types/estree-jsx@1.0.5`, `@types/estree@1.0.8`, `@types/hast@3.0.4`, `@types/jsdom@27.0.0`, `@types/katex@0.16.8`, `@types/linkify-it@5.0.0`, `@types/markdown-it@14.1.2`, `@types/mdast@4.0.4`, `@types/mdurl@2.0.0`, `@types/ms@2.1.0`, `@types/node@22.19.17`, `@types/prismjs@1.26.6`, `@types/react-dom@19.2.3`, `@types/react@19.2.14`, `@types/retry@0.12.0`, `@types/tough-cookie@4.0.5`, `@types/unist@3.0.3`, `@types/use-sync-external-store@0.0.6`, `@uiw/copy-to-clipboard@1.0.20`, `@uiw/react-markdown-preview@5.2.0`, `@uiw/react-md-editor@4.1.0`, `@xmldom/xmldom@0.8.13`, `accepts@1.3.8`, `adm-zip@0.5.18`, `agent-base@7.1.4`, `append-field@1.0.0`, `archiver-utils@2.1.0`, `archiver@5.3.2`, `argparse@1.0.10`, `aria-hidden@1.2.6`, `array-flatten@1.1.1`, `async@3.2.6`, `babel-plugin-react-compiler@1.0.0`, `bail@2.0.2`, `balanced-match@1.0.2`, `base64-js@1.5.1`, `bcp-47-match@2.0.3`, `better-sqlite3@12.9.0`, `bignumber.js@9.3.1`, `binary@0.3.0`, `bindings@1.5.0`, `bl@4.1.0`, `bluebird@3.4.7`, `body-parser@1.20.6`, `brace-expansion@1.1.16`, `buffer-crc32@0.2.13`, `buffer-from@1.1.2`, `buffer-indexof-polyfill@1.0.2`, `buffer@5.7.1`, `busboy@1.6.0`, `bytes@3.1.2`, `call-bind-apply-helpers@1.0.2`, `call-bound@1.0.4`, `ccount@2.0.1`, `character-entities-html4@2.1.0`, `character-entities-legacy@3.0.0`, `character-entities@2.0.2`, `character-reference-invalid@2.0.1`, `client-only@0.0.1`, `clsx@2.1.1`, `comma-separated-tokens@2.0.3`, `commander@8.3.0`, `compress-commons@4.1.2`, `concat-map@0.0.1`, `concat-stream@1.6.2`, `content-disposition@0.5.4`, `content-type@1.0.5`, `cookie-signature@1.0.7`, `cookie@0.7.2`, `core-util-is@1.0.3`, `cors@2.8.6`, `crc32-stream@4.0.3`, `crelt@1.0.6`, `css-selector-parser@3.3.0`, `csstype@3.2.3`, `data-uri-to-buffer@4.0.1`, `dayjs@1.11.20`, `debug@4.4.3`, `decimal.js-light@2.5.1`, `decode-named-character-reference@1.3.0`, `decompress-response@6.0.0`, `deep-extend@0.6.0`, `deepmerge@4.3.1`, `define-data-property@1.1.4`, `define-properties@1.2.1`, `depd@2.0.0`, `dequal@2.0.3`, `destroy@1.2.0`, `detect-node-es@1.1.0`, `devlop@1.1.0`, `direction@2.0.1`, `docx@9.6.1`, `dom-serializer@2.0.0`, `dunder-proto@1.0.1`, `ee-first@1.1.1`, `encodeurl@2.0.0`, `end-of-stream@1.4.5`, `es-define-property@1.0.1`, `es-errors@1.3.0`, `es-object-atoms@1.1.2`, `es-toolkit@1.45.1`, `escape-html@1.0.3`, `escape-string-regexp@4.0.0`, `estree-util-is-identifier-name@3.0.0`, `etag@1.8.1`, `eventemitter3@5.0.4`, `exceljs@4.4.0`, `express@4.22.2`, `extend@3.0.2`, `fast-csv@4.3.6`, `fast-deep-equal@2.0.1`, `fast-equals@5.4.0`, `fast-xml-builder@1.3.0`, `fast-xml-parser@5.7.2`, `fetch-blob@3.2.0`, `file-uri-to-path@1.0.0`, `finalhandler@1.3.2`, `formdata-polyfill@4.0.10`, `forwarded@0.2.0`, `fresh@0.5.2`, `fs-constants@1.0.0`, `function-bind@1.1.2`, `get-intrinsic@1.3.0`, `get-nonce@1.0.1`, `get-proto@1.0.1`, `github-from-package@0.0.0`, `globalthis@1.0.4`, `gopd@1.2.0`, `has-property-descriptors@1.0.2`, `has-symbols@1.1.0`, `hash.js@1.1.7`, `hasown@2.0.4`, `hast-util-from-html-isomorphic@2.0.0`, `hast-util-from-html@2.0.3`, `hast-util-from-parse5@8.0.3`, `hast-util-has-property@3.0.0`, `hast-util-heading-rank@3.0.0`, `hast-util-is-element@3.0.0`, `hast-util-parse-selector@4.0.0`, `hast-util-raw@9.1.0`, `hast-util-select@6.0.4`, `hast-util-to-html@9.0.5`, `hast-util-to-jsx-runtime@2.3.6`, `hast-util-to-parse5@8.0.1`, `hast-util-to-string@3.0.1`, `hast-util-to-text@4.0.2`, `hast-util-whitespace@3.0.0`, `hastscript@9.0.1`, `html-to-text@9.0.5`, `html-url-attributes@3.0.1`, `html-void-elements@3.0.0`, `htmlparser2@8.0.2`, `http-errors@2.0.1`, `https-proxy-agent@7.0.6`, `iconv-lite@0.4.24`, `immediate@3.0.6`, `immer@11.1.4`, `inline-style-parser@0.2.7`, `ipaddr.js@1.9.1`, `is-alphabetical@2.0.1`, `is-alphanumerical@2.0.1`, `is-decimal@2.0.1`, `is-hexadecimal@2.0.1`, `is-plain-obj@4.1.0`, `isarray@1.0.0`, `js-tokens@4.0.0`, `json-bigint@1.0.0`, `json-schema-to-ts@3.1.1`, `jwa@2.0.1`, `jws@4.0.1`, `katex@0.16.44`, `lazystream@1.0.1`, `leac@0.6.0`, `libreoffice-convert@1.8.2`, `lie@3.3.0`, `linkify-it@5.0.2`, `linkifyjs@4.3.2`, `lodash.defaults@4.2.0`, `lodash.difference@4.5.0`, `lodash.escaperegexp@4.1.2`, `lodash.flatten@4.4.0`, `lodash.groupby@4.6.0`, `lodash.isboolean@3.0.3`, `lodash.isequal@4.5.0`, `lodash.isfunction@3.0.9`, `lodash.isnil@4.0.0`, `lodash.isplainobject@4.0.6`, `lodash.isundefined@3.0.1`, `lodash.union@4.6.0`, `lodash.uniq@4.5.0`, `longest-streak@3.1.0`, `loose-envify@1.4.0`, `markdown-it@14.3.0`, `markdown-table@3.0.4`, `marked@17.0.5`, `matcher@4.0.0`, `math-intrinsics@1.1.0`, `mdast-util-find-and-replace@3.0.2`, `mdast-util-from-markdown@2.0.3`, `mdast-util-gfm-autolink-literal@2.0.1`, `mdast-util-gfm-footnote@2.1.0`, `mdast-util-gfm-strikethrough@2.0.0`, `mdast-util-gfm-table@2.0.0`, `mdast-util-gfm-task-list-item@2.0.0`, `mdast-util-gfm@3.1.0`, `mdast-util-math@3.0.0`, `mdast-util-mdx-expression@2.0.1`, `mdast-util-mdx-jsx@3.2.0`, `mdast-util-mdxjs-esm@2.0.1`, `mdast-util-phrasing@4.1.0`, `mdast-util-to-hast@13.2.1`, `mdast-util-to-markdown@2.1.2`, `mdast-util-to-string@4.0.0`, `mdurl@2.0.0`, `media-typer@0.3.0`, `merge-descriptors@1.0.3`, `methods@1.1.2`, `micromark-core-commonmark@2.0.3`, `micromark-extension-gfm-autolink-literal@2.1.0`, `micromark-extension-gfm-footnote@2.1.0`, `micromark-extension-gfm-strikethrough@2.1.0`, `micromark-extension-gfm-table@2.1.1`, `micromark-extension-gfm-tagfilter@2.0.0`, `micromark-extension-gfm-task-list-item@2.1.0`, `micromark-extension-gfm@3.0.0`, `micromark-extension-math@3.1.0`, `micromark-factory-destination@2.0.1`, `micromark-factory-label@2.0.1`, `micromark-factory-space@2.0.1`, `micromark-factory-title@2.0.1`, `micromark-factory-whitespace@2.0.1`, `micromark-util-character@2.1.1`, `micromark-util-chunked@2.0.1`, `micromark-util-classify-character@2.0.1`, `micromark-util-combine-extensions@2.0.1`, `micromark-util-decode-numeric-character-reference@2.0.2`, `micromark-util-decode-string@2.0.1`, `micromark-util-encode@2.0.1`, `micromark-util-html-tag-name@2.0.1`, `micromark-util-normalize-identifier@2.0.1`, `micromark-util-resolve-all@2.0.1`, `micromark-util-sanitize-uri@2.0.1`, `micromark-util-subtokenize@2.1.0`, `micromark-util-symbol@2.0.1`, `micromark-util-types@2.0.2`, `micromark@4.0.2`, `mime-db@1.52.0`, `mime-types@2.1.35`, `mime@1.6.0`, `mimic-response@3.1.0`, `minimist@1.2.8`, `mkdirp-classic@0.5.3`, `mkdirp@0.5.6`, `ms@2.1.3`, `multer@1.4.5-lts.2`, `nanoid@5.1.11`, `napi-build-utils@2.0.0`, `negotiator@0.6.3`, `next@16.2.12`, `nextjs-toploader@3.9.17`, `node-abi@3.90.0`, `node-domexception@1.0.0`, `node-fetch@3.3.2`, `normalize-path@3.0.0`, `nprogress@0.2.0`, `object-assign@4.1.1`, `object-inspect@1.13.4`, `object-keys@1.1.1`, `on-finished@2.4.1`, `onnxruntime-common@1.27.0`, `onnxruntime-node@1.27.0`, `orderedmap@2.1.1`, `p-retry@4.6.2`, `parse-entities@4.0.2`, `parse5@7.3.0`, `parseley@0.12.1`, `parseurl@1.3.3`, `path-expression-matcher@1.6.2`, `path-is-absolute@1.0.1`, `path-to-regexp@0.1.13`, `pdf-lib@1.17.1`, `peberminta@0.9.0`, `postcss@8.5.25`, `prebuild-install@7.1.3`, `prettier@3.8.3`, `process-nextick-args@2.0.1`, `prop-types@15.8.1`, `property-information@7.1.0`, `prosemirror-changeset@2.4.1`, `prosemirror-collab@1.3.1`, `prosemirror-commands@1.7.1`, `prosemirror-dropcursor@1.8.2`, `prosemirror-gapcursor@1.4.1`, `prosemirror-history@1.5.0`, `prosemirror-inputrules@1.5.1`, `prosemirror-keymap@1.2.3`, `prosemirror-markdown@1.13.4`, `prosemirror-menu@1.3.1`, `prosemirror-model@1.25.4`, `prosemirror-schema-basic@1.2.4`, `prosemirror-schema-list@1.5.1`, `prosemirror-state@1.4.4`, `prosemirror-tables@1.8.5`, `prosemirror-trailing-node@3.0.0`, `prosemirror-transform@1.12.0`, `prosemirror-view@1.41.8`, `proxy-addr@2.0.7`, `pump@3.0.4`, `punycode.js@2.3.1`, `range-parser@1.2.1`, `raw-body@2.5.3`, `react-dom@19.2.5`, `react-is@16.13.1`, `react-markdown@10.1.0`, `react-promise-suspense@0.3.4`, `react-redux@9.2.0`, `react-remove-scroll-bar@2.3.8`, `react-remove-scroll@2.7.2`, `react-style-singleton@2.2.3`, `react@19.2.5`, `readable-stream@3.6.2`, `recharts@3.8.1`, `redux-thunk@3.1.0`, `redux@5.0.1`, `refractor@5.0.0`, `rehype-attr@4.0.2`, `rehype-autolink-headings@7.1.0`, `rehype-ignore@2.0.3`, `rehype-katex@7.0.1`, `rehype-parse@9.0.1`, `rehype-prism-plus@2.0.2`, `rehype-raw@7.0.0`, `rehype-rewrite@4.0.4`, `rehype-slug@6.0.0`, `rehype-stringify@10.0.1`, `rehype@13.0.2`, `remark-gfm-configurable@1.0.0`, `remark-gfm@4.0.1`, `remark-github-blockquote-alert@1.3.1`, `remark-math@6.0.0`, `remark-parse@11.0.0`, `remark-rehype@11.1.2`, `remark-stringify@11.0.0`, `reselect@5.1.1`, `resend@4.8.0`, `retry@0.13.1`, `rope-sequence@1.3.4`, `safe-buffer@5.2.1`, `safer-buffer@2.1.2`, `scheduler@0.27.0`, `selderee@0.11.0`, `send@0.19.2`, `serialize-error@8.1.0`, `serve-static@1.16.3`, `setimmediate@1.0.5`, `side-channel-list@1.0.1`, `side-channel-map@1.0.1`, `side-channel-weakmap@1.0.2`, `side-channel@1.1.1`, `simple-concat@1.0.1`, `simple-get@4.0.1`, `space-separated-tokens@2.0.2`, `statuses@2.0.2`, `streamsearch@1.1.0`, `string_decoder@1.1.1`, `stringify-entities@4.0.4`, `strip-json-comments@2.0.1`, `strnum@2.2.3`, `style-to-js@1.1.21`, `style-to-object@1.0.14`, `styled-jsx@5.1.6`, `tailwind-merge@3.5.0`, `tar-fs@2.1.4`, `tar-stream@2.2.0`, `tiny-invariant@1.3.3`, `tiptap-markdown@0.9.0`, `tmp@0.2.7`, `toidentifier@1.0.1`, `trim-lines@3.0.1`, `trough@2.2.0`, `ts-algebra@2.0.0`, `type-is@1.6.18`, `typedarray@0.0.6`, `uc.micro@2.1.0`, `underscore@1.13.8`, `undici-types@6.21.0`, `unified@11.0.5`, `unist-util-filter@5.0.1`, `unist-util-find-after@5.0.0`, `unist-util-is@6.0.1`, `unist-util-position@5.0.0`, `unist-util-remove-position@5.0.0`, `unist-util-stringify-position@4.0.0`, `unist-util-visit-parents@6.0.2`, `unist-util-visit@5.0.0`, `unpipe@1.0.0`, `unzipper@0.10.14`, `use-callback-ref@1.3.3`, `use-sidecar@1.1.3`, `use-sync-external-store@1.6.0`, `util-deprecate@1.0.2`, `utils-merge@1.0.1`, `uuid@11.1.1`, `vary@1.1.2`, `vfile-location@5.0.3`, `vfile-message@4.0.3`, `vfile@6.0.3`, `w3c-keyname@2.2.8`, `web-namespaces@2.0.1`, `web-streams-polyfill@3.3.3`, `ws@8.21.0`, `xml-js@1.6.11`, `xml-naming@0.3.0`, `xml@1.0.1`, `xmlbuilder@10.1.1`, `xmlchars@2.2.0`, `xtend@4.0.2`, `zip-stream@4.1.1`, `zod@4.4.3`, `zwitch@2.0.4`

</details>

<details>
<summary>ISC (36)</summary>

`@ungap/structured-clone@1.3.0`, `boolbase@1.0.0`, `chownr@1.1.4`, `d3-array@3.2.4`, `d3-color@3.1.0`, `d3-format@3.1.2`, `d3-interpolate@3.0.1`, `d3-path@3.1.0`, `d3-scale@4.0.2`, `d3-shape@3.2.0`, `d3-time-format@4.1.0`, `d3-time@3.1.0`, `d3-timer@3.0.1`, `fs.realpath@1.0.0`, `fstream@1.0.12`, `github-slugger@2.0.0`, `glob@7.2.3`, `graceful-fs@4.2.11`, `hast-util-from-dom@5.0.1`, `inflight@1.0.6`, `inherits@2.0.4`, `ini@1.3.8`, `internmap@2.0.3`, `listenercount@1.0.1`, `lucide-react@0.553.0`, `markdown-it-task-lists@2.1.1`, `minimalistic-assert@1.0.1`, `minimatch@3.1.5`, `once@1.4.0`, `parse-numeric-range@1.3.0`, `picocolors@1.1.1`, `rimraf@2.7.1`, `saxes@5.0.1`, `semver@7.7.4`, `setprototypeof@1.2.0`, `wrappy@1.0.2`

</details>

<details>
<summary>Apache-2.0 (33)</summary>

`@google/genai@1.52.0`, `@img/sharp-darwin-arm64@0.34.5`, `@img/sharp-darwin-x64@*`, `@img/sharp-linux-arm64@*`, `@img/sharp-linux-arm@*`, `@img/sharp-linux-ppc64@*`, `@img/sharp-linux-riscv64@*`, `@img/sharp-linux-s390x@*`, `@img/sharp-linux-x64@*`, `@img/sharp-linuxmusl-arm64@*`, `@img/sharp-linuxmusl-x64@*`, `@img/sharp-wasm32@*`, `@img/sharp-win32-arm64@*`, `@img/sharp-win32-ia32@*`, `@img/sharp-win32-x64@*`, `@openrouter/sdk@0.3.16`, `@swc/helpers@0.5.15`, `baseline-browser-mapping@2.10.43`, `class-variance-authority@0.7.1`, `crc-32@1.2.2`, `detect-libc@2.1.2`, `docx-preview@0.3.7`, `ecdsa-sig-formatter@1.0.11`, `fast-diff@1.3.0`, `gaxios@7.1.4`, `gcp-metadata@8.1.2`, `google-auth-library@10.6.2`, `google-logging-utils@1.1.3`, `long@5.3.2`, `pdfjs-dist@4.10.38`, `readdir-glob@1.1.3`, `sharp@0.34.5`, `tunnel-agent@0.6.0`

</details>

<details>
<summary>BSD-3-Clause (18)</summary>

`@protobufjs/aspromise@1.1.2`, `@protobufjs/base64@1.1.2`, `@protobufjs/codegen@2.0.5`, `@protobufjs/eventemitter@1.1.1`, `@protobufjs/fetch@1.1.1`, `@protobufjs/float@1.0.2`, `@protobufjs/path@1.1.2`, `@protobufjs/pool@1.1.0`, `@protobufjs/utf8@1.1.1`, `buffer-equal-constant-time@1.0.1`, `d3-ease@3.0.1`, `duplexer2@0.1.4`, `global-agent@4.1.3`, `ieee754@1.2.1`, `protobufjs@7.6.5`, `qs@6.15.3`, `source-map-js@1.2.1`, `sprintf-js@1.0.3`

</details>

<details>
<summary>BSD-2-Clause (10)</summary>

`dingbat-to-unicode@1.0.1`, `domelementtype@2.3.0`, `domhandler@5.0.3`, `domutils@3.2.2`, `dotenv@17.4.2`, `entities@4.5.0`, `lop@0.4.2`, `mammoth@1.12.0`, `nth-check@2.1.1`, `option@0.2.4`

</details>

<details>
<summary>LGPL-3.0-or-later (10)</summary>

`@img/sharp-libvips-darwin-arm64@1.2.4`, `@img/sharp-libvips-darwin-x64@*`, `@img/sharp-libvips-linux-arm64@*`, `@img/sharp-libvips-linux-arm@*`, `@img/sharp-libvips-linux-ppc64@*`, `@img/sharp-libvips-linux-riscv64@*`, `@img/sharp-libvips-linux-s390x@*`, `@img/sharp-libvips-linux-x64@*`, `@img/sharp-libvips-linuxmusl-arm64@*`, `@img/sharp-libvips-linuxmusl-x64@*`

</details>

<details>
<summary>UNKNOWN (7)</summary>

`@modelcontextprotocol/sdk@*`, `@opentelemetry/api@*`, `@playwright/test@*`, `buffers@0.1.1`, `bufferutil@*`, `sass@*`, `utf-8-validate@*`

</details>

<details>
<summary>MIT/X11 (2)</summary>

`chainsaw@0.1.0`, `traverse@0.3.9`

</details>

<details>
<summary>(BSD-2-Clause OR MIT OR Apache-2.0) (1)</summary>

`rc@1.2.8`

</details>

<details>
<summary>(MIT AND Zlib) (1)</summary>

`pako@1.0.11`

</details>

<details>
<summary>(MIT OR CC0-1.0) (1)</summary>

`type-fest@0.20.2`

</details>

<details>
<summary>(MIT OR GPL-3.0-or-later) (1)</summary>

`jszip@3.10.1`

</details>

<details>
<summary>(MIT OR WTFPL) (1)</summary>

`expand-template@2.0.3`

</details>

<details>
<summary>0BSD (1)</summary>

`tslib@1.14.1`

</details>

<details>
<summary>BlueOak-1.0.0 (1)</summary>

`sax@1.6.0`

</details>

<details>
<summary>BSD (1)</summary>

`duck@0.1.12`

</details>

<details>
<summary>CC-BY-4.0 (1)</summary>

`caniuse-lite@1.0.30001805`

</details>

<details>
<summary>MIT AND ISC (1)</summary>

`victory-vendor@37.3.6`

</details>

<details>
<summary>Unlicense (1)</summary>

`big-integer@1.6.52`

</details>

---

*The npm sections of this file are generated by `npm run notices`.*
