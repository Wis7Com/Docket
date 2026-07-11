import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import type { OcrEngine, OcrImage, OcrResult } from "./types";

function resourcesPath(): string | null {
  return (
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? null
  );
}

export function resolveVisionHelperPath(): string | null {
  const executable = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    process.env.DOCKET_VISION_OCR_BIN,
    resourcesPath()
      ? path.join(resourcesPath()!, "ocr", `docket-vision-ocr${executable}`)
      : undefined,
    path.resolve(process.cwd(), "..", "native", "macos-vision-ocr", "docket-vision-ocr"),
    path.resolve(process.cwd(), "native", "macos-vision-ocr", "docket-vision-ocr"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export class VisionOcrEngine implements OcrEngine {
  readonly name = "apple-vision";

  constructor(private readonly helperPath = resolveVisionHelperPath()) {
    if (!helperPath) throw new Error("Apple Vision OCR helper is unavailable");
  }

  async recognize(image: OcrImage): Promise<OcrResult> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "docket-vision-ocr-"));
    const imagePath = path.join(root, "page.png");
    try {
      await fsp.writeFile(imagePath, image.data, { mode: 0o600 });
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(this.helperPath!, [imagePath], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr.trim() || `Vision OCR exited with ${code}`));
        });
      });
      const parsed = JSON.parse(output) as OcrResult;
      if (typeof parsed.text !== "string" || !Array.isArray(parsed.regions)) {
        throw new Error("Apple Vision OCR returned invalid JSON");
      }
      return parsed;
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }
}
