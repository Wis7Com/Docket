import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  extractHwpxText,
  hwpxToDocx,
  hwpxUploadProblem,
  looksLikeHwpx,
  parseHwpx,
} from "./index";
import { formatNumber, NumberingCounter } from "./numbering";
import { validateHwpx } from "./package";
import type { HwpxBlock, HwpxParagraph, HwpxTable } from "./types";
import {
  buildHwpxFixture,
  FIXTURE_SECTION0_XML,
  NOTE_FIRST_SECTION_XML,
  rowSpanSectionXml,
  SPANNED_ONLY_SECTION_XML,
} from "./testFixture";

function paragraphs(blocks: HwpxBlock[]): HwpxParagraph[] {
  return blocks.filter((b): b is HwpxParagraph => b.kind === "paragraph");
}

function paragraphText(p: HwpxParagraph): string {
  return p.runs.map((r) => r.text).join("");
}

test("extractHwpxText returns body text in section order", async () => {
  const text = await extractHwpxText(await buildHwpxFixture());
  assert.match(text, /손해배상 청구의 소/);
  assert.ok(
    text.indexOf("손해배상 청구의 소") < text.indexOf("두 번째 구역의 본문"),
    "section0 must come before section1 regardless of zip entry order",
  );
});

test("inline controls become whitespace and entities are decoded", async () => {
  const text = await extractHwpxText(await buildHwpxFixture());
  assert.match(text, /원고는 피고에게 & 다음과\t같이\n청구한다\./);
});

test("headers and shape alt-text are dropped; text boxes and footnotes are kept", async () => {
  const text = await extractHwpxText(await buildHwpxFixture());
  assert.doesNotMatch(text, /머리말 반복 텍스트/);
  assert.doesNotMatch(text, /그림입니다|사각형입니다/);
  assert.match(text, /글상자 안의 제목/);
  assert.match(text, /^1\) 대법원 2020다12345 판결 참조$/m);
  assert.doesNotMatch(
    text,
    /청구한다\.1\)/,
    "the superscript note mark stays out of the quotable sentence",
  );
  assert.ok(
    text.indexOf("청구한다.") < text.indexOf("대법원 2020다12345"),
    "footnote text follows its host paragraph",
  );
});

test("table rows are flattened with cell separators", async () => {
  const text = await extractHwpxText(await buildHwpxFixture());
  assert.match(text, /구분 \| 내용/);
  assert.match(text, /병합된 셀/);
});

test("auto-numbered and bulleted paragraphs get their generated prefix", async () => {
  const text = await extractHwpxText(await buildHwpxFixture());
  assert.match(text, /1\. 청구취지/);
  assert.match(text, /가\. 첫째 항목/);
  assert.match(text, /나\. 둘째 항목/);
  // A new level-1 item restarts the level-2 counter.
  assert.match(text, /2\. 청구원인/);
  assert.match(text, /ㅇ 글머리 항목/);
});

test("formatNumber covers the common HWP number formats", () => {
  assert.equal(formatNumber(3, "DIGIT"), "3");
  assert.equal(formatNumber(2, "HANGUL_SYLLABLE"), "나");
  assert.equal(formatNumber(1, "HANGUL_JAMO"), "ㄱ");
  assert.equal(formatNumber(4, "ROMAN_CAPITAL"), "IV");
  assert.equal(formatNumber(4, "ROMAN_SMALL"), "iv");
  assert.equal(formatNumber(27, "LATIN_CAPITAL"), "AA");
  assert.equal(formatNumber(2, "LATIN_SMALL"), "b");
  assert.equal(formatNumber(5, "CIRCLED_DIGIT"), "⑤");
  assert.equal(formatNumber(7, "SOMETHING_UNKNOWN"), "7");
});

test("parseHwpx resolves character and paragraph formatting from header.xml", async () => {
  const doc = await parseHwpx(await buildHwpxFixture());
  assert.equal(doc.sections.length, 2);
  const [title, body] = paragraphs(doc.sections[0].blocks);
  assert.equal(paragraphText(title), "손해배상 청구의 소");
  assert.equal(title.align, "center");
  const run = title.runs[0];
  assert.equal(run.bold, true);
  assert.equal(run.italic, true);
  assert.equal(run.underline, true);
  assert.equal(run.sizePt, 16);
  assert.equal(run.color, "0000FF");
  assert.equal(run.font, "함초롬바탕");
  // The HwpUnitChar <hp:case> carries real HWPUNITs; <hp:default> is the
  // legacy doubled value and must not be used when the case is present.
  assert.equal(body.indent?.left, 1000);
  assert.equal(body.indent?.firstLine, -1400);
  assert.equal(body.lineSpacingPercent, 160);
});

test("parseHwpx keeps page geometry and page breaks", async () => {
  const doc = await parseHwpx(await buildHwpxFixture());
  assert.deepEqual(doc.sections[0].page, {
    width: 59528,
    height: 84188,
    landscape: false,
    margin: { left: 5669, right: 5669, top: 2834, bottom: 4251 },
  });
  assert.equal(paragraphs(doc.sections[1].blocks)[0].pageBreakBefore, true);
});

test("parseHwpx models tables with spans, borders, and fills", async () => {
  const doc = await parseHwpx(await buildHwpxFixture());
  const table = doc.sections[0].blocks.find(
    (b): b is HwpxTable => b.kind === "table",
  );
  assert.ok(table);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].length, 2);
  assert.equal(table.rows[1][0].colSpan, 2);
  assert.deepEqual(table.columnWidths, [12000, 12000]);
  const first = table.rows[0][0];
  assert.equal(first.fill, "DDEEFF");
  assert.deepEqual(first.borders?.left, { widthMm: 0.4, color: "FF0000" });
});

test("parseHwpx resolves embedded images from BinData", async () => {
  const doc = await parseHwpx(await buildHwpxFixture());
  const image = doc.sections[0].blocks.find((b) => b.kind === "image");
  assert.ok(image && image.kind === "image");
  assert.equal(image.format, "png");
  assert.equal(image.width, 7500);
  assert.equal(image.height, 3750);
  assert.ok(image.data.length > 0);
});

test("hwpxToDocx produces a Word package carrying the text and table", async () => {
  const docx = await hwpxToDocx(await buildHwpxFixture());
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file("word/document.xml")!.async("string");
  assert.match(xml, /손해배상 청구의 소/);
  assert.match(xml, /1\. /);
  assert.match(xml, /<w:tbl>/);
  assert.match(xml, /w:gridSpan w:val="2"/);
  assert.match(xml, /대법원 2020다12345 판결 참조/);
  assert.match(xml, /w:vertAlign w:val="superscript"/);
  assert.ok(
    Object.keys(zip.files).some((name) => name.startsWith("word/media/")),
    "embedded image is carried into the DOCX",
  );
});

test("looksLikeHwpx sniffs the package rather than trusting the extension", async () => {
  assert.equal(await looksLikeHwpx(await buildHwpxFixture()), true);
  assert.equal(await looksLikeHwpx(Buffer.from("%PDF-1.7 not a zip")), false);
  const docxLike = new JSZip();
  docxLike.file("word/document.xml", "<w:document/>");
  assert.equal(
    await looksLikeHwpx(await docxLike.generateAsync({ type: "nodebuffer" })),
    false,
  );
});

test("a package without the mimetype entry still parses when sections exist", async () => {
  const buf = await buildHwpxFixture({ entries: { mimetype: null } });
  assert.match(await extractHwpxText(buf), /손해배상 청구의 소/);
});

test("non-HWPX and section-less input is rejected with a clear error", async () => {
  await assert.rejects(
    () => extractHwpxText(Buffer.from("plain bytes")),
    /not a valid HWPX/i,
  );
  const empty = await buildHwpxFixture({
    entries: { "Contents/section0.xml": null, "Contents/section1.xml": null },
  });
  await assert.rejects(() => extractHwpxText(empty), /no body sections/i);
});

test("password-protected packages are reported, not parsed as garbage", async () => {
  const buf = await buildHwpxFixture({
    entries: {
      "META-INF/manifest.xml":
        '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">' +
        '<odf:file-entry odf:full-path="Contents/section0.xml"><odf:encryption-data/></odf:file-entry>' +
        "</odf:manifest>",
    },
  });
  await assert.rejects(() => extractHwpxText(buf), /password-protected/i);
});

test("oversized section XML is refused before parsing", async () => {
  const buf = await buildHwpxFixture({
    entries: {
      "Contents/section0.xml": FIXTURE_SECTION0_XML + " ".repeat(2_000),
    },
  });
  await assert.rejects(
    () => parseHwpx(buf, { maxXmlBytes: 1_000 }),
    /too large/i,
  );
});

test("a missing header.xml degrades to unformatted text instead of failing", async () => {
  const buf = await buildHwpxFixture({
    entries: { "Contents/header.xml": null },
  });
  const text = await extractHwpxText(buf);
  assert.match(text, /손해배상 청구의 소/);
  // Without numbering definitions there is nothing to generate prefixes from.
  assert.match(text, /^청구취지$/m);
});

function onlySection(xml: string) {
  return buildHwpxFixture({
    entries: { "Contents/section0.xml": xml, "Contents/section1.xml": null },
  });
}

function firstTable(blocks: HwpxBlock[]): HwpxTable {
  const table = blocks.find((b): b is HwpxTable => b.kind === "table");
  assert.ok(table);
  return table;
}

test("numbering keeps counting when a document skips straight to a deep level", () => {
  const counter = new NumberingCounter({
    levels: [
      { format: "^1.", numFormat: "DIGIT", start: 1 },
      { format: "^2)", numFormat: "DIGIT", start: 1 },
      { format: "^1.^2.^3.", numFormat: "DIGIT", start: 1 },
    ],
  });
  // Opens at level 3 without ever visiting levels 1 and 2.
  assert.deepEqual(
    [counter.next(2), counter.next(2), counter.next(2)],
    ["1.1.1.", "1.1.2.", "1.1.3."],
  );
  assert.equal(counter.next(0), "1.");
  assert.equal(counter.next(2), "1.1.1.", "a new parent restarts the child");
  assert.equal(counter.next(0), "2.");
  assert.equal(counter.next(1), "1)");
  assert.equal(counter.next(2), "2.1.1.");
});

for (const withAddr of [true, false]) {
  test(`cells after a vertical merge keep their own grid column (cellAddr ${withAddr ? "present" : "absent"})`, async () => {
    const doc = await parseHwpx(await onlySection(rowSpanSectionXml(withAddr)));
    const table = firstTable(doc.sections[0].blocks);
    assert.deepEqual(table.columnWidths, [3000, 6000, 9000]);
    assert.deepEqual(
      table.rows.map((row) => row.map((cell) => cell.col)),
      [
        [0, 1, 2],
        [1, 2],
      ],
    );
  });
}

test("the DOCX sizes cells under a vertical merge from their real columns", async () => {
  const docx = await hwpxToDocx(await onlySection(rowSpanSectionXml(true)));
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file("word/document.xml")!.async("string");
  const rows = xml.split("<w:tr>").slice(1);
  const widths = (row: string) =>
    [...row.matchAll(/<w:tcW w:type="dxa" w:w="(\d+)"\/>/g)].map((m) =>
      Number(m[1]),
    );
  assert.deepEqual(widths(rows[0]), [600, 1200, 1800]);
  // Second row: the merge continuation docx inserts, then D and E at the
  // widths of columns 1 and 2 — not shifted left onto columns 0 and 1.
  assert.deepEqual(widths(rows[1]).slice(-2), [1200, 1800]);
});

test("a column that only ever appears inside merged cells still gets a width", async () => {
  const doc = await parseHwpx(await onlySection(SPANNED_ONLY_SECTION_XML));
  assert.deepEqual(
    firstTable(doc.sections[0].blocks).columnWidths,
    [5000, 5000],
  );
});

test("a generated list number never inherits the footnote-mark style", async () => {
  const doc = await parseHwpx(await onlySection(NOTE_FIRST_SECTION_XML));
  const [paragraph] = paragraphs(doc.sections[0].blocks);
  assert.equal(paragraph.runs[0].text, "1. ");
  assert.equal(paragraph.runs[0].noteRef, undefined);
  assert.equal(paragraph.runs[1].noteRef, true);
});

test("an entry that inflates past the budget is stopped even if the zip under-reports its size", async () => {
  const buf = await buildHwpxFixture({
    entries: {
      "Contents/section0.xml": FIXTURE_SECTION0_XML + " ".repeat(200_000),
    },
    // Deflated, so the declared uncompressed size is its own field and can
    // be forged without touching the compressed length.
    compression: "DEFLATE",
  });
  // Forge the declared size: every 4-byte little-endian copy of the real
  // uncompressed length (local header + central directory) becomes 10.
  const real = Buffer.byteLength(FIXTURE_SECTION0_XML) + 200_000;
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(real);
  const forged = Buffer.from(buf);
  let patched = 0;
  for (
    let at = forged.indexOf(needle);
    at !== -1;
    at = forged.indexOf(needle, at + 4)
  ) {
    forged.writeUInt32LE(10, at);
    patched += 1;
  }
  assert.ok(patched >= 1, "fixture should contain the declared size");
  await assert.rejects(
    () => parseHwpx(forged, { maxXmlBytes: 50_000 }),
    (err: Error) => err.name === "HwpxError" && /too large/i.test(err.message),
  );
});

test("validateHwpx rejects renamed files and protected packages up front", async () => {
  await validateHwpx(await buildHwpxFixture());
  const docxLike = new JSZip();
  docxLike.file("word/document.xml", "<w:document/>");
  await assert.rejects(
    async () =>
      validateHwpx(await docxLike.generateAsync({ type: "nodebuffer" })),
    /not a valid HWPX/i,
  );
  await assert.rejects(
    () => validateHwpx(Buffer.from("junk")),
    /not a valid HWPX/i,
  );
});

test("hwpxUploadProblem explains a refusal and ignores other formats", async () => {
  assert.equal(await hwpxUploadProblem("hwpx", await buildHwpxFixture()), null);
  assert.equal(
    await hwpxUploadProblem("pdf", Buffer.from("not checked")),
    null,
  );
  assert.match(
    (await hwpxUploadProblem("HWPX", Buffer.from("renamed.docx bytes"))) ?? "",
    /not a valid HWPX/i,
  );
});

test("a row fully covered by merges from above keeps later rows in place", async () => {
  const ns =
    'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ' +
    'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"';
  const tc = (text: string, rowSpan: number) =>
    `<hp:tc><hp:subList><hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hp:subList>` +
    `<hp:cellSpan colSpan="1" rowSpan="${rowSpan}"/><hp:cellSz width="5000" height="500"/></hp:tc>`;
  const xml =
    `<hs:sec ${ns}><hp:p><hp:run><hp:tbl rowCnt="3" colCnt="2">` +
    `<hp:tr>${tc("A", 2)}${tc("B", 2)}</hp:tr><hp:tr></hp:tr>` +
    `<hp:tr>${tc("C", 1)}${tc("D", 1)}</hp:tr></hp:tbl></hp:run></hp:p></hs:sec>`;
  const buf = await onlySection(xml);
  const table = firstTable((await parseHwpx(buf)).sections[0].blocks);
  assert.deepEqual(
    table.rows.map((row) => row.map((cell) => cell.col)),
    [[0, 1], [], [0, 1]],
  );
  // The DOCX must still build: docx fills the empty row with merge cells.
  const docx = await hwpxToDocx(buf);
  const out = await (await JSZip.loadAsync(docx))
    .file("word/document.xml")!
    .async("string");
  assert.equal(out.split("<w:tr>").length - 1, 3);
});
