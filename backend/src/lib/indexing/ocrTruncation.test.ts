import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import type { OcrEngine, OcrResult } from "../ocr/types";
import { extractStructuredTextFromBytes } from "./extractors";

class FixedOcrEngine implements OcrEngine {
  readonly name = "fixed";
  async recognize(): Promise<OcrResult> {
    return { text: "recognized scan text", confidence: 1, regions: [] };
  }
}

async function rasterPdf(pageCount: number): Promise<ArrayBuffer> {
  const canvas = createCanvas(120, 160);
  const context = canvas.getContext("2d");
  context.fillStyle = "black";
  context.fillRect(10, 10, 100, 20);
  const pdf = await PDFDocument.create();
  const png = await pdf.embedPng(canvas.toBuffer("image/png"));
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage([120, 160]);
    page.drawImage(png, { x: 0, y: 0, width: 120, height: 160 });
  }
  const bytes = await pdf.save();
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

test("OCR coverage reports capped and unlimited scan processing", async () => {
  const raw = await rasterPdf(3);
  const engine = new FixedOcrEngine();
  const capped = await extractStructuredTextFromBytes(raw, "pdf", {
    ocrEngine: engine,
    ocrMaxPages: 2,
  });
  assert.equal(capped.ocr_pages, 2);
  assert.equal(capped.ocr_scanned_pages, 3);
  assert.equal(capped.ocr_truncated, true);

  const explicitlyCappedSmallScan = await extractStructuredTextFromBytes(
    await rasterPdf(3),
    "pdf",
    {
      ocrEngine: engine,
      ocrMaxPages: 2,
      deferLargeScans: true,
    },
  );
  assert.equal(explicitlyCappedSmallScan.ocr_pages, 2);
  assert.equal(explicitlyCappedSmallScan.ocr_scanned_pages, 3);
  assert.equal(explicitlyCappedSmallScan.ocr_truncated, true);

  const unlimited = await extractStructuredTextFromBytes(
    await rasterPdf(3),
    "pdf",
    {
    ocrEngine: engine,
    ocrMaxPages: 0,
    },
  );
  assert.equal(unlimited.ocr_pages, 3);
  assert.equal(unlimited.ocr_scanned_pages, 3);
  assert.equal(unlimited.ocr_truncated, false);
});
