import assert from "node:assert/strict";
import test from "node:test";
import { buildContentDisposition, looksLikePdf } from "./storage";

function toArrayBuffer(input: string | Buffer): ArrayBuffer {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

test("looksLikePdf accepts a normal PDF header", () => {
  assert.equal(looksLikePdf(toArrayBuffer("%PDF-1.7\n…")), true);
});

test("looksLikePdf accepts a header preceded by junk within 1024 bytes", () => {
  const padded = Buffer.concat([
    Buffer.alloc(500, 0x20),
    Buffer.from("%PDF-1.4"),
  ]);
  assert.equal(looksLikePdf(toArrayBuffer(padded)), true);
});

test("looksLikePdf rejects HTML error pages saved as .pdf", () => {
  assert.equal(
    looksLikePdf(toArrayBuffer("<!DOCTYPE html><html><body>404</body></html>")),
    false,
  );
});

test("looksLikePdf rejects JSON and empty buffers", () => {
  assert.equal(looksLikePdf(toArrayBuffer('{"status":"error"}')), false);
  assert.equal(looksLikePdf(new ArrayBuffer(0)), false);
});

test("looksLikePdf rejects a header appearing only after 1024 bytes", () => {
  const late = Buffer.concat([
    Buffer.alloc(1024, 0x20),
    Buffer.from("%PDF-1.4"),
  ]);
  assert.equal(looksLikePdf(toArrayBuffer(late)), false);
});

test("buildContentDisposition keeps fallback filename header-safe for Unicode names", () => {
  const header = buildContentDisposition(
    "inline",
    "한글 문서, 업로드 파일명 예시.pdf",
  );

  assert.doesNotMatch(
    header,
    /[^\x00-\xFF]/,
    "HTTP header values must not contain characters outside latin1",
  );
  assert.match(header, /^inline; filename="[_ ,.\-()]+\.pdf"/);
  assert.match(header, /filename\*=UTF-8''%ED%95%9C/);
});
