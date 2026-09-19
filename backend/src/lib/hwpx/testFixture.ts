import JSZip from "jszip";

/**
 * Synthetic HWPX packages for tests. Built by hand from the OWPML element
 * names real Hancom files use, so no real document ever has to be committed.
 */

const NS =
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ' +
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ' +
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ' +
  'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"';

export const HWPX_MIMETYPE = "application/hwp+zip";

/** 1x1 transparent PNG. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export const FIXTURE_HEADER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hh:head ${NS} version="1.4" secCnt="1">
  <hh:refList>
    <hh:fontfaces itemCnt="1">
      <hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0"/></hh:fontface>
    </hh:fontfaces>
    <hh:borderFills itemCnt="2">
      <hh:borderFill id="1"><hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/><hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/></hh:borderFill>
      <hh:borderFill id="2"><hh:leftBorder type="SOLID" width="0.4 mm" color="#FF0000"/><hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/><hc:fillBrush><hc:winBrush faceColor="#DDEEFF" hatchColor="#FF000000" alpha="0"/></hc:fillBrush></hh:borderFill>
    </hh:borderFills>
    <hh:charProperties itemCnt="2">
      <hh:charPr id="0" height="1000" textColor="#000000"><hh:fontRef hangul="0" latin="0"/><hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/></hh:charPr>
      <hh:charPr id="1" height="1600" textColor="#0000FF"><hh:fontRef hangul="0" latin="0"/><hh:bold/><hh:italic/><hh:underline type="BOTTOM" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/></hh:charPr>
    </hh:charProperties>
    <hh:numberings itemCnt="1">
      <hh:numbering id="1" start="0">
        <hh:paraHead start="1" level="1" numFormat="DIGIT">^1.</hh:paraHead>
        <hh:paraHead start="1" level="2" numFormat="HANGUL_SYLLABLE">^2.</hh:paraHead>
      </hh:numbering>
    </hh:numberings>
    <hh:bullets itemCnt="1"><hh:bullet id="1" char="ㅇ" useImage="0"/></hh:bullets>
    <hh:paraProperties itemCnt="5">
      <hh:paraPr id="0"><hh:align horizontal="JUSTIFY" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>
        <hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:margin><hc:intent value="-1400" unit="HWPUNIT"/><hc:left value="1000" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/></hp:case><hp:default><hh:margin><hc:intent value="-2800" unit="HWPUNIT"/><hc:left value="2000" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/></hp:default></hp:switch>
      </hh:paraPr>
      <hh:paraPr id="1"><hh:align horizontal="CENTER" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/></hh:paraPr>
      <hh:paraPr id="2"><hh:align horizontal="LEFT" vertical="BASELINE"/><hh:heading type="NUMBER" idRef="1" level="0"/></hh:paraPr>
      <hh:paraPr id="3"><hh:align horizontal="LEFT" vertical="BASELINE"/><hh:heading type="NUMBER" idRef="1" level="1"/></hh:paraPr>
      <hh:paraPr id="4"><hh:align horizontal="LEFT" vertical="BASELINE"/><hh:heading type="BULLET" idRef="1" level="0"/></hh:paraPr>
    </hh:paraProperties>
  </hh:refList>
</hh:head>`;

function para(
  inner: string,
  attrs = 'paraPrIDRef="0"',
  pageBreak = false,
): string {
  return `<hp:p id="0" ${attrs} styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}">${inner}<hp:linesegarray><hp:lineseg textpos="0"/></hp:linesegarray></hp:p>`;
}

function cell(
  text: string,
  col: number,
  row: number,
  colSpan = 1,
  rowSpan = 1,
  borderFill = "2",
  width = 12000 * colSpan,
  withAddr = true,
): string {
  return (
    `<hp:tc borderFillIDRef="${borderFill}"><hp:subList>` +
    para(`<hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run>`) +
    `</hp:subList>` +
    (withAddr ? `<hp:cellAddr colAddr="${col}" rowAddr="${row}"/>` : "") +
    `<hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/>` +
    `<hp:cellSz width="${width}" height="1000"/></hp:tc>`
  );
}

/**
 * Three columns (3000/6000/9000) where the first cell spans both rows, so
 * the second row only stores the cells for columns 1 and 2 — the way HWPX
 * omits cells covered by a vertical merge.
 */
export function rowSpanSectionXml(withAddr: boolean): string {
  const c = (t: string, col: number, row: number, rs: number, w: number) =>
    cell(t, col, row, 1, rs, "2", w, withAddr);
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${NS}>` +
    para(
      '<hp:run charPrIDRef="0"><hp:tbl rowCnt="2" colCnt="3" borderFillIDRef="2">' +
        `<hp:tr>${c("A", 0, 0, 2, 3000)}${c("B", 1, 0, 1, 6000)}${c("C", 2, 0, 1, 9000)}</hp:tr>` +
        `<hp:tr>${c("D", 1, 1, 1, 6000)}${c("E", 2, 1, 1, 9000)}</hp:tr>` +
        "</hp:tbl></hp:run>",
    ) +
    "</hs:sec>"
  );
}

/** Column 0 is only ever part of a merged cell, so no cell declares it alone. */
export const SPANNED_ONLY_SECTION_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${NS}>` +
  para(
    '<hp:run charPrIDRef="0"><hp:tbl rowCnt="2" colCnt="2" borderFillIDRef="2">' +
      `<hp:tr>${cell("wide", 0, 0, 2, 1, "2", 10000)}</hp:tr>` +
      `<hp:tr>${cell("wide too", 0, 1, 2, 1, "2", 10000)}</hp:tr>` +
      "</hp:tbl></hp:run>",
  ) +
  "</hs:sec>";

/** A numbered paragraph whose first run is a footnote mark. */
export const NOTE_FIRST_SECTION_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${NS}>` +
  para(
    '<hp:run charPrIDRef="0"><hp:ctrl><hp:footNote number="1" suffixChar="41"><hp:subList>' +
      para('<hp:run charPrIDRef="0"><hp:t>주석</hp:t></hp:run>') +
      "</hp:subList></hp:footNote></hp:ctrl><hp:t>본문</hp:t></hp:run>",
    'paraPrIDRef="2"',
  ) +
  "</hs:sec>";

const SEC_PR =
  '<hp:secPr><hp:pagePr landscape="WIDELY" width="59528" height="84188">' +
  '<hp:margin header="4251" footer="2834" gutter="0" left="5669" right="5669" top="2834" bottom="4251"/>' +
  "</hp:pagePr></hp:secPr>";

const HEADER_CTRL =
  "<hp:ctrl><hp:header><hp:subList>" +
  para('<hp:run charPrIDRef="0"><hp:t>머리말 반복 텍스트</hp:t></hp:run>') +
  "</hp:subList></hp:header></hp:ctrl>";

const FOOTNOTE_CTRL =
  '<hp:ctrl><hp:footNote number="1" suffixChar="41" instId="1"><hp:subList>' +
  para(
    '<hp:run charPrIDRef="0"><hp:ctrl><hp:autoNum num="1" numType="FOOTNOTE">' +
      '<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>' +
      "</hp:autoNum></hp:ctrl><hp:t> 대법원 2020다12345 판결 참조</hp:t></hp:run>",
  ) +
  "</hp:subList></hp:footNote></hp:ctrl>";

const TABLE =
  '<hp:tbl rowCnt="2" colCnt="2" borderFillIDRef="2"><hp:sz width="24000" height="2000"/>' +
  `<hp:tr>${cell("구분", 0, 0)}${cell("내용", 1, 0)}</hp:tr>` +
  `<hp:tr>${cell("병합된 셀", 0, 1, 2, 1)}</hp:tr>` +
  "</hp:tbl>";

const PICTURE =
  '<hp:pic><hp:curSz width="7500" height="3750"/>' +
  '<hc:img binaryItemIDRef="image1" bright="0"/>' +
  "<hp:shapeComment>그림입니다.</hp:shapeComment></hp:pic>";

const TEXT_BOX =
  "<hp:rect><hp:drawText><hp:subList>" +
  para('<hp:run charPrIDRef="0"><hp:t>글상자 안의 제목</hp:t></hp:run>') +
  "</hp:subList></hp:drawText><hp:shapeComment>사각형입니다.</hp:shapeComment></hp:rect>";

export const FIXTURE_SECTION0_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${NS}>` +
  para(
    `<hp:run charPrIDRef="1">${SEC_PR}${HEADER_CTRL}<hp:t>손해배상 청구의 소</hp:t></hp:run>`,
    'paraPrIDRef="1"',
  ) +
  para(
    `<hp:run charPrIDRef="0"><hp:t>원고는 피고에게 &amp; 다음과<hp:tab/>같이<hp:lineBreak/>청구한다.</hp:t>${FOOTNOTE_CTRL}</hp:run>`,
  ) +
  para(`<hp:run charPrIDRef="0">${TABLE}</hp:run>`) +
  para(
    '<hp:run charPrIDRef="0"><hp:t>청구취지</hp:t></hp:run>',
    'paraPrIDRef="2"',
  ) +
  para(
    '<hp:run charPrIDRef="0"><hp:t>첫째 항목</hp:t></hp:run>',
    'paraPrIDRef="3"',
  ) +
  para(
    '<hp:run charPrIDRef="0"><hp:t>둘째 항목</hp:t></hp:run>',
    'paraPrIDRef="3"',
  ) +
  para(
    '<hp:run charPrIDRef="0"><hp:t>청구원인</hp:t></hp:run>',
    'paraPrIDRef="2"',
  ) +
  para(
    '<hp:run charPrIDRef="0"><hp:t>글머리 항목</hp:t></hp:run>',
    'paraPrIDRef="4"',
  ) +
  para(`<hp:run charPrIDRef="0">${PICTURE}${TEXT_BOX}</hp:run>`) +
  "</hs:sec>";

export const FIXTURE_SECTION1_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${NS}>` +
  para(
    '<hp:run charPrIDRef="0"><hp:t>두 번째 구역의 본문</hp:t></hp:run>',
    'paraPrIDRef="0"',
    true,
  ) +
  "</hs:sec>";

export interface FixtureOptions {
  /** Extra or replacement zip entries; `null` removes a default entry. */
  entries?: Record<string, string | Buffer | null>;
  compression?: "STORE" | "DEFLATE";
}

export async function buildHwpxFixture(
  options: FixtureOptions = {},
): Promise<Buffer> {
  const entries: Record<string, string | Buffer | null> = {
    mimetype: HWPX_MIMETYPE,
    "Contents/header.xml": FIXTURE_HEADER_XML,
    // section10 sorts before section2 lexically — the reader must order
    // numerically, so the fixture stores the second section out of order.
    "Contents/section1.xml": FIXTURE_SECTION1_XML,
    "Contents/section0.xml": FIXTURE_SECTION0_XML,
    "BinData/image1.png": TINY_PNG,
    "Preview/PrvText.txt": "미리보기",
    ...options.entries,
  };
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    if (content !== null) zip.file(name, content);
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: options.compression ?? "STORE",
  });
}
