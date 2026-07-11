export type OcrMode = "local_cpu" | "local_gpu" | "external_api";
export type OcrEnginePreference = "auto" | "vision" | "paddle";
export type OcrLanguages = "auto" | "korean+english" | "english";

export type OcrBoundingBox = {
  /** Normalized, top-left-origin coordinates in the range 0..1. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OcrRegion = {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
};

export type OcrResult = {
  text: string;
  regions: OcrRegion[];
  confidence: number;
};

export type OcrImage = {
  data: Uint8Array;
  width: number;
  height: number;
  format?: "png" | "jpg" | "jpeg" | "tiff" | "bmp" | "webp";
};

export interface OcrEngine {
  readonly name: string;
  recognize(image: OcrImage): Promise<OcrResult>;
}

export type OcrSettings = {
  enabled: boolean;
  mode: OcrMode;
  engine: OcrEnginePreference;
  languages: OcrLanguages;
  maxPagesPerDocument: number;
  gpuEndpoint: string | null;
  externalProvider: string | null;
};
