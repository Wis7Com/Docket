import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { appDataPath } from "../../db/sqlite";

const MAX_MODEL_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export type ModelFileSpec = {
  url: string;
  sha256: string;
  destination: string;
};

type DownloadOptions = {
  fetchImpl?: typeof fetch;
};

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function existingFileIsValid(spec: ModelFileSpec): Promise<boolean> {
  try {
    if ((await sha256File(spec.destination)) === spec.sha256) return true;
    await fsp.rm(spec.destination, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return false;
}

export async function downloadModelFile(
  spec: ModelFileSpec,
  options: DownloadOptions = {},
): Promise<boolean> {
  if (await existingFileIsValid(spec)) return false;

  await fsp.mkdir(path.dirname(spec.destination), { recursive: true });
  const partial = `${spec.destination}.part`;
  await fsp.rm(partial, { force: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await (options.fetchImpl ?? fetch)(spec.url, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`OCR model download failed (${response.status})`);
    }
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > MAX_MODEL_BYTES) {
      throw new Error(`OCR model exceeds ${MAX_MODEL_BYTES} bytes`);
    }

    const body = response.body?.getReader();
    if (!body) throw new Error("OCR model response had no body");
    const handle = await fsp.open(partial, "w", 0o600);
    const hash = crypto.createHash("sha256");
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await body.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MODEL_BYTES) {
          throw new Error(`OCR model exceeds ${MAX_MODEL_BYTES} bytes`);
        }
        hash.update(value);
        await handle.write(value);
      }
    } finally {
      await handle.close();
    }

    const actual = hash.digest("hex");
    if (actual !== spec.sha256) {
      throw new Error(
        `OCR model SHA-256 mismatch: expected ${spec.sha256}, got ${actual}`,
      );
    }
    await fsp.rename(partial, spec.destination);
    return true;
  } catch (err) {
    await fsp.rm(partial, { force: true });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

const HF = "https://huggingface.co/PaddlePaddle";

export const PADDLE_MODEL_FILES = {
  detection: {
    fileName: "det.onnx",
    url: `${HF}/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx`,
    sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
  },
  koreanModel: {
    fileName: "rec-korean.onnx",
    url: `${HF}/korean_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx`,
    sha256: "92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08",
  },
  koreanConfig: {
    fileName: "rec-korean.yml",
    url: `${HF}/korean_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml`,
    sha256: "f757fa1c40e99edcf27e9cce879b93eb2a51fa46f5ef39095689b8c37dd75998",
  },
  englishModel: {
    fileName: "rec-english.onnx",
    url: `${HF}/en_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx`,
    sha256: "b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f",
  },
  englishConfig: {
    fileName: "rec-english.yml",
    url: `${HF}/en_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml`,
    sha256: "27e91d0582f40168aa218303c76e184bc78fa7a5d105aad0cfbad8458b441067",
  },
} as const;

export function paddleModelsDirectory(): string {
  return path.join(appDataPath(), "models", "paddleocr-v5");
}

export async function ensurePaddleModelFiles(
  language: "korean" | "english",
): Promise<{ detection: string; recognition: string; config: string }> {
  const dir = paddleModelsDirectory();
  const languageSpecs =
    language === "korean"
      ? [PADDLE_MODEL_FILES.koreanModel, PADDLE_MODEL_FILES.koreanConfig]
      : [PADDLE_MODEL_FILES.englishModel, PADDLE_MODEL_FILES.englishConfig];
  const specs = [PADDLE_MODEL_FILES.detection, ...languageSpecs].map((item) => ({
    url: item.url,
    sha256: item.sha256,
    destination: path.join(dir, item.fileName),
  }));
  await Promise.all(specs.map((spec) => downloadModelFile(spec)));
  return {
    detection: specs[0].destination,
    recognition: specs[1].destination,
    config: specs[2].destination,
  };
}
