import type { Readable } from "node:stream";
import JSZip from "jszip";
import type { HwpxImageFormat, HwpxParseOptions } from "./types";

const HEADER_PATH = "Contents/header.xml";
const MANIFEST_PATH = "META-INF/manifest.xml";
const SECTION_PATTERN = /^Contents\/section(\d+)\.xml$/i;
const BIN_DATA_PATTERN = /^BinData\/([^/]+?)\.([A-Za-z0-9]+)$/i;

// A long brief is a few MB of XML. These caps exist to stop a crafted archive
// from expanding into gigabytes, not to limit real documents — and the parsed
// tree costs several times the XML's size, so the XML cap stays modest.
const DEFAULT_MAX_XML_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 256 * 1024 * 1024;
const MAX_SECTIONS = 1024;

const IMAGE_FORMATS: Record<string, HwpxImageFormat> = {
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  gif: "gif",
  bmp: "bmp",
};

export interface HwpxBinaryItem {
  data: Buffer;
  format: HwpxImageFormat;
}

export interface HwpxPackage {
  headerXml: string | null;
  sectionXmls: string[];
  /** Resolves a `binaryItemIDRef`; null for unknown ids and non-image data. */
  loadImage(id: string): Promise<HwpxBinaryItem | null>;
}

export class HwpxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HwpxError";
  }
}

class BudgetExceeded extends Error {}

/**
 * Inflates one entry, giving up as soon as it outgrows `limit`. The size a
 * zip declares for an entry is attacker-controlled, and JSZip only compares it
 * with reality after the whole entry is in memory — so the only trustworthy
 * bound is one enforced while the bytes are coming out.
 */
function inflateCapped(
  file: JSZip.JSZipObject,
  limit: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // JSZip types this as the bare ReadableStream interface; at runtime it
    // is a stream.Readable, which is what makes destroy() available.
    const stream = file.nodeStream("nodebuffer") as unknown as Readable;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        stream.destroy();
        reject(new BudgetExceeded());
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", () =>
      reject(
        new HwpxError(`HWPX package is corrupt (${file.name} cannot be read).`),
      ),
    );
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** A byte allowance shared by every entry read against it. */
class InflateBudget {
  private used = 0;
  constructor(private readonly limit: number) {}

  async read(file: JSZip.JSZipObject): Promise<Buffer> {
    const data = await inflateCapped(file, this.limit - this.used);
    this.used += data.length;
    return data;
  }
}

async function readXml(
  file: JSZip.JSZipObject,
  budget: InflateBudget,
): Promise<string> {
  try {
    return (await budget.read(file)).toString("utf8");
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    throw new HwpxError(
      `HWPX content is too large to process (stopped while reading ${file.name}).`,
    );
  }
}

function sectionFiles(zip: JSZip): JSZip.JSZipObject[] {
  const found: { index: number; file: JSZip.JSZipObject }[] = [];
  zip.forEach((path, file) => {
    const match = SECTION_PATTERN.exec(path);
    if (match && !file.dir) found.push({ index: Number(match[1]), file });
  });
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.file);
}

async function loadZip(buffer: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buffer);
  } catch {
    throw new HwpxError(
      "File is not a valid HWPX package (not a zip archive).",
    );
  }
}

/**
 * Cheap structural check used to tell a real .hwpx from a renamed file
 * before any XML is parsed.
 */
export async function looksLikeHwpx(buffer: Buffer): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    return sectionFiles(zip).length > 0;
  } catch {
    return false;
  }
}

async function assertNotEncrypted(
  zip: JSZip,
  budget: InflateBudget,
): Promise<void> {
  const manifest = zip.file(MANIFEST_PATH);
  if (!manifest) return;
  if (/encryption-data/i.test(await readXml(manifest, budget))) {
    throw new HwpxError(
      "This HWPX file is password-protected. Remove the password in Hancom Office and import it again.",
    );
  }
}

interface OpenedZip {
  zip: JSZip;
  sections: JSZip.JSZipObject[];
  budget: InflateBudget;
}

/** Everything that can be rejected without reading the document body. */
async function openValidatedZip(
  buffer: Buffer,
  options: HwpxParseOptions,
): Promise<OpenedZip> {
  const zip = await loadZip(buffer);
  const sections = sectionFiles(zip);
  if (sections.length === 0) {
    throw new HwpxError(
      zip.file("mimetype")
        ? "HWPX package has no body sections."
        : "File is not a valid HWPX package (no body sections found).",
    );
  }
  if (sections.length > MAX_SECTIONS) {
    throw new HwpxError(
      "HWPX content is too large to process (too many sections).",
    );
  }
  const budget = new InflateBudget(
    options.maxXmlBytes ?? DEFAULT_MAX_XML_BYTES,
  );
  await assertNotEncrypted(zip, budget);
  return { zip, sections, budget };
}

/**
 * Upload-time gate: throws an HwpxError explaining why the file can't be used
 * (renamed non-HWPX, empty package, password-protected) so it is refused with
 * a reason instead of being stored as a document nothing can read.
 */
export async function validateHwpx(buffer: Buffer): Promise<void> {
  await openValidatedZip(buffer, {});
}

function indexBinaryItems(zip: JSZip): Map<string, JSZip.JSZipObject> {
  const items = new Map<string, JSZip.JSZipObject>();
  zip.forEach((path, file) => {
    const match = BIN_DATA_PATTERN.exec(path);
    if (match && !file.dir) items.set(match[1].toLowerCase(), file);
  });
  return items;
}

export async function openHwpxPackage(
  buffer: Buffer,
  options: HwpxParseOptions = {},
): Promise<HwpxPackage> {
  const { zip, sections, budget } = await openValidatedZip(buffer, options);

  const headerFile = zip.file(HEADER_PATH);
  const headerXml = headerFile ? await readXml(headerFile, budget) : null;
  const sectionXmls: string[] = [];
  for (const file of sections) sectionXmls.push(await readXml(file, budget));

  const binaryItems = indexBinaryItems(zip);
  const imageBudget = new InflateBudget(
    options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
  );

  return {
    headerXml,
    sectionXmls,
    async loadImage(id) {
      const file = binaryItems.get(id.toLowerCase());
      const ext = file?.name.split(".").pop()?.toLowerCase() ?? "";
      const format = IMAGE_FORMATS[ext];
      if (!file || !format) return null;
      try {
        return { data: await imageBudget.read(file), format };
      } catch {
        // An unreadable or oversized picture costs the picture, not the text.
        return null;
      }
    },
  };
}
