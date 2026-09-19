/**
 * Format-neutral model of an HWPX document. Lengths stay in HWPUNIT
 * (1/7200 inch) exactly as the file stores them; consumers convert.
 */

export type HwpxAlign = "left" | "center" | "right" | "justify";

export interface HwpxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sizePt?: number;
  /** RRGGBB, no leading '#'. */
  color?: string;
  font?: string;
  /**
   * The superscript "1)" mark left in body text where a note is anchored.
   * Rendered in the DOCX, but left out of plain text so it doesn't land in
   * the middle of a quotable sentence.
   */
  noteRef?: boolean;
}

export interface HwpxIndent {
  left: number;
  right: number;
  /** Negative for a hanging indent. */
  firstLine: number;
}

export interface HwpxParagraph {
  kind: "paragraph";
  runs: HwpxRun[];
  align?: HwpxAlign;
  indent?: HwpxIndent;
  spacing?: { before: number; after: number };
  lineSpacingPercent?: number;
  pageBreakBefore?: boolean;
  /** Set on the synthetic paragraphs that carry footnote/endnote bodies. */
  note?: "footnote" | "endnote";
}

export interface HwpxBorder {
  widthMm: number;
  /** RRGGBB, no leading '#'. */
  color: string;
}

export interface HwpxCellBorders {
  left?: HwpxBorder;
  right?: HwpxBorder;
  top?: HwpxBorder;
  bottom?: HwpxBorder;
}

export interface HwpxTableCell {
  blocks: HwpxBlock[];
  /**
   * Zero-based grid column the cell starts in. A row stores no cell for a
   * column covered by a vertical merge from above, so position in the row
   * array is not the column.
   */
  col: number;
  colSpan: number;
  rowSpan: number;
  width?: number;
  borders?: HwpxCellBorders;
  /** RRGGBB, no leading '#'. */
  fill?: string;
}

export interface HwpxTable {
  kind: "table";
  rows: HwpxTableCell[][];
  /** Grid column widths in HWPUNIT, when the cells declare them. */
  columnWidths: number[];
}

export type HwpxImageFormat = "png" | "jpg" | "gif" | "bmp";

export interface HwpxImage {
  kind: "image";
  data: Buffer;
  format: HwpxImageFormat;
  width: number;
  height: number;
}

export type HwpxBlock = HwpxParagraph | HwpxTable | HwpxImage;

export interface HwpxPage {
  width: number;
  height: number;
  landscape: boolean;
  margin: { left: number; right: number; top: number; bottom: number };
}

export interface HwpxSection {
  page: HwpxPage | null;
  blocks: HwpxBlock[];
}

export interface HwpxDocument {
  sections: HwpxSection[];
}

export interface HwpxParseOptions {
  /** Cap on the combined decompressed size of header + section XML. */
  maxXmlBytes?: number;
  /** Cap on the combined size of embedded images that get decoded. */
  maxImageBytes?: number;
}
