import { promisify } from "util";
import JSZip from "jszip";
import { safeSpawnEnv } from "./safeSpawn";
import { bundledSofficePath } from "./libreofficeStatus";

let _convert:
  | ((buf: Buffer, ext: string, filter: undefined) => Promise<Buffer>)
  | null = null;

async function getConvert() {
  if (!_convert) {
    const libre = await import("libreoffice-convert");
    _convert = promisify(libre.default.convert.bind(libre.default));
  }
  return _convert;
}

/**
 * Some older Windows/Word archives store .docx entries with backslash
 * separators (e.g. `word\document.xml`). Mammoth and LibreOffice both look
 * up entries by exact string and miss those files, producing empty output
 * or conversion failures. Rewrite any such entries to the canonical
 * forward-slash form before handing the buffer off.
 */
export async function normalizeDocxZipPaths(buffer: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return buffer;
  }
  const renames: [string, string][] = [];
  zip.forEach((relativePath) => {
    if (relativePath.includes("\\")) {
      renames.push([relativePath, relativePath.replace(/\\/g, "/")]);
    }
  });
  if (renames.length === 0) return buffer;
  for (const [oldPath, newPath] of renames) {
    const entry = zip.file(oldPath);
    if (!entry) continue;
    const content = await entry.async("nodebuffer");
    zip.remove(oldPath);
    zip.file(newPath, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * Serialize conversions so the env-scrub below cannot interleave with
 * unrelated child_process spawns elsewhere in the backend (defense in depth).
 */
let convertChain: Promise<unknown> = Promise.resolve();

/**
 * libreoffice-convert spawns `soffice` internally, inheriting process.env. The
 * backend's env carries JWT_SECRET and all the AI provider API keys — none of
 * which should leak to soffice (or to anyone enumerating its env block).
 * Temporarily replace process.env with a minimal allow-list during the call,
 * then restore.
 */
async function withScrubbedEnv<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env;
  // Object.defineProperty assignment — process.env is a special object on
  // some Node versions, plain assignment works.
  const scrubbed = safeSpawnEnv();
  // Pin libreoffice-convert to the bundled binary so it never resolves
  // to a stale system install. Honored as LIBRE_OFFICE_PATH by the
  // package; harmless on platforms without a bundle (null path skipped).
  const bundled = bundledSofficePath();
  if (bundled) scrubbed.LIBRE_OFFICE_PATH = bundled;
  process.env = scrubbed;
  try {
    return await fn();
  } finally {
    process.env = original;
  }
}

function assertLibreOfficeConversionAllowed() {
  if (bundledSofficePath()) return;
  if (
    process.platform !== "win32" &&
    process.env.DOCKET_ENABLE_SYSTEM_LIBREOFFICE_PROBE !== "1"
  ) {
    throw new Error(
      "System LibreOffice conversion is disabled. Set DOCKET_ENABLE_SYSTEM_LIBREOFFICE_PROBE=1 to allow DOC/DOCX→PDF conversion with the local LibreOffice install.",
    );
  }
}

// Hard caps for LibreOffice conversion. A pathological DOCX can hang
// soffice indefinitely or produce a runaway PDF; these limit blast radius.
const CONVERT_TIMEOUT_MS = 60_000;
const CONVERT_MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

/**
 * Convert a DOCX/DOC buffer to PDF using LibreOffice.
 * Throws if LibreOffice is not installed, conversion fails, conversion
 * runs longer than CONVERT_TIMEOUT_MS, or output exceeds
 * CONVERT_MAX_OUTPUT_BYTES.
 */
export async function docxToPdf(buffer: Buffer): Promise<Buffer> {
  const run = async () => {
    assertLibreOfficeConversionAllowed();
    const convert = await getConvert();
    const normalized = await normalizeDocxZipPaths(buffer);
    const work = withScrubbedEnv(() => convert(normalized, ".pdf", undefined));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `LibreOffice conversion timed out after ${CONVERT_TIMEOUT_MS}ms`,
            ),
          ),
        CONVERT_TIMEOUT_MS,
      );
    });
    let out: Buffer;
    try {
      out = await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (out.length > CONVERT_MAX_OUTPUT_BYTES) {
      throw new Error(
        `LibreOffice conversion produced ${out.length} bytes; max is ${CONVERT_MAX_OUTPUT_BYTES}`,
      );
    }
    return out;
  };
  const next = convertChain.then(run, run);
  convertChain = next.catch(() => undefined);
  return next;
}

export function convertedPdfKey(userId: string, docId: string): string {
  return `converted-pdfs/${userId}/${docId}.pdf`;
}
