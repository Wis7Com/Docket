import test from "node:test";
import assert from "node:assert/strict";
import { docxToPdf, hwpxToPdf, renderPdfRendition } from "./convert";
import { buildHwpxFixture } from "./hwpx/testFixture";
import { sofficePath, systemSofficePath } from "./libreofficeStatus";

test("DOCX to PDF conversion reports a clear error when LibreOffice is absent", async (t) => {
  const original = process.env.DOCKET_SKIP_LIBREOFFICE_PROBE;
  process.env.DOCKET_SKIP_LIBREOFFICE_PROBE = "1";
  t.after(() => {
    if (original == null) delete process.env.DOCKET_SKIP_LIBREOFFICE_PROBE;
    else process.env.DOCKET_SKIP_LIBREOFFICE_PROBE = original;
  });

  await assert.rejects(
    () => docxToPdf(Buffer.from("not a real docx")),
    /LibreOffice was not found/,
  );
});

test("a system LibreOffice install is used without an opt-in env var", (t) => {
  const installed = systemSofficePath();
  if (!installed) {
    t.skip("no system LibreOffice on this machine");
    return;
  }
  assert.equal(sofficePath(), installed);
});

test("HWPX to PDF conversion reports a clear error when LibreOffice is absent", async (t) => {
  const original = process.env.DOCKET_SKIP_LIBREOFFICE_PROBE;
  process.env.DOCKET_SKIP_LIBREOFFICE_PROBE = "1";
  t.after(() => {
    if (original == null) delete process.env.DOCKET_SKIP_LIBREOFFICE_PROBE;
    else process.env.DOCKET_SKIP_LIBREOFFICE_PROBE = original;
  });

  await assert.rejects(
    async () => hwpxToPdf(await buildHwpxFixture()),
    /LibreOffice was not found/,
  );
});

test("renderPdfRendition refuses types that have no rendition", async () => {
  await assert.rejects(
    () => renderPdfRendition(Buffer.from("x"), "txt"),
    /No PDF rendition is defined for \.txt/,
  );
});

test("an HWPX renders to a real PDF through the DOCX bridge", async (t) => {
  if (!systemSofficePath()) {
    t.skip("no system LibreOffice on this machine");
    return;
  }
  const pdf = await renderPdfRendition(await buildHwpxFixture(), "hwpx");
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
});
