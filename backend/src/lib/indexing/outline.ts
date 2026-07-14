import path from "path";
import type { OcrEngine } from "../ocr/types";
import type {
  DocumentSectionAnchor,
  StructuredIndexText,
  StructuredTextLine,
} from "./types";

const MAX_HEADING_LENGTH = 180;
const MAX_HEADING_WORDS = 18;
const MAX_SECTION_DEPTH = 6;

type PdfTextItemLike = {
  str?: unknown;
  transform?: unknown;
  height?: unknown;
  fontName?: unknown;
  hasEOL?: unknown;
};

type PdfTextContentLike = {
  items: unknown[];
  styles?: Record<string, { fontFamily?: string } | undefined>;
};

export type ReconstructedPdfPage = {
  text: string;
  lines: Omit<StructuredTextLine, "page_number">[];
};

function normalizeInlineText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function fontSizeOf(item: PdfTextItemLike): number | null {
  const transform = Array.isArray(item.transform)
    ? (item.transform as number[])
    : null;
  const fromTransform = transform
    ? Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0)
    : 0;
  const size = fromTransform || Number(item.height) || 0;
  return Number.isFinite(size) && size > 0 ? size : null;
}

function yOf(item: PdfTextItemLike): number | null {
  const transform = Array.isArray(item.transform)
    ? (item.transform as number[])
    : null;
  const y = transform ? Number(transform[5]) : Number.NaN;
  return Number.isFinite(y) ? y : null;
}

function isBoldFont(
  item: PdfTextItemLike,
  styles: PdfTextContentLike["styles"],
): boolean {
  const fontName = typeof item.fontName === "string" ? item.fontName : "";
  const family = styles?.[fontName]?.fontFamily ?? "";
  return /bold|black|heavy|semibold|demibold|extrabold/i.test(
    `${fontName} ${family}`,
  );
}

/**
 * Reconstructs line metadata without sorting PDF text items. The returned raw
 * text therefore follows content-stream order, matching Docket's historical
 * citation extraction. Coordinates only decide where one line ends.
 */
export function reconstructPdfPageText(
  content: PdfTextContentLike,
): ReconstructedPdfPage {
  type Item = {
    text: string;
    start: number;
    end: number;
    y: number | null;
    size: number | null;
    bold: boolean;
    hasEOL: boolean;
  };

  const items: Item[] = [];
  let text = "";
  for (const raw of content.items) {
    const item = raw as PdfTextItemLike;
    if (typeof item.str !== "string") continue;
    const itemText = normalizeInlineText(item.str);
    if (!itemText) continue;
    if (text) text += " ";
    const start = text.length;
    text += itemText;
    items.push({
      text: itemText,
      start,
      end: text.length,
      y: yOf(item),
      size: fontSizeOf(item),
      bold: isBoldFont(item, content.styles),
      hasEOL: item.hasEOL === true,
    });
  }

  const lines: ReconstructedPdfPage["lines"] = [];
  let lineItems: Item[] = [];

  const flush = () => {
    if (lineItems.length === 0) return;
    const first = lineItems[0];
    const last = lineItems[lineItems.length - 1];
    const sized = lineItems.filter(
      (item): item is Item & { size: number } => item.size !== null,
    );
    const weightedSize = sized.length
      ? sized.reduce((sum, item) => sum + item.size * item.text.length, 0) /
        sized.reduce((sum, item) => sum + item.text.length, 0)
      : null;
    lines.push({
      line_index: lines.length,
      text: text.slice(first.start, last.end),
      start_char: first.start,
      end_char: last.end,
      font_size: weightedSize,
      bold: lineItems.some((item) => item.bold),
    });
    lineItems = [];
  };

  for (const item of items) {
    const previous = lineItems[lineItems.length - 1];
    if (previous) {
      const tolerance = Math.max(
        1.5,
        Math.min(previous.size ?? 8, item.size ?? 8) * 0.25,
      );
      const changedLine =
        previous.hasEOL ||
        (previous.y !== null &&
          item.y !== null &&
          Math.abs(previous.y - item.y) > tolerance);
      if (changedLine) flush();
    }
    lineItems.push(item);
  }
  flush();

  return { text, lines };
}

export function buildPlainTextLines(text: string): StructuredTextLine[] {
  const lines: StructuredTextLine[] = [];
  let pageNumber: number | null = null;
  let lineIndex = 0;

  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const raw = match[0].replace(/\n$/, "");
    if (!raw && (match.index ?? 0) >= text.length) break;
    const pageMatch = /^\s*\[Page\s+(\d+)\]\s*$/i.exec(raw);
    if (pageMatch) {
      pageNumber = Number(pageMatch[1]);
      lineIndex = 0;
      continue;
    }
    const leading = raw.length - raw.trimStart().length;
    const normalized = normalizeInlineText(raw);
    if (!normalized) continue;
    const start = (match.index ?? 0) + leading;
    lines.push({
      page_number: pageNumber,
      line_index: lineIndex,
      text: normalized,
      start_char: start,
      end_char: start + raw.trim().length,
      font_size: null,
      bold: false,
    });
    lineIndex += 1;
  }
  return lines;
}

function isBarePageMarker(text: string): boolean {
  return /^(?:page\s*)?\d{1,5}(?:\s*[/-]\s*\d{1,5})?$/i.test(text);
}

function looksLikeHeadingTitle(text: string): boolean {
  const normalized = normalizeInlineText(text).replace(/[.:;\-–—]+$/, "");
  if (!normalized || normalized.length > MAX_HEADING_LENGTH) return false;
  const words = normalized.split(/\s+/);
  if (words.length > MAX_HEADING_WORDS) return false;
  if (/[.!?。！？]$/.test(text)) return false;
  if (
    /\b(?:is|are|was|were|shall|must|will|may|means|includes|applies|provides|requires|has|have|does|do)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (/(?:합니다|하였다|한다|됩니다|이다|있다|없다)$/u.test(normalized)) {
    return false;
  }
  return true;
}

function parseExplicitHeading(
  value: string,
): { title: string; level: number } | null {
  const text = normalizeInlineText(value);
  const markdown = /^(#{1,6})\s+(.+?)\s*#*$/.exec(text);
  if (markdown && looksLikeHeadingTitle(markdown[2])) {
    return {
      title: normalizeInlineText(markdown[2]),
      level: markdown[1].length,
    };
  }

  const korean =
    /^제?\s*(\d+)\s*(편|장|절|관|조|항)(?:의\s*\d+)?(?:\s*[(:：]?\s*(.*?)\s*[)]?)?$/.exec(
      text,
    );
  if (korean) {
    const tail = normalizeInlineText(korean[3] ?? "");
    if (tail && !looksLikeHeadingTitle(tail)) return null;
    const levelByUnit: Record<string, number> = {
      편: 1,
      장: 2,
      절: 3,
      관: 4,
      조: 5,
      항: 6,
    };
    return { title: text, level: levelByUnit[korean[2]] };
  }

  const named =
    /^(part|chapter|article|section|title|clause|schedule|appendix|annex|exhibit)\s+([\dIVXLCM]+(?:\.\d+)*)(?:\s*[:.\-–—]\s*|\s+)?(.*)$/i.exec(
      text,
    );
  if (named) {
    const tail = normalizeInlineText(named[3] ?? "");
    if (tail && !looksLikeHeadingTitle(tail)) return null;
    const unit = named[1].toLowerCase();
    const baseLevel =
      unit === "part" || unit === "title"
        ? 1
        : unit === "chapter"
          ? 2
          : unit === "article"
            ? 3
            : unit === "section" || unit === "clause"
              ? 4
              : 2;
    return { title: text, level: baseLevel };
  }

  const numbered = /^(\d+(?:\.\d+){0,5})[.)]?\s+(.+)$/.exec(text);
  if (numbered && looksLikeHeadingTitle(numbered[2])) {
    return {
      title: text,
      level: Math.min(numbered[1].split(".").length, MAX_SECTION_DEPTH),
    };
  }

  const roman = /^([IVXLCM]+)[.)]\s+(.+)$/i.exec(text);
  if (roman && looksLikeHeadingTitle(roman[2])) {
    return { title: text, level: 1 };
  }
  return null;
}

function dominantFontSize(lines: StructuredTextLine[]): number | null {
  const weights = new Map<number, number>();
  for (const line of lines) {
    if (line.font_size === null) continue;
    const rounded = Math.round(line.font_size * 2) / 2;
    weights.set(rounded, (weights.get(rounded) ?? 0) + line.text.length);
  }
  let best: { size: number; weight: number } | null = null;
  for (const [size, weight] of weights) {
    if (!best || weight > best.weight) best = { size, weight };
  }
  return best?.size ?? null;
}

function repeatedEdgeTexts(lines: StructuredTextLine[]): Set<string> {
  const pageNumbers = new Set(
    lines
      .map((line) => line.page_number)
      .filter((page): page is number => page !== null),
  );
  if (pageNumbers.size < 2) return new Set();

  const maxIndexByPage = new Map<number, number>();
  for (const line of lines) {
    if (line.page_number === null) continue;
    maxIndexByPage.set(
      line.page_number,
      Math.max(maxIndexByPage.get(line.page_number) ?? 0, line.line_index),
    );
  }

  const pagesByText = new Map<string, Set<number>>();
  for (const line of lines) {
    if (line.page_number === null) continue;
    const maxIndex = maxIndexByPage.get(line.page_number) ?? 0;
    const atEdge = line.line_index <= 1 || line.line_index >= maxIndex - 1;
    if (!atEdge || line.text.length > MAX_HEADING_LENGTH) continue;
    const key = normalizeInlineText(line.text).toLocaleLowerCase();
    const pages = pagesByText.get(key) ?? new Set<number>();
    pages.add(line.page_number);
    pagesByText.set(key, pages);
  }

  const threshold = Math.max(2, Math.ceil(pageNumbers.size * 0.6));
  return new Set(
    [...pagesByText.entries()]
      .filter(([, pages]) => pages.size >= threshold)
      .map(([text]) => text),
  );
}

export function detectDocumentSections(
  text: string,
  suppliedLines?: StructuredTextLine[],
): DocumentSectionAnchor[] {
  const lines = suppliedLines ?? buildPlainTextLines(text);
  if (lines.length === 0) return [];
  const bodySize = dominantFontSize(lines);
  const repeated = repeatedEdgeTexts(lines);
  const headings: Array<StructuredTextLine & { title: string; level: number }> =
    [];

  for (const line of lines) {
    if (
      line.text.length < 2 ||
      line.text.length > MAX_HEADING_LENGTH ||
      isBarePageMarker(line.text) ||
      repeated.has(line.text.toLocaleLowerCase())
    ) {
      continue;
    }

    const explicit = parseExplicitHeading(line.text);
    if (explicit) {
      headings.push({ ...line, ...explicit });
      continue;
    }

    if (bodySize === null || line.font_size === null) continue;
    const ratio = line.font_size / bodySize;
    const styled = ratio >= 1.18 || (line.bold && ratio >= 1.08);
    if (styled && looksLikeHeadingTitle(line.text)) {
      headings.push({
        ...line,
        title: line.text,
        level: ratio >= 1.45 ? 1 : ratio >= 1.25 ? 2 : 3,
      });
    }
  }

  const anchors: DocumentSectionAnchor[] = [];
  const stack = new Map<number, string>();
  for (const heading of headings) {
    const previous = anchors[anchors.length - 1];
    if (
      previous &&
      previous.start_char === heading.start_char &&
      previous.title === heading.title
    ) {
      continue;
    }
    for (const level of [...stack.keys()]) {
      if (level >= heading.level) stack.delete(level);
    }
    stack.set(heading.level, heading.title);
    const hierarchy = [...stack.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, title]) => title)
      .join(" > ");
    const location =
      heading.page_number === null
        ? `offset ${heading.start_char}`
        : `p. ${heading.page_number}`;
    anchors.push({
      page_number: heading.page_number,
      start_char: heading.start_char,
      end_char: heading.end_char,
      level: heading.level,
      title: heading.title,
      path: `${location} · ${hierarchy}`,
    });
  }
  return anchors;
}

export function sectionPathForRange(
  sections: DocumentSectionAnchor[],
  startChar: number,
  endChar: number,
): string | null {
  let active: DocumentSectionAnchor | null = null;
  for (const section of sections) {
    if (section.start_char <= startChar) active = section;
    else break;
  }
  if (!active) {
    active =
      sections.find(
        (section) =>
          section.start_char > startChar && section.start_char < endChar,
      ) ?? null;
  }
  return active?.path ?? null;
}

export function buildChunkSearchText(
  content: string,
  sectionPath: string | null,
): string {
  return sectionPath ? `${sectionPath}\n${content}` : content;
}

export async function extractStructuredPdfText(
  raw: ArrayBuffer,
  options: {
    ocr?: {
      engine: OcrEngine;
      maxPages: number;
      deferLargeScans?: boolean;
    };
  } = {},
): Promise<StructuredIndexText> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const standardFontDataUrl = (() => {
      try {
        const pkgPath = require.resolve("pdfjs-dist/package.json");
        return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
      } catch {
        return undefined;
      }
    })();
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (options: unknown) => {
          promise: Promise<{
            numPages: number;
            getPage: (pageNumber: number) => Promise<{
              getTextContent: () => Promise<PdfTextContentLike>;
              getViewport: (options: { scale: number }) => {
                width: number;
                height: number;
              };
              render: (options: {
                canvasContext: unknown;
                viewport: unknown;
              }) => { promise: Promise<void> };
            }>;
            destroy?: () => Promise<void>;
          }>;
        };
      }
    ).getDocument({
      data: new Uint8Array(raw),
      standardFontDataUrl,
    }).promise;

    const textParts: string[] = [];
    const lines: StructuredTextLine[] = [];
    let globalOffset = 0;
    let ocrAttempts = 0;
    let ocrPages = 0;
    let scannedPagesSeen = 0;
    const ocrRegions: NonNullable<StructuredIndexText["ocr_regions"]> = [];
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        let reconstructed = reconstructPdfPageText(content);
        if (reconstructed.text.trim().length < 10 && options.ocr) {
          scannedPagesSeen += 1;
          const deferred =
            options.ocr.deferLargeScans === true && pdf.numPages > 50;
          // A small scan is processed immediately, but an explicit positive
          // project/user cap still applies. The normal default (100) already
          // covers every page of a <=50-page scan; only zero means unlimited.
          const unlimited = options.ocr.maxPages <= 0;
          if (!deferred && (unlimited || ocrAttempts < options.ocr.maxPages)) {
            ocrAttempts += 1;
            try {
            const baseViewport = page.getViewport({ scale: 1 });
            const dpiScale = 200 / 72;
            const scale = Math.min(
              dpiScale,
              2000 / Math.max(1, baseViewport.width),
            );
            const viewport = page.getViewport({ scale });
            const { createCanvas } = await import("@napi-rs/canvas");
            const canvas = createCanvas(
              Math.max(1, Math.ceil(viewport.width)),
              Math.max(1, Math.ceil(viewport.height)),
            );
            const canvasContext = canvas.getContext("2d");
            await page.render({ canvasContext, viewport }).promise;
            const result = await options.ocr.engine.recognize({
              data: canvas.toBuffer("image/png"),
              width: canvas.width,
              height: canvas.height,
              format: "png",
            });
            ocrPages += 1;
            const text = result.text.normalize("NFC").trim();
            for (const region of result.regions) {
              ocrRegions.push({ ...region, page_number: pageNumber });
            }
            const ocrLines = (
              result.regions.length > 0
                ? result.regions.map((region) => region.text)
                : text.split(/\r?\n/)
            )
              .map(normalizeInlineText)
              .filter(Boolean);
            let offset = 0;
            reconstructed = {
              text,
              lines: ocrLines.map((line, lineIndex) => {
                const start = text.indexOf(line, offset);
                const startChar = start >= 0 ? start : offset;
                offset = startChar + line.length;
                return {
                  line_index: lineIndex,
                  text: line,
                  start_char: startChar,
                  end_char: offset,
                  font_size: null,
                  bold: false,
                };
              }),
            };
            } catch (err) {
              console.warn(`[ocr] page ${pageNumber} failed`, err);
            }
          }
        }
        const pageText = `[Page ${pageNumber}]\n${reconstructed.text}`;
        if (textParts.length > 0) globalOffset += 2;
        const contentOffset = globalOffset + `[Page ${pageNumber}]\n`.length;
        textParts.push(pageText);
        for (const line of reconstructed.lines) {
          lines.push({
            ...line,
            page_number: pageNumber,
            start_char: contentOffset + line.start_char,
            end_char: contentOffset + line.end_char,
          });
        }
        globalOffset += pageText.length;
      }
    } finally {
      await pdf.destroy?.();
    }

    const text = textParts.join("\n\n").trim();
    return {
      text,
      lines,
      sections: detectDocumentSections(text, lines),
      ocr_pages: ocrPages,
      ocr_engine: ocrPages > 0 ? (options.ocr?.engine.name ?? null) : null,
      ocr_regions: ocrRegions,
      ocr_scanned_pages: scannedPagesSeen,
      ocr_truncated: scannedPagesSeen > ocrAttempts,
    };
  } catch {
    return {
      text: "",
      lines: [],
      sections: [],
      ocr_pages: 0,
      ocr_engine: null,
      ocr_regions: [],
      ocr_scanned_pages: 0,
      ocr_truncated: false,
    };
  }
}
