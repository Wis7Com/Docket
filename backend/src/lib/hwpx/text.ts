import type { HwpxBlock, HwpxDocument, HwpxTable } from "./types";

const CELL_SEPARATOR = " | ";

function paragraphText(
  block: Extract<HwpxBlock, { kind: "paragraph" }>,
): string {
  return block.runs
    .filter((run) => !run.noteRef)
    .map((run) => run.text)
    .join("");
}

/** A cell's content on one line, so a table row stays a single text row. */
function cellText(blocks: HwpxBlock[]): string {
  return blocksToLines(blocks)
    .map((line) => line.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

function tableLines(table: HwpxTable): string[] {
  return table.rows
    .map((row) => row.map((cell) => cellText(cell.blocks)).join(CELL_SEPARATOR))
    .filter((line) => line.replaceAll("|", "").trim().length > 0);
}

function blocksToLines(blocks: HwpxBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.kind === "paragraph") return [paragraphText(block)];
    if (block.kind === "table") return tableLines(block);
    return [];
  });
}

export function hwpxDocumentToText(doc: HwpxDocument): string {
  return doc.sections
    .map((section) => blocksToLines(section.blocks).join("\n"))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
