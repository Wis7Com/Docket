import { completeText } from "./llm";
import type { UserApiKeys } from "./llm";
import {
  detectGpuAcceleration,
  type GpuAcceleration,
} from "./hardwareAcceleration";
import type {
  DocumentSectionAnchor,
  StructuredIndexText,
  StructuredTextLine,
} from "./indexing/types";

const MAX_OUTLINE_ITEMS = 240;
const DEFAULT_LLM_CHUNK_CHARS = 48_000;
const MAX_LLM_CHUNKS = 64;

export type GeneratedDocumentOutlineItem = {
  id: string;
  title: string;
  level: number;
  page?: number;
};

export type DocumentOutlineResult = {
  items: GeneratedDocumentOutlineItem[];
  source:
    | "toc-match"
    | "document-structure"
    | "llm"
    | "gpu-unavailable"
    | "too-large"
    | "no-text";
  message?: string;
};

type Completion = (params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
}) => Promise<string>;

function normalizeTitle(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function headingMatchKey(value: string): string {
  return normalizeTitle(value)
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /^(?:(?:part|chapter|article|section|title|clause)\s+[\divxlcm]+|제\s*\d+\s*(?:편|장|절|관|조|항)|\d+(?:\.\d+)*[.)]?)\s*[:.\-–—]?\s*/iu,
      "",
    )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function headingsMatch(left: string, right: string): boolean {
  const a = headingMatchKey(left);
  const b = headingMatchKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a))) {
    return true;
  }
  const aTokens = new Set(a.split(" ").filter((token) => token.length > 1));
  const bTokens = new Set(b.split(" ").filter((token) => token.length > 1));
  if (!aTokens.size || !bTokens.size) return false;
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap += 1;
  return overlap / Math.max(aTokens.size, bTokens.size) >= 0.75;
}

function numberingDepth(title: string): number | null {
  const numbered = /^(\d+(?:\.\d+)*)[.)]?\s/.exec(title);
  if (numbered) return numbered[1].split(".").length;
  if (/^(?:part|chapter|title)\s+/i.test(title)) return 1;
  if (/^(?:article|section|clause)\s+/i.test(title)) return 2;
  return null;
}

function parseTocLine(
  value: string,
  allowPlainTrailingPage: boolean,
): { title: string; listedPage: number; level: number } | null {
  const text = normalizeTitle(value);
  const match = allowPlainTrailingPage
    ? /^(.{3,}?)\s+(\d{1,4})$/.exec(text)
    : /^(.{3,}?)\s*(?:\.{3,}|…{2,}|·{3,})\s*(\d{1,4})$/.exec(text);
  if (!match) return null;
  const title = normalizeTitle(match[1]);
  const listedPage = Number(match[2]);
  if (!title || listedPage < 1) return null;
  return {
    title,
    listedPage,
    level: Math.min(numberingDepth(title) ?? 1, 6),
  };
}

function tocOutline(
  lines: StructuredTextLine[],
): GeneratedDocumentOutlineItem[] {
  const candidates: Array<{
    title: string;
    listedPage: number;
    level: number;
    linePosition: number;
  }> = [];
  let contentsPosition: number | null = null;
  let contentsPage: number | null = null;

  lines.forEach((line, linePosition) => {
    if (/^(?:table\s+of\s+)?contents$|^목\s*차$/iu.test(line.text)) {
      contentsPosition = linePosition;
      contentsPage = line.page_number;
      return;
    }
    const nearContents =
      contentsPosition !== null &&
      linePosition - contentsPosition <= 500 &&
      (contentsPage === null ||
        line.page_number === null ||
        line.page_number <= contentsPage + 3);
    const parsed =
      parseTocLine(line.text, false) ??
      (nearContents ? parseTocLine(line.text, true) : null);
    if (parsed) candidates.push({ ...parsed, linePosition });
  });

  if (candidates.length < 2) return [];
  const bodyStart =
    Math.max(...candidates.map((entry) => entry.linePosition)) + 1;
  const maxPage = Math.max(1, ...lines.map((line) => line.page_number ?? 1));
  const matches = candidates.map((entry) => {
    const bodyLine = lines
      .slice(bodyStart)
      .find((line) => headingsMatch(line.text, entry.title));
    return { entry, bodyLine };
  });
  const matchedTitles = matches.filter(({ bodyLine }) => bodyLine);
  // Printed page labels are not physical PDF pages when front matter shifts
  // numbering. Without at least two title anchors there is no reliable offset
  // and the TOC must not suppress the structural/LLM fallbacks.
  if (matchedTitles.length < 2) return [];
  const hasPhysicalPages = lines.some((line) => line.page_number !== null);
  const offsets = matches
    .map(({ entry, bodyLine }) =>
      bodyLine?.page_number == null
        ? null
        : bodyLine.page_number - entry.listedPage,
    )
    .filter((offset): offset is number => offset !== null)
    .sort((left, right) => left - right);
  const inferredOffset = offsets[Math.floor(offsets.length / 2)] ?? 0;
  if (hasPhysicalPages) {
    const consistentOffsets = offsets.filter(
      (offset) => Math.abs(offset - inferredOffset) <= 2,
    );
    if (consistentOffsets.length < 2) return [];
  }

  return matches
    .slice(0, MAX_OUTLINE_ITEMS)
    .map(({ entry, bodyLine }, index) => {
      const inferredPage = Math.min(
        maxPage,
        Math.max(1, entry.listedPage + inferredOffset),
      );
      return {
        id: `document-toc-${index}`,
        title: entry.title,
        level: entry.level,
        ...(hasPhysicalPages
          ? { page: bodyLine?.page_number ?? inferredPage }
          : {}),
      };
    });
}

function sectionOutline(
  sections: DocumentSectionAnchor[],
): GeneratedDocumentOutlineItem[] {
  return sections.slice(0, MAX_OUTLINE_ITEMS).map((section, index) => ({
    id: `document-structure-${index}`,
    title: normalizeTitle(section.title),
    level: Math.min(6, Math.max(1, Math.round(section.level))),
    ...(section.page_number === null ? {} : { page: section.page_number }),
  }));
}

export function buildDeterministicDocumentOutline(
  structured: StructuredIndexText,
): DocumentOutlineResult {
  const toc = tocOutline(structured.lines);
  if (toc.length) return { items: toc, source: "toc-match" };
  const sections = sectionOutline(structured.sections);
  if (sections.length) {
    return { items: sections, source: "document-structure" };
  }
  return { items: [], source: "no-text" };
}

type LineChunk = { lines: StructuredTextLine[]; text: string };

function chunkStructuredLines(
  lines: StructuredTextLine[],
  maxChars: number,
): LineChunk[] {
  const chunks: LineChunk[] = [];
  let chunkLines: StructuredTextLine[] = [];
  let parts: string[] = [];
  let length = 0;
  let previousPage: number | null | undefined;

  const flush = () => {
    if (!chunkLines.length) return;
    chunks.push({ lines: chunkLines, text: parts.join("\n") });
    chunkLines = [];
    parts = [];
    length = 0;
    previousPage = undefined;
  };

  for (const line of lines) {
    const pagePrefix =
      line.page_number !== null && line.page_number !== previousPage
        ? `[Page ${line.page_number}]\n`
        : "";
    const rendered = `${pagePrefix}${line.text}`;
    if (chunkLines.length && length + rendered.length + 1 > maxChars) flush();
    chunkLines.push(line);
    parts.push(rendered);
    length += rendered.length + 1;
    previousPage = line.page_number;
  }
  flush();
  return chunks;
}

function parseLlmItems(value: string): Array<{
  title: string;
  level: number;
}> {
  const firstBracket = value.indexOf("[");
  const lastBracket = value.lastIndexOf("]");
  if (firstBracket < 0 || lastBracket <= firstBracket) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(firstBracket, lastBracket + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const item = raw as { title?: unknown; level?: unknown };
      const title =
        typeof item.title === "string" ? normalizeTitle(item.title) : "";
      const level = Number(item.level);
      if (!title || title.length > 180 || !Number.isFinite(level)) return null;
      return { title, level: Math.min(6, Math.max(1, Math.round(level))) };
    })
    .filter((item): item is { title: string; level: number } => item !== null);
}

function evenlySample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => {
    const position = Math.round((index * (items.length - 1)) / (limit - 1));
    return items[position];
  });
}

function applyGlobalHierarchy(
  value: string,
  candidates: GeneratedDocumentOutlineItem[],
): GeneratedDocumentOutlineItem[] {
  const firstBracket = value.indexOf("[");
  const lastBracket = value.lastIndexOf("]");
  if (firstBracket < 0 || lastBracket <= firstBracket) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(firstBracket, lastBracket + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const selected: GeneratedDocumentOutlineItem[] = [];
  const seen = new Set<number>();
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { index?: unknown; level?: unknown };
    const index = Number(item.index);
    const level = Number(item.level);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= candidates.length ||
      !Number.isFinite(level) ||
      seen.has(index)
    ) {
      continue;
    }
    seen.add(index);
    selected.push({
      ...candidates[index],
      id: `document-llm-${selected.length}`,
      level: Math.min(6, Math.max(1, Math.round(level))),
    });
  }
  return selected;
}

const OUTLINE_SYSTEM_PROMPT = `You extract a document's existing outline.
Return only a JSON array. Each item must be {"title": string, "level": integer}.
Use only section-heading text that appears verbatim in the supplied document chunk.
Do not invent, rewrite, summarize, or promote ordinary body sentences to headings.
Use levels 1 through 6. Return [] when the chunk has no genuine headings.`;

const HIERARCHY_SYSTEM_PROMPT = `You organize heading candidates from an entire document into one consistent outline.
Return only a JSON array of {"index": integer, "level": integer} objects in document order.
Use only the supplied candidate indices. Keep genuine structural headings, remove obvious noise,
and assign globally consistent levels 1 through 6. Return at most 240 items.`;

export async function generateDocumentOutlineFallback(args: {
  structured: StructuredIndexText;
  fileType: string;
  model: string;
  apiKeys: UserApiKeys;
  detectGpu?: () => Promise<GpuAcceleration>;
  complete?: Completion;
  maxChunkChars?: number;
}): Promise<DocumentOutlineResult> {
  const deterministic = buildDeterministicDocumentOutline(args.structured);
  if (deterministic.items.length) return deterministic;

  if (!args.structured.lines.length || !args.structured.text.trim()) {
    return {
      items: [],
      source: "no-text",
      message: "No readable text was found in this document.",
    };
  }

  const gpu = await (args.detectGpu ?? detectGpuAcceleration)();
  if (!gpu.available) {
    return {
      items: [],
      source: "gpu-unavailable",
      message:
        "Only CPU execution is available. LLM outline generation was not attempted because no GPU was detected.",
    };
  }

  const complete = args.complete ?? completeText;
  const chunks = chunkStructuredLines(
    args.structured.lines,
    Math.max(1, args.maxChunkChars ?? DEFAULT_LLM_CHUNK_CHARS),
  );
  if (chunks.length > MAX_LLM_CHUNKS) {
    return {
      items: [],
      source: "too-large",
      message:
        "This document is too large for a complete LLM outline pass. LLM outline generation was not attempted.",
    };
  }
  const generated: GeneratedDocumentOutlineItem[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const response = await complete({
      model: args.model,
      apiKeys: args.apiKeys,
      maxTokens: 4_096,
      systemPrompt: OUTLINE_SYSTEM_PROMPT,
      user: `File type: ${args.fileType}\n\nDocument chunk:\n${chunk.text}`,
    });
    for (const candidate of parseLlmItems(response)) {
      const sourceLine = chunk.lines.find((line) =>
        line.text.length <= 180 && headingsMatch(line.text, candidate.title),
      );
      if (!sourceLine) continue;
      const key = `${headingMatchKey(sourceLine.text)}:${sourceLine.page_number ?? "none"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      generated.push({
        id: `document-llm-candidate-${generated.length}`,
        title: normalizeTitle(sourceLine.text),
        level: candidate.level,
        ...(sourceLine.page_number === null
          ? {}
          : { page: sourceLine.page_number }),
      });
    }
  }

  const synthesisCandidates = evenlySample(generated, MAX_OUTLINE_ITEMS);
  let items = synthesisCandidates;
  if (synthesisCandidates.length) {
    const hierarchyResponse = await complete({
      model: args.model,
      apiKeys: args.apiKeys,
      maxTokens: 4_096,
      systemPrompt: HIERARCHY_SYSTEM_PROMPT,
      user: `Candidate headings from the full document:\n${JSON.stringify(
        synthesisCandidates.map((item, index) => ({
          index,
          title: item.title,
          page: item.page ?? null,
          suggested_level: item.level,
        })),
      )}`,
    });
    const globallyOrganized = applyGlobalHierarchy(
      hierarchyResponse,
      synthesisCandidates,
    ).slice(0, MAX_OUTLINE_ITEMS);
    items = globallyOrganized.length ? globallyOrganized : synthesisCandidates;
  }

  return {
    items,
    source: "llm",
    ...(items.length
      ? {}
      : {
          message:
            "The LLM found no reliable heading structure in this document.",
        }),
  };
}
