import test from "node:test";
import assert from "node:assert/strict";
import { docxToPdf } from "./convert";

test("DOCX to PDF conversion does not launch system LibreOffice unless opted in", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows uses the bundled LibreOffice path when available");
    return;
  }

  const original = process.env.DOCKET_ENABLE_SYSTEM_LIBREOFFICE_PROBE;
  delete process.env.DOCKET_ENABLE_SYSTEM_LIBREOFFICE_PROBE;
  t.after(() => {
    if (original == null) {
      delete process.env.DOCKET_ENABLE_SYSTEM_LIBREOFFICE_PROBE;
    } else {
      process.env.DOCKET_ENABLE_SYSTEM_LIBREOFFICE_PROBE = original;
    }
  });

  await assert.rejects(
    () => docxToPdf(Buffer.from("not a real docx")),
    /System LibreOffice conversion is disabled/,
  );
});
