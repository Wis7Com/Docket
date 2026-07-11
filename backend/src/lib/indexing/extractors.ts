import { Buffer } from "buffer";
import { downloadFile } from "../storage";
import { extractDocxBodyText } from "../docxTrackedChanges";
import type { createServerSupabase } from "../supabase";
import { createLocalOcrEngine } from "../ocr";
import type { OcrEngine } from "../ocr/types";
import { getUserOcrSettings } from "../userSettings";
import { isImageDocumentType } from "../documentTypes";
import {
  buildChunkSearchText,
  buildPlainTextLines,
  detectDocumentSections,
  extractStructuredPdfText,
  sectionPathForRange,
} from "./outline";
import {
  INDEX_CHUNK_OVERLAP,
  INDEX_CHUNK_SIZE,
  type ExtractedChunk,
  type ExtractedDocument,
  type StructuredIndexText,
} from "./types";

type DocumentRow = {
  id: string;
  filename: string;
  file_type: string | null;
  current_version_id: string | null;
  user_id: string;
};

type VersionRow = {
  id: string;
  document_id: string;
  storage_path: string;
};

export function normalizeIndexText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countTokens(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function splitPageSegments(
  text: string,
): { page: number | null; text: string }[] {
  const matches = [...text.matchAll(/\[Page\s+(\d+)\]\n?/g)];
  if (matches.length === 0) return [{ page: null, text }];

  const segments: { page: number | null; text: string }[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const next = matches[i + 1];
    const start = (match.index ?? 0) + match[0].length;
    const end = next?.index ?? text.length;
    segments.push({
      page: Number(match[1]),
      text: text.slice(start, end).trim(),
    });
  }
  return segments.filter((segment) => segment.text.length > 0);
}

export function chunkTextForIndex(
  text: string,
  suppliedSections?: StructuredIndexText["sections"],
): ExtractedChunk[] {
  const normalized = normalizeIndexText(text);
  if (!normalized) return [];
  const sections =
    suppliedSections ??
    detectDocumentSections(normalized, buildPlainTextLines(normalized));

  const chunks: ExtractedChunk[] = [];
  let globalOffset = 0;

  for (const segment of splitPageSegments(normalized)) {
    const segmentStart = normalized.indexOf(segment.text, globalOffset);
    const baseOffset = segmentStart >= 0 ? segmentStart : globalOffset;
    const words = [...segment.text.matchAll(/\S+/g)];
    let wordStart = 0;

    while (wordStart < words.length) {
      const wordEnd = Math.min(wordStart + INDEX_CHUNK_SIZE, words.length);
      const first = words[wordStart];
      const last = words[wordEnd - 1];
      const startChar = baseOffset + (first.index ?? 0);
      const endChar = baseOffset + (last.index ?? 0) + last[0].length;
      const content = segment.text
        .slice(first.index ?? 0, (last.index ?? 0) + last[0].length)
        .trim();

      if (content) {
        const sectionPath = sectionPathForRange(sections, startChar, endChar);
        chunks.push({
          chunk_index: chunks.length,
          page_number: segment.page,
          section_path: sectionPath,
          search_text: buildChunkSearchText(content, sectionPath),
          content,
          start_char: startChar,
          end_char: endChar,
          token_count: countTokens(content),
        });
      }

      if (wordEnd >= words.length) break;
      wordStart = Math.max(wordEnd - INDEX_CHUNK_OVERLAP, wordStart + 1);
    }

    globalOffset = baseOffset + segment.text.length;
  }

  return chunks;
}

export async function extractTextFromBytes(
  raw: ArrayBuffer,
  fileType: string,
): Promise<string> {
  return (await extractStructuredTextFromBytes(raw, fileType)).text;
}

export async function extractStructuredTextFromBytes(
  raw: ArrayBuffer,
  fileType: string,
  options: { ocrEngine?: OcrEngine; ocrMaxPages?: number } = {},
): Promise<StructuredIndexText> {
  if (fileType === "pdf") {
    return extractStructuredPdfText(raw, {
      ocr: options.ocrEngine
        ? { engine: options.ocrEngine, maxPages: options.ocrMaxPages ?? 50 }
        : undefined,
    });
  }
  if (isImageDocumentType(fileType)) {
    if (!options.ocrEngine) {
      return {
        text: "",
        lines: [],
        sections: [],
        ocr_pages: 0,
        ocr_engine: null,
        ocr_regions: [],
      };
    }
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const image = await loadImage(Buffer.from(raw));
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext("2d").drawImage(image, 0, 0);
    const result = await options.ocrEngine.recognize({
      data: canvas.toBuffer("image/png"),
      width: image.width,
      height: image.height,
      format: "png",
    });
    const body = normalizeIndexText(
      result.text || result.regions.map((region) => region.text).join("\n"),
    );
    const text = body ? `[Page 1]\n${body}` : "";
    const lines = buildPlainTextLines(text);
    return {
      text,
      lines,
      sections: detectDocumentSections(text, lines),
      ocr_pages: 1,
      ocr_engine: options.ocrEngine.name,
      ocr_regions: result.regions.map((region) => ({
        ...region,
        page_number: 1,
      })),
    };
  }
  let text = "";
  if (fileType === "txt" || fileType === "md") {
    text = normalizeIndexText(Buffer.from(raw).toString("utf8"));
  } else if (fileType === "docx") {
    const accepted = await extractDocxBodyText(Buffer.from(raw));
    if (accepted) {
      text = normalizeIndexText(accepted);
    } else {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: Buffer.from(raw) });
      text = normalizeIndexText(result.value);
    }
  } else if (fileType === "doc") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: Buffer.from(raw) });
    text = normalizeIndexText(result.value);
  }
  const lines = buildPlainTextLines(text);
  return { text, lines, sections: detectDocumentSections(text, lines) };
}

export async function extractDocumentForIndex(args: {
  db: ReturnType<typeof createServerSupabase>;
  documentId: string;
  versionId?: string | null;
  ocrEngine?: OcrEngine;
}): Promise<ExtractedDocument> {
  const { data: docData } = await args.db
    .from("documents")
    .select("id, filename, file_type, current_version_id, user_id")
    .eq("id", args.documentId)
    .single();
  const doc = docData as DocumentRow | null;
  if (!doc) throw new Error("Document not found");

  const versionId = args.versionId || doc.current_version_id;
  if (!versionId) throw new Error("Document has no active version");

  const { data: versionData } = await args.db
    .from("document_versions")
    .select("id, document_id, storage_path")
    .eq("id", versionId)
    .single();
  const version = versionData as VersionRow | null;
  if (!version || version.document_id !== args.documentId) {
    throw new Error("Document version not found");
  }

  const raw = await downloadFile(version.storage_path);
  if (!raw) throw new Error("Document bytes not available");

  const fileType = (doc.file_type ?? "").toLowerCase();
  const ocrSettings = await getUserOcrSettings(doc.user_id);
  let ocrEngine = args.ocrEngine;
  if (
    !ocrEngine &&
    (fileType === "pdf" || isImageDocumentType(fileType)) &&
    ocrSettings.enabled
  ) {
    try {
      ocrEngine = createLocalOcrEngine(ocrSettings);
    } catch (err) {
      console.warn("[ocr] local OCR engine is unavailable", err);
    }
  }
  const extracted = await extractStructuredTextFromBytes(raw, fileType, {
    ocrEngine,
    ocrMaxPages: ocrSettings.maxPagesPerDocument,
  });
  const chunks = chunkTextForIndex(extracted.text, extracted.sections);

  return {
    document_id: doc.id,
    version_id: version.id,
    filename: doc.filename,
    file_type: fileType,
    text: extracted.text,
    chunks,
    ocr_pages: extracted.ocr_pages ?? 0,
    ocr_engine: extracted.ocr_engine ?? null,
    ocr_regions: extracted.ocr_regions ?? [],
  };
}
