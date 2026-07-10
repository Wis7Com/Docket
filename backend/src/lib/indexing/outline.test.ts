import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { chunkTextForIndex } from "./extractors";
import {
  buildChunkSearchText,
  buildPlainTextLines,
  detectDocumentSections,
  extractStructuredPdfText,
  reconstructPdfPageText,
} from "./outline";
import type { StructuredTextLine } from "./types";

function item(
  str: string,
  y: number,
  size = 10,
  fontName = "Body",
  hasEOL = false,
) {
  return {
    str,
    transform: [size, 0, 0, size, 20, y],
    fontName,
    hasEOL,
  };
}

test("PDF reconstruction preserves content-stream order instead of coordinate-sorting", () => {
  const page = reconstructPdfPageText({
    items: [item("stream-first", 100), item("stream-second", 200)],
  });

  assert.equal(page.text, "stream-first stream-second");
  assert.deepEqual(
    page.lines.map((line) => line.text),
    ["stream-first", "stream-second"],
  );
});

test("PDF reconstruction retains repeated header text in raw content", () => {
  const page = reconstructPdfPageText({
    items: [
      item("CONFIDENTIAL", 800, 12, "HeaderBold", true),
      item("Evidence text quoted by the user.", 700, 10, "Body", true),
      item("1", 30, 10, "Body"),
    ],
    styles: { HeaderBold: { fontFamily: "Example Bold" } },
  });

  assert.equal(page.text, "CONFIDENTIAL Evidence text quoted by the user. 1");
  assert.equal(page.lines[0].bold, true);
});

test("pdfjs extraction supplies page-backed section offsets", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("# PDF Heading", { x: 50, y: 730, size: 18, font });
  page.drawText("Raw citation body remains evidence text.", {
    x: 50,
    y: 690,
    size: 10,
    font,
  });
  const bytes = await pdf.save();
  const raw = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  const extracted = await extractStructuredPdfText(raw);
  assert.equal(
    extracted.text,
    "[Page 1]\n# PDF Heading Raw citation body remains evidence text.",
  );
  assert.equal(extracted.sections[0].path, "p. 1 · PDF Heading");
  const chunks = chunkTextForIndex(extracted.text, extracted.sections);
  assert.equal(chunks[0].content.includes("p. 1 ·"), false);
  assert.equal(chunks[0].section_path, "p. 1 · PDF Heading");
});

test("repeating page-edge headers are excluded only as heading candidates", () => {
  const pageBodies = [
    ["Introduction", "A long ordinary body paragraph for the first page"],
    ["Body two", "A long ordinary body paragraph for the second page"],
    ["Body three", "A long ordinary body paragraph for the third page"],
  ];
  const text = pageBodies
    .map(
      ([lead, body], index) =>
        `[Page ${index + 1}]\nCONFIDENTIAL\n${lead}\n${body}\n${index + 1}`,
    )
    .join("\n\n");
  const lines: StructuredTextLine[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const pageStart = text.indexOf(
      `CONFIDENTIAL`,
      text.indexOf(`[Page ${page}]`),
    );
    const bodyText =
      page === 1 ? "Introduction" : `Body ${page === 2 ? "two" : "three"}`;
    const bodyStart = text.indexOf(bodyText, pageStart);
    const paragraphText = pageBodies[page - 1][1];
    const paragraphStart = text.indexOf(paragraphText, bodyStart);
    const footerText = String(page);
    const footerStart = text.indexOf(
      footerText,
      paragraphStart + paragraphText.length,
    );
    lines.push(
      {
        page_number: page,
        line_index: 0,
        text: "CONFIDENTIAL",
        start_char: pageStart,
        end_char: pageStart + "CONFIDENTIAL".length,
        font_size: 16,
        bold: true,
      },
      {
        page_number: page,
        line_index: 1,
        text: bodyText,
        start_char: bodyStart,
        end_char: bodyStart + bodyText.length,
        font_size: page === 1 ? 14 : 10,
        bold: page === 1,
      },
      {
        page_number: page,
        line_index: 2,
        text: paragraphText,
        start_char: paragraphStart,
        end_char: paragraphStart + paragraphText.length,
        font_size: 10,
        bold: false,
      },
      {
        page_number: page,
        line_index: 3,
        text: footerText,
        start_char: footerStart,
        end_char: footerStart + footerText.length,
        font_size: 10,
        bold: false,
      },
    );
  }

  const sections = detectDocumentSections(text, lines);
  assert.ok(text.includes("CONFIDENTIAL"));
  assert.equal(
    sections.some((section) => section.title === "CONFIDENTIAL"),
    false,
  );
  assert.equal(
    sections.some((section) => section.title === "Introduction"),
    true,
  );
});

test("western, Korean, and Markdown headings produce stable hierarchical paths", () => {
  const markdown = [
    "# Project Map",
    "Introductory body",
    "## Connecting Factors",
    "Analysis body",
  ].join("\n");
  const markdownSections = detectDocumentSections(
    markdown,
    buildPlainTextLines(markdown),
  );
  assert.deepEqual(
    markdownSections.map((section) => section.path),
    [
      "offset 0 · Project Map",
      `offset ${markdown.indexOf("## Connecting")} · Project Map > Connecting Factors`,
    ],
  );

  const western = "PART I General Framework\nBody\n1.2 Applicable Law\nBody";
  const westernSections = detectDocumentSections(western);
  assert.equal(
    westernSections[1].path,
    `offset ${western.indexOf("1.2")} · PART I General Framework > 1.2 Applicable Law`,
  );

  const korean = "제1장 총칙\n본문\n제1조(목적)\n본문";
  const koreanSections = detectDocumentSections(korean);
  assert.equal(
    koreanSections[1].path,
    `offset ${korean.indexOf("제1조")} · 제1장 총칙 > 제1조(목적)`,
  );
});

test("uniform body text and numbered sentences do not invent sections", () => {
  const text = [
    "This paragraph discusses the applicable legal framework.",
    "1. This agreement shall remain effective for three years.",
    "Another paragraph contains ordinary prose and evidence.",
    "관련 법률관계를 설명하는 일반적인 본문입니다.",
  ].join("\n");

  assert.deepEqual(detectDocumentSections(text), []);
  const chunks = chunkTextForIndex(text);
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].section_path, null);
  assert.equal(chunks[0].search_text, chunks[0].content);
});

test("chunks carry section paths while citation content stays unmodified", () => {
  const words = Array.from({ length: 720 }, (_, index) => `word${index}`).join(
    " ",
  );
  const text = `# Evidence Map\n${words}`;
  const chunks = chunkTextForIndex(text);

  assert.equal(chunks.length, 2);
  assert.match(chunks[0].section_path ?? "", /^offset 0 · Evidence Map$/);
  assert.equal(chunks[1].section_path, chunks[0].section_path);
  assert.ok(chunks[0].content.startsWith("# Evidence Map\nword0"));
  assert.equal(chunks[0].content.includes("offset 0 ·"), false);
  assert.equal(
    chunks[0].search_text,
    buildChunkSearchText(chunks[0].content, chunks[0].section_path),
  );
});

test("page-backed section paths use stable page locations and no chunk ids", () => {
  const text = "[Page 7]\n## Remedies\nThe court may grant relief.";
  const chunks = chunkTextForIndex(text);

  assert.equal(chunks[0].page_number, 7);
  assert.equal(chunks[0].section_path, "p. 7 · Remedies");
  assert.equal(chunks[0].section_path?.includes("chunk"), false);
});
