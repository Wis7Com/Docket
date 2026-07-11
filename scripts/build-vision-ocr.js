#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

if (process.platform !== "darwin") process.exit(0);

const root = path.join(__dirname, "..");
const source = path.join(root, "native", "macos-vision-ocr", "main.swift");
const output = path.join(
  root,
  "native",
  "macos-vision-ocr",
  "docket-vision-ocr",
);
const result = spawnSync(
  "xcrun",
  ["swiftc", "-O", "-target", `${process.arch}-apple-macos13.0`, source, "-o", output],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
fs.chmodSync(output, 0o755);
