import type {
  HwpxAlign,
  HwpxBorder,
  HwpxCellBorders,
  HwpxIndent,
} from "./types";
import type { NumberingDefinition, NumberingLevel } from "./numbering";
import {
  attr,
  child,
  childrenNamed,
  descendants,
  innerText,
  numAttr,
  parseXml,
  type XNode,
} from "./xml";

export interface CharStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sizePt?: number;
  color?: string;
  font?: string;
}

export type HeadingKind = "NUMBER" | "OUTLINE" | "BULLET";

export interface ParaStyle {
  align?: HwpxAlign;
  indent?: HwpxIndent;
  spacing?: { before: number; after: number };
  lineSpacingPercent?: number;
  heading?: { kind: HeadingKind; idRef: string; level: number };
}

export interface BorderFill {
  borders: HwpxCellBorders;
  fill?: string;
}

export interface HwpxHeader {
  charStyles: Map<string, CharStyle>;
  paraStyles: Map<string, ParaStyle>;
  borderFills: Map<string, BorderFill>;
  numberings: Map<string, NumberingDefinition>;
  bullets: Map<string, string>;
}

export const EMPTY_HEADER: HwpxHeader = {
  charStyles: new Map(),
  paraStyles: new Map(),
  borderFills: new Map(),
  numberings: new Map(),
  bullets: new Map(),
};

const ALIGN: Record<string, HwpxAlign> = {
  LEFT: "left",
  RIGHT: "right",
  CENTER: "center",
  JUSTIFY: "justify",
  DISTRIBUTE: "justify",
  DISTRIBUTE_SPACE: "justify",
};

/** "#RRGGBB" or "#AARRGGBB" → "RRGGBB"; "none" and junk → undefined. */
export function parseColor(raw: string | undefined): string | undefined {
  const match = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(raw ?? "");
  return match ? match[1].slice(-6).toUpperCase() : undefined;
}

function isSet(node: XNode | undefined, attribute: string): boolean {
  const value = node ? attr(node, attribute) : undefined;
  return value !== undefined && value !== "NONE";
}

function parseCharStyle(
  node: XNode,
  hangulFonts: Map<string, string>,
): CharStyle {
  const height = numAttr(node, "height");
  const fontRef = child(node, "fontRef");
  const fontId = fontRef ? attr(fontRef, "hangul") : undefined;
  return {
    bold: child(node, "bold") ? true : undefined,
    italic: child(node, "italic") ? true : undefined,
    underline: isSet(child(node, "underline"), "type") || undefined,
    strike: isSet(child(node, "strikeout"), "shape") || undefined,
    sizePt: height ? height / 100 : undefined,
    color: parseColor(attr(node, "textColor")),
    font: fontId !== undefined ? hangulFonts.get(fontId) : undefined,
  };
}

/**
 * Paragraph margins come in two flavours. Writers that know the HwpUnitChar
 * extension put true HWPUNITs in <hp:case> and keep the legacy value — which
 * HWP has always stored doubled — in <hp:default>. Older files only have the
 * doubled form.
 */
function resolveMarginSource(node: XNode): { source: XNode; scale: number } {
  const sw = child(node, "switch");
  const modern = sw ? child(sw, "case") : undefined;
  if (modern && child(modern, "margin")) return { source: modern, scale: 1 };
  const legacy = sw ? child(sw, "default") : undefined;
  return { source: legacy ?? node, scale: 0.5 };
}

function parseParaStyle(node: XNode): ParaStyle {
  const style: ParaStyle = {};
  const align = child(node, "align");
  const horizontal = align ? attr(align, "horizontal") : undefined;
  if (horizontal && ALIGN[horizontal]) style.align = ALIGN[horizontal];

  const heading = child(node, "heading");
  const kind = heading ? attr(heading, "type") : undefined;
  if (
    heading &&
    (kind === "NUMBER" || kind === "OUTLINE" || kind === "BULLET")
  ) {
    style.heading = {
      kind,
      idRef: attr(heading, "idRef") ?? "0",
      level: numAttr(heading, "level") ?? 0,
    };
  }

  const { source, scale } = resolveMarginSource(node);
  const margin = child(source, "margin");
  if (margin) {
    const read = (name: string) => {
      const entry = child(margin, name);
      return Math.round((entry ? (numAttr(entry, "value") ?? 0) : 0) * scale);
    };
    style.indent = {
      left: read("left"),
      right: read("right"),
      firstLine: read("intent"),
    };
    style.spacing = { before: read("prev"), after: read("next") };
  }
  const lineSpacing = child(source, "lineSpacing");
  if (lineSpacing && attr(lineSpacing, "type") === "PERCENT") {
    style.lineSpacingPercent = numAttr(lineSpacing, "value");
  }
  return style;
}

function parseBorder(node: XNode | undefined): HwpxBorder | undefined {
  if (!node || !isSet(node, "type")) return undefined;
  const widthMm = Number.parseFloat(attr(node, "width") ?? "");
  return {
    widthMm: Number.isFinite(widthMm) && widthMm > 0 ? widthMm : 0.12,
    color: parseColor(attr(node, "color")) ?? "000000",
  };
}

function parseBorderFill(node: XNode): BorderFill {
  const brush = descendants([node], "winBrush")[0];
  return {
    borders: {
      left: parseBorder(child(node, "leftBorder")),
      right: parseBorder(child(node, "rightBorder")),
      top: parseBorder(child(node, "topBorder")),
      bottom: parseBorder(child(node, "bottomBorder")),
    },
    fill: brush ? parseColor(attr(brush, "faceColor")) : undefined,
  };
}

function parseNumbering(node: XNode): NumberingDefinition {
  const levels: NumberingLevel[] = [];
  for (const head of childrenNamed(node, "paraHead")) {
    // paraHead levels are 1-based; hh:heading levels are 0-based.
    const index = (numAttr(head, "level") ?? 1) - 1;
    if (index < 0) continue;
    levels[index] = {
      format: innerText(head).trim(),
      numFormat: attr(head, "numFormat") ?? "DIGIT",
      start: numAttr(head, "start") ?? 1,
    };
  }
  return { levels };
}

function indexById<T>(
  nodes: XNode[],
  parse: (node: XNode) => T,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const node of nodes) {
    const id = attr(node, "id");
    if (id !== undefined) map.set(id, parse(node));
  }
  return map;
}

function parseHangulFonts(root: XNode[]): Map<string, string> {
  const face = descendants(root, "fontface").find(
    (node) => attr(node, "lang") === "HANGUL",
  );
  if (!face) return new Map();
  return indexById(
    childrenNamed(face, "font"),
    (font) => attr(font, "face") ?? "",
  );
}

export function parseHeader(xml: string | null): HwpxHeader {
  if (!xml) return EMPTY_HEADER;
  const root = parseXml(xml);
  const hangulFonts = parseHangulFonts(root);
  return {
    charStyles: indexById(descendants(root, "charPr"), (node) =>
      parseCharStyle(node, hangulFonts),
    ),
    paraStyles: indexById(descendants(root, "paraPr"), parseParaStyle),
    borderFills: indexById(descendants(root, "borderFill"), parseBorderFill),
    // Scoped to their list containers: bare "numbering"/"bullet" element
    // names are reused elsewhere in OWPML (e.g. footnote numbering).
    numberings: indexById(
      descendants(root, "numberings").flatMap((list) =>
        childrenNamed(list, "numbering"),
      ),
      parseNumbering,
    ),
    bullets: indexById(
      descendants(root, "bullets").flatMap((list) =>
        childrenNamed(list, "bullet"),
      ),
      (node) => attr(node, "char") ?? "•",
    ),
  };
}
