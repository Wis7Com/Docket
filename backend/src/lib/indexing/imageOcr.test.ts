import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import type { OcrEngine, OcrImage } from "../ocr/types";
import { extractStructuredTextFromBytes } from "./extractors";

test("image extraction OCRs one page and preserves normalized regions", async () => {
  const canvas = createCanvas(320, 180);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);

  let received: OcrImage | null = null;
  const engine: OcrEngine = {
    name: "fixture-local-ocr",
    async recognize(image) {
      received = image;
      return {
        text: "서비스 계약서\n손해배상 책임",
        confidence: 0.94,
        regions: [
          {
            text: "서비스 계약서",
            confidence: 0.96,
            bbox: { x: 0.1, y: 0.12, width: 0.42, height: 0.1 },
          },
          {
            text: "손해배상 책임",
            confidence: 0.92,
            bbox: { x: 0.1, y: 0.3, width: 0.5, height: 0.1 },
          },
        ],
      };
    },
  };

  const bytes = canvas.toBuffer("image/png");
  const raw = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const extracted = await extractStructuredTextFromBytes(raw, "png", {
    ocrEngine: engine,
  });

  const captured = received as OcrImage | null;
  assert.equal(captured?.width, 320);
  assert.equal(captured?.height, 180);
  assert.equal(extracted.text, "[Page 1]\n서비스 계약서\n손해배상 책임");
  assert.equal(extracted.ocr_pages, 1);
  assert.equal(extracted.ocr_engine, "fixture-local-ocr");
  assert.deepEqual(extracted.ocr_regions, [
    {
      page_number: 1,
      text: "서비스 계약서",
      confidence: 0.96,
      bbox: { x: 0.1, y: 0.12, width: 0.42, height: 0.1 },
    },
    {
      page_number: 1,
      text: "손해배상 책임",
      confidence: 0.92,
      bbox: { x: 0.1, y: 0.3, width: 0.5, height: 0.1 },
    },
  ]);
});

test("image extraction stays empty when local OCR is unavailable", async () => {
  const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
  const extracted = await extractStructuredTextFromBytes(raw, "png");
  assert.equal(extracted.text, "");
  assert.deepEqual(extracted.ocr_regions, []);
});
