import test from "node:test";
import assert from "node:assert/strict";
import { docxToPdf } from "./convert";
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
