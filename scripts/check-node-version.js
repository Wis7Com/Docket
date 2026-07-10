#!/usr/bin/env node
// Enforces the Node policy from package.json "engines" (>=20 <25) before
// any build/dev pipeline runs. Node 26 loads yargs' extensionless CJS
// entry as ESM and crashes @electron/rebuild mid-build; failing here keeps
// the error at the front of the pipeline with an actionable message.
// Keep the range in sync with "engines" in package.json and .nvmrc.
const major = Number(process.versions.node.split(".")[0]);

if (major >= 20 && major < 25) {
  process.exit(0);
}

console.error(
  [
    `[check-node] Node ${process.version} (${process.execPath}) is not supported — this project needs >=20 <25 (even-numbered LTS).`,
    "[check-node] Node 26 breaks @electron/rebuild: yargs' extensionless CJS entry is loaded as ESM.",
    "[check-node] Use the pinned Node 22 instead, e.g.:",
    "[check-node]   PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run <script>",
    "[check-node] or activate it via your version manager (pinned in .nvmrc / .node-version):",
    "[check-node]   nvm use   |   mise use   |   fnm use",
  ].join("\n"),
);
process.exit(1);
