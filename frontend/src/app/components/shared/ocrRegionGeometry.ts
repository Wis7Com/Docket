import type { PdfAnnotationRect } from "./types";

export type NormalizedOcrBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const stable = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function normalizedOcrRegionToPdfRect(
  box: NormalizedOcrBox,
  page: number,
  size: { width: number; height: number },
): PdfAnnotationRect {
  const left = clamp(box.x);
  const top = clamp(box.y);
  const right = clamp(box.x + box.width);
  const bottom = clamp(box.y + box.height);
  return {
    page,
    x: stable(left * size.width),
    y: stable((1 - bottom) * size.height),
    width: stable(Math.max(0, right - left) * size.width),
    height: stable(Math.max(0, bottom - top) * size.height),
  };
}
