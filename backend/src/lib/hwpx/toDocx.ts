import type {
  FileChild,
  IBorderOptions,
  ISectionOptions,
  ParagraphChild,
} from "docx";
import type {
  HwpxAlign,
  HwpxBlock,
  HwpxBorder,
  HwpxDocument,
  HwpxImage,
  HwpxPage,
  HwpxParagraph,
  HwpxRun,
  HwpxTable,
  HwpxTableCell,
} from "./types";

type Docx = typeof import("docx");

// HWPUNIT is 1/7200 inch; Word measures layout in twips (1/1440 inch) and
// pictures in CSS pixels (1/96 inch).
const HWPUNIT_PER_TWIP = 5;
const HWPUNIT_PER_PIXEL = 75;
const A4: HwpxPage = {
  width: 59528,
  height: 84188,
  landscape: false,
  margin: { left: 8504, right: 8504, top: 5668, bottom: 4252 },
};
const FALLBACK_IMAGE_PX = { width: 320, height: 240 };
// Word border widths are eighths of a point and must stay within 2..96.
const EIGHTHS_OF_POINT_PER_MM = (72 * 8) / 25.4;

const twips = (hwpunit: number) => Math.round(hwpunit / HWPUNIT_PER_TWIP);

/** Space available between the margins, in HWPUNIT. */
function contentWidth(page: HwpxPage): number {
  const paper = page.landscape ? page.height : page.width;
  return Math.max(paper - page.margin.left - page.margin.right, 7200);
}

class DocxWriter {
  constructor(
    private readonly docx: Docx,
    private readonly page: HwpxPage,
  ) {}

  blocks(blocks: HwpxBlock[], availableWidth: number): FileChild[] {
    return blocks.map((block) => {
      if (block.kind === "paragraph") return this.paragraph(block);
      if (block.kind === "table") return this.table(block, availableWidth);
      return this.image(block, availableWidth);
    });
  }

  private alignment(align: HwpxAlign | undefined) {
    const { AlignmentType } = this.docx;
    switch (align) {
      case "center":
        return AlignmentType.CENTER;
      case "right":
        return AlignmentType.RIGHT;
      case "justify":
        return AlignmentType.BOTH;
      default:
        return AlignmentType.LEFT;
    }
  }

  /** Tabs and line breaks are elements in WordprocessingML, not characters. */
  private runs(run: HwpxRun): ParagraphChild[] {
    const { TextRun, Tab } = this.docx;
    return run.text.split("\n").map((line, index) => {
      const pieces = line.split("\t");
      const children = pieces.flatMap((piece, i) =>
        i < pieces.length - 1 ? [piece, new Tab()] : [piece],
      );
      return new TextRun({
        children,
        break: index > 0 ? 1 : undefined,
        bold: run.bold,
        italics: run.italic,
        underline: run.underline ? {} : undefined,
        strike: run.strike,
        superScript: run.noteRef,
        size: run.sizePt ? Math.round(run.sizePt * 2) : undefined,
        color: run.color,
        font: run.font ? { name: run.font, eastAsia: run.font } : undefined,
      });
    });
  }

  private paragraph(p: HwpxParagraph) {
    const { Paragraph, LineRuleType } = this.docx;
    const firstLine = p.indent?.firstLine ?? 0;
    return new Paragraph({
      children: p.runs.flatMap((run) => this.runs(run)),
      alignment: this.alignment(p.align),
      pageBreakBefore: p.pageBreakBefore,
      indent: p.indent && {
        // Word expresses a hanging indent as left + hanging, where HWP keeps
        // the left margin and a negative first-line offset.
        left: twips(p.indent.left + Math.max(0, -firstLine)),
        right: twips(p.indent.right),
        firstLine: firstLine > 0 ? twips(firstLine) : undefined,
        hanging: firstLine < 0 ? twips(-firstLine) : undefined,
      },
      spacing: {
        before: p.spacing ? twips(p.spacing.before) : undefined,
        after: p.spacing ? twips(p.spacing.after) : 0,
        line: p.lineSpacingPercent
          ? Math.round((p.lineSpacingPercent / 100) * 240)
          : undefined,
        lineRule: p.lineSpacingPercent ? LineRuleType.AUTO : undefined,
      },
    });
  }

  private image(image: HwpxImage, availableWidth: number) {
    const { Paragraph, ImageRun } = this.docx;
    const maxWidth = availableWidth / HWPUNIT_PER_PIXEL;
    const width = image.width / HWPUNIT_PER_PIXEL || FALLBACK_IMAGE_PX.width;
    const height = image.height / HWPUNIT_PER_PIXEL || FALLBACK_IMAGE_PX.height;
    const scale = Math.min(1, maxWidth / width);
    return new Paragraph({
      children: [
        new ImageRun({
          type: image.format,
          data: image.data,
          transformation: {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
          },
        }),
      ],
    });
  }

  private border(border: HwpxBorder | undefined): IBorderOptions {
    const { BorderStyle } = this.docx;
    if (!border) return { style: BorderStyle.NONE, size: 0, color: "auto" };
    const size = Math.round(border.widthMm * EIGHTHS_OF_POINT_PER_MM);
    return {
      style: BorderStyle.SINGLE,
      size: Math.min(96, Math.max(2, size)),
      color: border.color,
    };
  }

  private cell(cell: HwpxTableCell, width: number) {
    const { TableCell, Paragraph, WidthType, ShadingType } = this.docx;
    const children = this.blocks(cell.blocks, width);
    return new TableCell({
      // A cell with no block-level content is invalid WordprocessingML.
      children: children.length > 0 ? children : [new Paragraph({})],
      columnSpan: cell.colSpan > 1 ? cell.colSpan : undefined,
      rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
      width: { size: twips(width), type: WidthType.DXA },
      borders: {
        left: this.border(cell.borders?.left),
        right: this.border(cell.borders?.right),
        top: this.border(cell.borders?.top),
        bottom: this.border(cell.borders?.bottom),
      },
      shading: cell.fill
        ? { fill: cell.fill, type: ShadingType.CLEAR, color: "auto" }
        : undefined,
    });
  }

  private table(table: HwpxTable, availableWidth: number) {
    const { Table, TableRow, WidthType, TableLayoutType } = this.docx;
    const columns = fitColumns(table, availableWidth);
    const rows = table.rows.map((row) => {
      const cells = row.map((cell) => {
        // Sized from the cell's own grid columns: in a row under a vertical
        // merge, position in the row is not the column.
        const span = columns.slice(cell.col, cell.col + cell.colSpan);
        const width = span.reduce((sum, w) => sum + w, 0) || columns[0] || 0;
        return this.cell(cell, width);
      });
      return new TableRow({ children: cells });
    });
    return new Table({
      rows,
      columnWidths: columns.map(twips),
      width: {
        size: twips(columns.reduce((sum, w) => sum + w, 0)),
        type: WidthType.DXA,
      },
      layout: TableLayoutType.FIXED,
    });
  }

  section(blocks: HwpxBlock[]): ISectionOptions {
    const { PageOrientation, Paragraph } = this.docx;
    const { page } = this;
    const children = this.blocks(blocks, contentWidth(page));
    return {
      properties: {
        page: {
          size: {
            width: twips(page.width),
            height: twips(page.height),
            orientation: page.landscape
              ? PageOrientation.LANDSCAPE
              : PageOrientation.PORTRAIT,
          },
          margin: {
            left: twips(page.margin.left),
            right: twips(page.margin.right),
            top: twips(page.margin.top),
            bottom: twips(page.margin.bottom),
          },
        },
      },
      children: children.length > 0 ? children : [new Paragraph({})],
    };
  }
}

/**
 * Column widths in HWPUNIT, scaled down when the table is wider than the
 * space it sits in, or split evenly when the file doesn't declare them.
 */
function fitColumns(table: HwpxTable, availableWidth: number): number[] {
  const count = Math.max(
    1,
    table.columnWidths.length,
    ...table.rows.flat().map((cell) => cell.col + cell.colSpan),
  );
  const declared =
    table.columnWidths.length === count
      ? table.columnWidths
      : Array.from({ length: count }, () => availableWidth / count);
  const total = declared.reduce((sum, w) => sum + w, 0);
  const scale = total > availableWidth ? availableWidth / total : 1;
  return declared.map((w) => Math.max(1, Math.floor(w * scale)));
}

export async function hwpxDocumentToDocx(doc: HwpxDocument): Promise<Buffer> {
  const docx = await import("docx");
  // A section without its own <hp:secPr> continues the previous geometry.
  let page = A4;
  const sections = doc.sections.map((section) => {
    page = section.page ?? page;
    return new DocxWriter(docx, page).section(section.blocks);
  });
  const document = new docx.Document({
    sections:
      sections.length > 0 ? sections : [new DocxWriter(docx, A4).section([])],
  });
  return docx.Packer.toBuffer(document);
}
