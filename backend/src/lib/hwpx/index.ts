/**
 * HWPX (Hancom Office, KS X 6101 / OWPML) support.
 *
 * LibreOffice cannot open HWPX, so unlike DOC/DOCX there is no converter to
 * lean on: the package is parsed here. Text extraction reads it directly;
 * the viewer gets a PDF by way of an intermediate DOCX that LibreOffice
 * *can* render.
 */
import { parseSection, type BodyContext } from "./body";
import { parseHeader } from "./header";
import { HwpxError, openHwpxPackage, validateHwpx } from "./package";
import { hwpxDocumentToText } from "./text";
import { hwpxDocumentToDocx } from "./toDocx";
import type { HwpxDocument, HwpxParseOptions, HwpxSection } from "./types";

export { HwpxError, looksLikeHwpx, validateHwpx } from "./package";
export type { HwpxDocument } from "./types";

export async function parseHwpx(
  buffer: Buffer,
  options: HwpxParseOptions = {},
): Promise<HwpxDocument> {
  const pkg = await openHwpxPackage(buffer, options);
  const ctx: BodyContext = {
    header: parseHeader(pkg.headerXml),
    pkg,
    counters: new Map(),
  };
  // Sequential on purpose: list counters carry over from section to section.
  const sections: HwpxSection[] = [];
  for (const xml of pkg.sectionXmls) {
    sections.push(await parseSection(xml, ctx));
  }
  return { sections };
}

/**
 * Why an upload has to be refused, or null when it is fine. Only HWPX is
 * checked by content: a renamed or password-protected file would otherwise be
 * stored as a document that can be neither displayed nor searched.
 */
export async function hwpxUploadProblem(
  fileType: string,
  buffer: Buffer,
): Promise<string | null> {
  if (fileType.toLowerCase() !== "hwpx") return null;
  try {
    await validateHwpx(buffer);
    return null;
  } catch (err) {
    if (err instanceof HwpxError) return err.message;
    throw err;
  }
}

export async function extractHwpxText(buffer: Buffer): Promise<string> {
  return hwpxDocumentToText(await parseHwpx(buffer));
}

export async function hwpxToDocx(buffer: Buffer): Promise<Buffer> {
  return hwpxDocumentToDocx(await parseHwpx(buffer));
}
