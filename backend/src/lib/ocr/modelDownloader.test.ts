import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { downloadModelFile, sha256File } from "./modelDownloader";

test("model downloader verifies SHA-256 before atomically installing a file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "docket-ocr-model-"));
  const destination = path.join(root, "model.onnx");
  const bytes = Buffer.from("verified model bytes");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  let fetches = 0;

  try {
    const downloaded = await downloadModelFile(
      { url: "https://models.invalid/model.onnx", sha256, destination },
      {
        fetchImpl: async () => {
          fetches += 1;
          return new Response(bytes);
        },
      },
    );
    assert.equal(downloaded, true);
    assert.equal(fetches, 1);
    assert.equal(await sha256File(destination), sha256);

    const reused = await downloadModelFile(
      { url: "https://models.invalid/model.onnx", sha256, destination },
      {
        fetchImpl: async () => {
          throw new Error("valid cached models must not be downloaded again");
        },
      },
    );
    assert.equal(reused, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("model downloader removes partial files after a hash mismatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "docket-ocr-model-"));
  const destination = path.join(root, "model.onnx");
  try {
    await assert.rejects(
      downloadModelFile(
        {
          url: "https://models.invalid/model.onnx",
          sha256: "0".repeat(64),
          destination,
        },
        { fetchImpl: async () => new Response("tampered") },
      ),
      /SHA-256/i,
    );
    await assert.rejects(fs.stat(destination));
    await assert.rejects(fs.stat(`${destination}.part`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
