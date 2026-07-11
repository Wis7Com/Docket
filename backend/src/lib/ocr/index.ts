import { PaddleOcrEngine } from "./paddleOcr";
import type { OcrEngine, OcrImage, OcrResult, OcrSettings } from "./types";
import { resolveVisionHelperPath, VisionOcrEngine } from "./visionOcr";

class LocalFallbackEngine implements OcrEngine {
  private activeName: string;

  get name(): string {
    return this.activeName;
  }

  constructor(
    private readonly primary: OcrEngine,
    private readonly fallback: () => OcrEngine,
  ) {
    this.activeName = primary.name;
  }

  async recognize(image: OcrImage): Promise<OcrResult> {
    try {
      return await this.primary.recognize(image);
    } catch (err) {
      console.warn(`[ocr] ${this.primary.name} failed; using local Paddle OCR`, err);
      const fallback = this.fallback();
      this.activeName = fallback.name;
      return fallback.recognize(image);
    }
  }
}

/**
 * Phase 1/2 intentionally resolves every configured mode to Tier 1. Tier 2/3
 * fields exist in settings, but no local failure can invoke an external API.
 */
export function createLocalOcrEngine(settings: OcrSettings): OcrEngine {
  const paddle = () => new PaddleOcrEngine(settings.languages);
  const canUseVision = process.platform === "darwin" && resolveVisionHelperPath();
  if (settings.engine === "paddle" || !canUseVision) return paddle();
  return new LocalFallbackEngine(new VisionOcrEngine(canUseVision), paddle);
}

export * from "./types";
