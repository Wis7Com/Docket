import fs from "fs/promises";
import type {
  createCanvas as CreateCanvas,
  loadImage as LoadImage,
  SKRSContext2D,
} from "@napi-rs/canvas";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { ensurePaddleModelFiles } from "./modelDownloader";
import type {
  OcrEngine,
  OcrImage,
  OcrLanguages,
  OcrRegion,
  OcrResult,
} from "./types";

type PaddleLanguage = "korean" | "english";
type Box = { x1: number; y1: number; x2: number; y2: number; score: number };

export class PaddleLanguageSelector {
  private autoLanguage: PaddleLanguage = "korean";
  private observed = false;

  constructor(private readonly setting: OcrLanguages) {}

  languageForPage(): PaddleLanguage {
    if (this.setting === "english") return "english";
    if (this.setting === "korean+english") return "korean";
    return this.autoLanguage;
  }

  observeFirstPage(text: string): void {
    if (this.setting !== "auto" || this.observed) return;
    this.observed = true;
    this.autoLanguage = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(text)
      ? "korean"
      : "english";
  }
}

export function ctcGreedyDecode(
  logits: Float32Array,
  sequenceLength: number,
  classCount: number,
  dictionary: string[],
): { text: string; confidence: number } {
  const characters: string[] = [];
  const scores: number[] = [];
  let previous = -1;
  for (let step = 0; step < sequenceLength; step += 1) {
    const offset = step * classCount;
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      const score = logits[offset + classIndex];
      if (score > bestScore) {
        bestScore = score;
        bestIndex = classIndex;
      }
    }
    if (bestIndex !== 0 && bestIndex !== previous) {
      const character = dictionary[bestIndex - 1];
      if (character !== undefined) {
        characters.push(character);
        scores.push(bestScore);
      }
    }
    previous = bestIndex;
  }
  return {
    text: characters.join(""),
    confidence:
      scores.length === 0
        ? 0
        : scores.reduce((sum, score) => sum + score, 0) / scores.length,
  };
}

function parseYamlScalar(raw: string): string {
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return JSON.parse(raw) as string;
  }
  return raw === "\\" ? "\\" : raw;
}

export function parseCharacterDictionary(config: string): string[] {
  const start = config.indexOf("  character_dict:\n");
  if (start < 0) throw new Error("PaddleOCR character dictionary is missing");
  const dictionary: string[] = [];
  const lines = config.slice(start + "  character_dict:\n".length).split("\n");
  for (const line of lines) {
    const match = /^  -(?: (.*))?$/.exec(line);
    if (!match) {
      if (line.trim() && !line.startsWith("  ")) break;
      continue;
    }
    dictionary.push(parseYamlScalar(match[1] ?? ""));
  }
  if (dictionary.length === 0) {
    throw new Error("PaddleOCR character dictionary is empty");
  }
  if (/^  use_space_char:\s*true\s*$/m.test(config)) dictionary.push(" ");
  return dictionary;
}

function drawResized(
  createCanvas: typeof CreateCanvas,
  source: Awaited<ReturnType<typeof LoadImage>>,
  width: number,
  height: number,
): SKRSContext2D {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "rgb(127,127,127)";
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  return context;
}

function chwFromContext(
  context: SKRSContext2D,
  width: number,
  height: number,
  mode: "detection" | "recognition",
): Float32Array {
  const rgba = context.getImageData(0, 0, width, height).data;
  const plane = width * height;
  const tensor = new Float32Array(plane * 3);
  const means = mode === "detection" ? [0.485, 0.456, 0.406] : [0.5, 0.5, 0.5];
  const stds = mode === "detection" ? [0.229, 0.224, 0.225] : [0.5, 0.5, 0.5];
  for (let index = 0; index < plane; index += 1) {
    // Paddle's DecodeImage uses BGR, while Canvas exposes RGBA.
    const channels = [rgba[index * 4 + 2], rgba[index * 4 + 1], rgba[index * 4]];
    for (let channel = 0; channel < 3; channel += 1) {
      tensor[channel * plane + index] =
        (channels[channel] / 255 - means[channel]) / stds[channel];
    }
  }
  return tensor;
}

function connectedBoxes(
  probabilities: Float32Array,
  width: number,
  height: number,
  scaleX: number,
  scaleY: number,
  originalWidth: number,
  originalHeight: number,
): Box[] {
  const visited = new Uint8Array(width * height);
  const boxes: Box[] = [];
  const queue = new Int32Array(width * height);
  for (let start = 0; start < probabilities.length; start += 1) {
    if (visited[start] || probabilities[start] <= 0.3) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      area += 1;
      const neighbors = [current - 1, current + 1, current - width, current + width];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= probabilities.length || visited[neighbor]) continue;
        const nx = neighbor % width;
        const ny = Math.floor(neighbor / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        if (probabilities[neighbor] <= 0.3) continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
    if (area < 16) continue;
    const marginX = Math.max((maxX - minX) * 0.1, 2);
    const marginY = Math.max((maxY - minY) * 0.1, 2);
    const left = Math.max(0, Math.floor(minX - marginX));
    const top = Math.max(0, Math.floor(minY - marginY));
    const right = Math.min(width - 1, Math.ceil(maxX + marginX));
    const bottom = Math.min(height - 1, Math.ceil(maxY + marginY));
    let score = 0;
    let count = 0;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        score += probabilities[y * width + x];
        count += 1;
      }
    }
    score /= count || 1;
    if (score < 0.6) continue;
    const box = {
      x1: Math.max(0, left / scaleX),
      y1: Math.max(0, top / scaleY),
      x2: Math.min(originalWidth - 1, right / scaleX),
      y2: Math.min(originalHeight - 1, bottom / scaleY),
      score,
    };
    if (box.x2 - box.x1 >= 3 && box.y2 - box.y1 >= 3) boxes.push(box);
  }
  boxes.sort((a, b) => {
    const threshold = Math.min(a.y2 - a.y1, b.y2 - b.y1) * 0.5;
    return Math.abs(a.y1 - b.y1) < threshold ? a.x1 - b.x1 : a.y1 - b.y1;
  });
  return boxes;
}

export class PaddleOcrEngine implements OcrEngine {
  readonly name = "paddle-ppocrv5";
  private detectionSession?: InferenceSession;
  private recognition = new Map<
    PaddleLanguage,
    { session: InferenceSession; dictionary: string[] }
  >();
  private unavailableError: Error | null = null;
  private readonly selector: PaddleLanguageSelector;

  constructor(languages: OcrLanguages = "auto") {
    this.selector = new PaddleLanguageSelector(languages);
  }

  private async runtime() {
    return import("onnxruntime-node");
  }

  private async resources(language: PaddleLanguage) {
    if (this.unavailableError) throw this.unavailableError;
    try {
      const ort = await this.runtime();
      const files = await ensurePaddleModelFiles(language);
      this.detectionSession ??= await ort.InferenceSession.create(files.detection, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        intraOpNumThreads: Math.max(2, Math.min(4, navigatorHardwareConcurrency())),
      });
      let recognition = this.recognition.get(language);
      if (!recognition) {
        recognition = {
          session: await ort.InferenceSession.create(files.recognition, {
            executionProviders: ["cpu"],
            graphOptimizationLevel: "all",
            intraOpNumThreads: Math.max(2, Math.min(4, navigatorHardwareConcurrency())),
          }),
          dictionary: parseCharacterDictionary(await fs.readFile(files.config, "utf8")),
        };
        this.recognition.set(language, recognition);
      }
      return { ort, detection: this.detectionSession, recognition };
    } catch (err) {
      this.unavailableError =
        err instanceof Error ? err : new Error(String(err));
      throw this.unavailableError;
    }
  }

  async recognize(image: OcrImage): Promise<OcrResult> {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const source = await loadImage(Buffer.from(image.data));
    const language = this.selector.languageForPage();
    const { ort, detection, recognition } = await this.resources(language);
    const ratio = Math.min(1, 960 / Math.max(source.width, source.height));
    const width = Math.max(32, Math.ceil((source.width * ratio) / 32) * 32);
    const height = Math.max(32, Math.ceil((source.height * ratio) / 32) * 32);
    const detContext = drawResized(createCanvas, source, width, height);
    const detInput = new ort.Tensor(
      "float32",
      chwFromContext(detContext, width, height, "detection"),
      [1, 3, height, width],
    );
    const detOutput = await detection.run({ [detection.inputNames[0]]: detInput });
    const detTensor = detOutput[detection.outputNames[0]] as Tensor;
    const probabilities = detTensor.data as Float32Array;
    const boxes = connectedBoxes(
      probabilities,
      width,
      height,
      width / source.width,
      height / source.height,
      source.width,
      source.height,
    );

    const regions: OcrRegion[] = [];
    for (const box of boxes) {
      const cropWidth = Math.max(1, Math.ceil(box.x2 - box.x1));
      const cropHeight = Math.max(1, Math.ceil(box.y2 - box.y1));
      const aspect = cropWidth / cropHeight;
      const recWidth = Math.max(48, Math.min(320, Math.ceil(48 * aspect)));
      const cropCanvas = createCanvas(recWidth, 48);
      const context = cropCanvas.getContext("2d");
      context.fillStyle = "rgb(127,127,127)";
      context.fillRect(0, 0, recWidth, 48);
      const scaledWidth = Math.min(recWidth, Math.max(1, Math.ceil(48 * aspect)));
      context.drawImage(
        source,
        box.x1,
        box.y1,
        cropWidth,
        cropHeight,
        0,
        0,
        scaledWidth,
        48,
      );
      const recInput = new ort.Tensor(
        "float32",
        chwFromContext(context, recWidth, 48, "recognition"),
        [1, 3, 48, recWidth],
      );
      const output = await recognition.session.run({
        [recognition.session.inputNames[0]]: recInput,
      });
      const tensor = output[recognition.session.outputNames[0]] as Tensor;
      const dimensions = tensor.dims.map(Number);
      if (dimensions.length !== 3) throw new Error("Unexpected Paddle OCR output");
      const decoded = ctcGreedyDecode(
        tensor.data as Float32Array,
        dimensions[1],
        dimensions[2],
        recognition.dictionary,
      );
      if (!decoded.text.trim()) continue;
      regions.push({
        text: decoded.text,
        confidence: decoded.confidence,
        bbox: {
          x: box.x1 / source.width,
          y: box.y1 / source.height,
          width: (box.x2 - box.x1) / source.width,
          height: (box.y2 - box.y1) / source.height,
        },
      });
    }
    const text = regions.map((region) => region.text).join("\n");
    this.selector.observeFirstPage(text);
    return {
      text,
      regions,
      confidence:
        regions.length === 0
          ? 0
          : regions.reduce((sum, region) => sum + region.confidence, 0) /
            regions.length,
    };
  }
}

function navigatorHardwareConcurrency(): number {
  return typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2;
}
