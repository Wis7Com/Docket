import type { CharStyle, HwpxHeader, ParaStyle } from "./header";
import { formatNumber, NumberingCounter } from "./numbering";
import type { HwpxPackage } from "./package";
import type {
  HwpxBlock,
  HwpxPage,
  HwpxParagraph,
  HwpxRun,
  HwpxSection,
  HwpxTable,
  HwpxTableCell,
} from "./types";
import {
  attr,
  child,
  children,
  childrenNamed,
  descendants,
  elName,
  innerText,
  isText,
  numAttr,
  parseXml,
  textValue,
  type XNode,
} from "./xml";

/** State that spans the whole document, not just one section. */
export interface BodyContext {
  header: HwpxHeader;
  pkg: HwpxPackage;
  /** List counters run across sections, so they live here. */
  counters: Map<string, NumberingCounter>;
}

interface SectionState {
  ctx: BodyContext;
  page: HwpxPage | null;
  outlineNumberingId: string | null;
}

// Inline control elements inside <hp:t> and the text they stand for.
const INLINE_TEXT: Record<string, string> = {
  tab: "\t",
  lineBreak: "\n",
  nbSpace: " ",
  fwSpace: " ",
  hyphen: "-",
};

// Alt-text ("그림입니다.") and layout caches — never document content.
const SKIPPED_OBJECT_PARTS = new Set(["shapeComment", "linesegarray"]);

// Tables nest (a cell can hold a table). Real documents go 2-3 deep; this
// only stops a crafted file from recursing until the stack overflows.
const MAX_NESTING_DEPTH = 32;

function readRunText(node: XNode): string {
  return children(node)
    .map((part) => {
      if (isText(part)) return textValue(part);
      return INLINE_TEXT[elName(part) ?? ""] ?? "";
    })
    .join("");
}

function parsePage(secPr: XNode): HwpxPage | null {
  const pagePr = child(secPr, "pagePr");
  const width = pagePr ? numAttr(pagePr, "width") : undefined;
  const height = pagePr ? numAttr(pagePr, "height") : undefined;
  if (!pagePr || !width || !height) return null;
  const margin = child(pagePr, "margin");
  const side = (name: string) => (margin ? (numAttr(margin, name) ?? 0) : 0);
  return {
    width,
    height,
    // Counter-intuitively, "WIDELY" is HWP's portrait default.
    landscape: attr(pagePr, "landscape") === "NARROWLY",
    margin: {
      left: side("left"),
      right: side("right"),
      top: side("top"),
      bottom: side("bottom"),
    },
  };
}

function styledRun(text: string, style: CharStyle | undefined): HwpxRun {
  return { ...style, text };
}

function counterFor(
  ctx: BodyContext,
  numberingId: string,
): NumberingCounter | null {
  const existing = ctx.counters.get(numberingId);
  if (existing) return existing;
  const definition = ctx.header.numberings.get(numberingId);
  if (!definition) return null;
  const counter = new NumberingCounter(definition);
  ctx.counters.set(numberingId, counter);
  return counter;
}

function listPrefix(style: ParaStyle | undefined, state: SectionState): string {
  const heading = style?.heading;
  if (!heading) return "";
  if (heading.kind === "BULLET") {
    const bullet = state.ctx.header.bullets.get(heading.idRef);
    return bullet ? `${bullet} ` : "";
  }
  const numberingId =
    heading.kind === "OUTLINE"
      ? (state.outlineNumberingId ?? heading.idRef)
      : heading.idRef;
  const label = counterFor(state.ctx, numberingId)?.next(heading.level) ?? "";
  return label ? `${label} ` : "";
}

async function parseSubList(
  owner: XNode,
  state: SectionState,
  depth: number,
): Promise<HwpxBlock[]> {
  const blocks: HwpxBlock[] = [];
  for (const subList of childrenNamed(owner, "subList")) {
    for (const p of childrenNamed(subList, "p")) {
      blocks.push(...(await parseParagraph(p, state, depth + 1)));
    }
  }
  return blocks;
}

/** A cell before it has been placed on the table grid. */
type UnplacedCell = Omit<HwpxTableCell, "col"> & { declaredCol?: number };

async function parseCell(
  tc: XNode,
  state: SectionState,
  depth: number,
): Promise<UnplacedCell> {
  const span = child(tc, "cellSpan");
  const size = child(tc, "cellSz");
  const addr = child(tc, "cellAddr");
  const borderFill = state.ctx.header.borderFills.get(
    attr(tc, "borderFillIDRef") ?? "",
  );
  return {
    blocks: await parseSubList(tc, state, depth),
    declaredCol: addr ? numAttr(addr, "colAddr") : undefined,
    colSpan: Math.max(1, (span && numAttr(span, "colSpan")) || 1),
    rowSpan: Math.max(1, (span && numAttr(span, "rowSpan")) || 1),
    width: size ? numAttr(size, "width") : undefined,
    borders: borderFill?.borders,
    fill: borderFill?.fill,
  };
}

/**
 * Puts each row's cells on the grid. HWPX stores no cell for a column that a
 * vertical merge from an earlier row still covers, so a cell's column is its
 * declared <hp:cellAddr>, or — when that is missing — the next column no
 * merge is occupying.
 */
function placeCells(rows: UnplacedCell[][]): HwpxTableCell[][] {
  // covered[c] = how many more rows column c stays under a merge from above.
  let covered: number[] = [];
  return rows.flatMap((row) => {
    // A row with no cells is real when merges from above fill all of it, and
    // must stay so later rows keep their place; otherwise it is junk.
    if (row.length === 0 && !covered.some((left) => left > 0)) return [];
    const next = covered.map((left) => Math.max(0, left - 1));
    let cursor = 0;
    const placed = row.map(({ declaredCol, ...cell }) => {
      let col = declaredCol ?? cursor;
      while (declaredCol === undefined && (covered[col] ?? 0) > 0) col += 1;
      cursor = col + cell.colSpan;
      for (let c = col; c < cursor; c += 1) next[c] = cell.rowSpan - 1;
      return { ...cell, col };
    });
    covered = next;
    return [placed];
  });
}

/**
 * Grid widths in HWPUNIT. Unmerged cells give a column's width directly; a
 * column that only ever sits inside merged cells takes an even share of what
 * the merge has left over. Empty when a column can't be determined at all.
 */
function resolveColumnWidths(
  rows: HwpxTableCell[][],
  columnCount: number,
): number[] {
  const cells = rows.flat().filter((cell) => cell.width);
  const widths = new Map<number, number>();
  for (const cell of cells) {
    if (cell.colSpan === 1 && !widths.has(cell.col)) {
      widths.set(cell.col, cell.width as number);
    }
  }
  for (const cell of cells.filter((c) => c.colSpan > 1)) {
    const span = Array.from({ length: cell.colSpan }, (_, i) => cell.col + i);
    const unknown = span.filter((col) => !widths.has(col));
    if (unknown.length === 0) continue;
    const known = span.reduce((sum, col) => sum + (widths.get(col) ?? 0), 0);
    const share = ((cell.width as number) - known) / unknown.length;
    if (share > 0) for (const col of unknown) widths.set(col, share);
  }
  const resolved = Array.from({ length: columnCount }, (_, i) => widths.get(i));
  return resolved.every((w): w is number => w !== undefined) ? resolved : [];
}

async function parseTable(
  tbl: XNode,
  state: SectionState,
  depth: number,
): Promise<HwpxTable> {
  const unplaced: UnplacedCell[][] = [];
  for (const tr of childrenNamed(tbl, "tr")) {
    const cells: UnplacedCell[] = [];
    for (const tc of childrenNamed(tr, "tc")) {
      cells.push(await parseCell(tc, state, depth));
    }
    unplaced.push(cells);
  }
  const rows = placeCells(unplaced);
  const widest = Math.max(0, ...rows.flat().map((c) => c.col + c.colSpan));
  const columnCount = Math.max(numAttr(tbl, "colCnt") ?? 0, widest);
  return {
    kind: "table",
    rows,
    columnWidths: resolveColumnWidths(rows, columnCount),
  };
}

async function parsePicture(
  pic: XNode,
  state: SectionState,
): Promise<HwpxBlock[]> {
  const img = descendants([pic], "img")[0];
  const id = img ? attr(img, "binaryItemIDRef") : undefined;
  const item = id ? await state.ctx.pkg.loadImage(id) : null;
  if (!item) return [];
  const size = child(pic, "curSz") ?? child(pic, "orgSz");
  return [
    {
      kind: "image",
      data: item.data,
      format: item.format,
      width: (size && numAttr(size, "width")) || 0,
      height: (size && numAttr(size, "height")) || 0,
    },
  ];
}

/**
 * Tables, pictures, text boxes, equations, and grouped shapes all hang off a
 * run. Rather than enumerate every drawing element OWPML defines, walk
 * whatever is there and pick out the parts that carry content.
 */
async function parseObject(
  node: XNode,
  state: SectionState,
  depth: number,
): Promise<HwpxBlock[]> {
  const name = elName(node);
  if (!name || isText(node) || SKIPPED_OBJECT_PARTS.has(name)) return [];
  if (depth > MAX_NESTING_DEPTH) return [];
  if (name === "tbl") {
    const captions = await Promise.all(
      childrenNamed(node, "caption").map((c) => parseSubList(c, state, depth)),
    );
    return [await parseTable(node, state, depth), ...captions.flat()];
  }
  if (name === "pic") {
    const captions = await Promise.all(
      childrenNamed(node, "caption").map((c) => parseSubList(c, state, depth)),
    );
    return [...(await parsePicture(node, state)), ...captions.flat()];
  }
  if (name === "drawText" || name === "caption") {
    return parseSubList(node, state, depth);
  }
  if (name === "script") {
    const text = innerText(node).trim();
    return text ? [{ kind: "paragraph", runs: [{ text }] }] : [];
  }
  const nested: HwpxBlock[] = [];
  for (const part of children(node)) {
    nested.push(...(await parseObject(part, state, depth + 1)));
  }
  return nested;
}

function affix(code: number | undefined): string {
  return code ? String.fromCodePoint(code) : "";
}

/** "1)" as HWP renders it: number plus the configured prefix/suffix chars. */
function autoNumberText(autoNum: XNode): string {
  const num = numAttr(autoNum, "num");
  if (num === undefined) return "";
  const format = child(autoNum, "autoNumFormat");
  const label = formatNumber(num, (format && attr(format, "type")) || "DIGIT");
  const prefix = (format && attr(format, "prefixChar")) || "";
  const suffix = (format && attr(format, "suffixChar")) || "";
  return `${prefix}${label}${suffix}`;
}

/**
 * <hp:ctrl> also holds headers, footers, page numbers, column and field
 * definitions. Those repeat on every page or carry no text, so only notes and
 * generated numbers ("표 1", footnote "1)") are read.
 */
async function parseCtrl(
  ctrl: XNode,
  charStyle: CharStyle | undefined,
  state: SectionState,
  depth: number,
): Promise<{ runs: HwpxRun[]; blocks: HwpxBlock[] }> {
  const runs: HwpxRun[] = [];
  const blocks: HwpxBlock[] = [];
  for (const part of children(ctrl)) {
    const name = elName(part);
    if (name === "autoNum" || name === "newNum") {
      const text = autoNumberText(part);
      if (text) runs.push(styledRun(text, charStyle));
    } else if (name === "footNote" || name === "endNote") {
      const number = numAttr(part, "number");
      if (number !== undefined) {
        const mark = `${number}${affix(numAttr(part, "suffixChar"))}`;
        runs.push({ ...styledRun(mark, charStyle), noteRef: true });
      }
      const kind = name === "footNote" ? "footnote" : "endnote";
      for (const block of await parseSubList(part, state, depth)) {
        blocks.push(
          block.kind === "paragraph" ? { ...block, note: kind } : block,
        );
      }
    }
  }
  return { runs, blocks };
}

async function parseParagraph(
  p: XNode,
  state: SectionState,
  depth: number,
): Promise<HwpxBlock[]> {
  if (depth > MAX_NESTING_DEPTH) return [];
  const { header } = state.ctx;
  const paraStyle = header.paraStyles.get(attr(p, "paraPrIDRef") ?? "");
  const runs: HwpxRun[] = [];
  const attached: HwpxBlock[] = [];

  for (const run of childrenNamed(p, "run")) {
    const charStyle = header.charStyles.get(attr(run, "charPrIDRef") ?? "");
    for (const part of children(run)) {
      const name = elName(part);
      if (name === "t") {
        const text = readRunText(part);
        if (text) runs.push(styledRun(text, charStyle));
      } else if (name === "secPr") {
        state.page = parsePage(part) ?? state.page;
        state.outlineNumberingId =
          attr(part, "outlineShapeIDRef") ?? state.outlineNumberingId;
      } else if (name === "ctrl") {
        const ctrl = await parseCtrl(part, charStyle, state, depth);
        runs.push(...ctrl.runs);
        attached.push(...ctrl.blocks);
      } else {
        attached.push(...(await parseObject(part, state, depth)));
      }
    }
  }

  const prefix = listPrefix(paraStyle, state);
  const hasText = runs.length > 0;
  // A paragraph that only anchors a table or picture is not a blank line.
  if (!hasText && !prefix && attached.length > 0) return attached;

  const { heading: _heading, ...layout } = paraStyle ?? {};
  // The generated number borrows the look of the text it introduces — but
  // not a footnote mark's superscript, if that happens to come first.
  const { noteRef: _noteRef, ...prefixStyle } = runs[0] ?? { text: "" };
  const paragraph: HwpxParagraph = {
    kind: "paragraph",
    ...layout,
    runs: prefix ? [styledRun(prefix, prefixStyle), ...runs] : runs,
    pageBreakBefore: attr(p, "pageBreak") === "1" || undefined,
  };
  return [paragraph, ...attached];
}

export async function parseSection(
  xml: string,
  ctx: BodyContext,
): Promise<HwpxSection> {
  const state: SectionState = { ctx, page: null, outlineNumberingId: null };
  const blocks: HwpxBlock[] = [];
  for (const sec of descendants(parseXml(xml), "sec")) {
    for (const p of childrenNamed(sec, "p")) {
      blocks.push(...(await parseParagraph(p, state, 0)));
    }
  }
  return { page: state.page, blocks };
}
