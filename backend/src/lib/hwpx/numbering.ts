/**
 * HWP generates list numbers at render time — "1.", "가.", "(3)" never appear
 * in the stored text. For a legal document those markers are how people cite
 * ("청구취지 2.나."), so extraction has to regenerate them.
 */

const HANGUL_SYLLABLES = "가나다라마바사아자차카타파하";
const HANGUL_JAMO = "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ";
const CIRCLED_DIGIT_BASE = 0x2460; // ①
const CIRCLED_DIGIT_MAX = 20;
const CIRCLED_HANGUL_BASE = 0x326e; // ㉮
const CIRCLED_JAMO_BASE = 0x3260; // ㉠
const CIRCLED_LATIN_CAPITAL_BASE = 0x24b6; // Ⓐ
const CIRCLED_LATIN_SMALL_BASE = 0x24d0; // ⓐ
const HANJA_DIGITS = "一二三四五六七八九十";

const ROMAN: [number, string][] = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

function roman(value: number): string {
  let rest = value;
  let out = "";
  for (const [unit, glyph] of ROMAN) {
    while (rest >= unit) {
      out += glyph;
      rest -= unit;
    }
  }
  return out;
}

/** Spreadsheet-style: 1 → A, 26 → Z, 27 → AA. */
function latin(value: number): string {
  let rest = value;
  let out = "";
  while (rest > 0) {
    rest -= 1;
    out = String.fromCharCode(65 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

function fromSequence(value: number, sequence: string): string {
  return value <= sequence.length ? sequence[value - 1] : String(value);
}

function fromCodePoint(value: number, base: number, max: number): string {
  return value <= max ? String.fromCodePoint(base + value - 1) : String(value);
}

export function formatNumber(value: number, numFormat: string): string {
  if (value < 1) return String(value);
  switch (numFormat) {
    case "CIRCLED_DIGIT":
      return fromCodePoint(value, CIRCLED_DIGIT_BASE, CIRCLED_DIGIT_MAX);
    case "ROMAN_CAPITAL":
      return roman(value);
    case "ROMAN_SMALL":
      return roman(value).toLowerCase();
    case "LATIN_CAPITAL":
      return latin(value);
    case "LATIN_SMALL":
      return latin(value).toLowerCase();
    case "CIRCLED_LATIN_CAPITAL":
      return fromCodePoint(value, CIRCLED_LATIN_CAPITAL_BASE, 26);
    case "CIRCLED_LATIN_SMALL":
      return fromCodePoint(value, CIRCLED_LATIN_SMALL_BASE, 26);
    case "HANGUL_SYLLABLE":
      return fromSequence(value, HANGUL_SYLLABLES);
    case "CIRCLED_HANGUL_SYLLABLE":
      return fromCodePoint(value, CIRCLED_HANGUL_BASE, HANGUL_SYLLABLES.length);
    case "HANGUL_JAMO":
      return fromSequence(value, HANGUL_JAMO);
    case "CIRCLED_HANGUL_JAMO":
      return fromCodePoint(value, CIRCLED_JAMO_BASE, HANGUL_JAMO.length);
    case "IDEOGRAPH":
      return fromSequence(value, HANJA_DIGITS);
    default:
      return String(value);
  }
}

export interface NumberingLevel {
  /** e.g. "^1." or "(^3)"; `^N` means "this level". */
  format: string;
  numFormat: string;
  start: number;
}

export interface NumberingDefinition {
  levels: NumberingLevel[];
}

/**
 * Running counters for one numbering definition. Advancing a level resets
 * every deeper level, which is what makes "2." restart "가." underneath it.
 */
export class NumberingCounter {
  private counts: number[] = [];

  constructor(private readonly definition: NumberingDefinition) {}

  /** `level` is zero-based, matching the `level` attribute on hh:heading. */
  next(level: number): string {
    const spec = this.definition.levels[level];
    if (!spec) return "";
    const current = this.counts[level] ?? spec.start - 1;
    // Assigned by index, not appended: a document can open at "가." without
    // ever visiting "1.", and the skipped parents must stay as holes so this
    // level's count lands where the next call will look for it.
    const counts = this.counts.slice(0, level);
    counts[level] = current + 1;
    this.counts = counts;
    return spec.format.replace(/\^(N|\d+)/g, (_match, ref: string) => {
      const target = ref === "N" ? level : Number(ref) - 1;
      const targetSpec = this.definition.levels[target];
      if (!targetSpec) return "";
      const value = this.counts[target] ?? targetSpec.start;
      return formatNumber(value, targetSpec.numFormat);
    });
  }
}
