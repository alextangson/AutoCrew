/**
 * 英文引文里的数字说法（只用于证据引文那一侧）：中文稿引英文报告时，同一个事实写法不同——
 * 「6 倍」↔ "six to one" / "6 to 1"，「半个工作周」↔ "half their work week"，「2025 年 7 月」↔ "July 2025"，
 * 「一年后」↔ "a year later"。主抽取器只认阿拉伯数字和中文数词，这些在它眼里要么没有数，要么缺单位，
 * 数字门就把对得上的句子报成「找不到」。这里把英文写法补抽成同一套 `{value, unit family}`，
 * 比对口径不变：值和单位族都要一致，不同的数照样拦。
 *
 * 只补抽有明确数值的说法；"a few hundred"、"hundreds of" 这类约数不抽。单独的 "one" / "a" 太常见
 * （"one of the"、"a tool"），只在后面跟时间单位、量级词或比例时才算数。
 */

import type { NumberMention } from "./number-gate.js";

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };

const WORD_SRC = [...Object.keys(SMALL), ...Object.keys(TENS), "hundred", ...Object.keys(SCALES)]
  .sort((a, b) => b.length - a.length).join("|");
/** 一串数词（必须以基数词开头，单独的 hundred / million 不算）：six / twenty-five / two hundred fifty thousand / one hundred and twenty */
const LEAD_SRC = [...Object.keys(SMALL), ...Object.keys(TENS)].sort((a, b) => b.length - a.length).join("|");
const WORDS_SRC = `(?:${LEAD_SRC})(?:[\\s-]+(?:and[\\s-]+)?(?:${WORD_SRC}))*`;
const DIGITS_SRC = `\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?`;
const SCALE_SRC = Object.keys(SCALES).join("|");
const NUMBER_RE = new RegExp(
  `(\\$\\s?)?(?<![\\w.,])(?:(${DIGITS_SRC})(?![\\d.,]\\d)(?:\\s+(${SCALE_SRC}|hundred)\\b)?|\\b(${WORDS_SRC})\\b|\\b(an?)\\b)`, "gi",
);

/** 跟在数后面的英文单位；family 与 number-gate 的 UNITS 同名 */
const UNIT_RE = /^[\s-]*(percentage points?|per\s?cent|percent|years?|months?|weeks?|days?|hours?|minutes?|mins?|seconds?)\b/i;
const UNIT_FAMILY: ReadonlyArray<readonly [RegExp, string]> = [
  [/^percentage/i, "percent_point"], [/^per/i, "percent"], [/^year/i, "year"], [/^month/i, "month"],
  [/^week/i, "week"], [/^day/i, "day"], [/^hour/i, "hour"], [/^min/i, "minute"], [/^second/i, "second"],
];
/** 倍数：6 to 1 / six-to-one / 6:1 / 6x / 6-fold / 6 times as(more…) */
const MULTIPLE_RE = /^(?:[\s-]*to[\s-]*(?:1|one)\b|\s?[:∶]\s?1\b|x\b|[\s-]*fold\b|\s+times\s+(?:as|more|larger|higher|faster|bigger|greater|longer|that|the)\b)/i;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = new RegExp(`\\b(${MONTHS.join("|")}|${Object.keys(MONTH_ABBR).join("|")})\\b\\.?`, "gi");

const FRACTIONS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(?:a|one)[\s-]+half\b|\bhalf\b/gi, 0.5],
  [/\b(?:a|one)[\s-]+third\b/gi, 1 / 3], [/\btwo[\s-]+thirds\b/gi, 2 / 3],
  [/\b(?:a|one)[\s-]+quarter\b/gi, 0.25], [/\bthree[\s-]+quarters\b/gi, 0.75],
];

/** 数词串求值；遇到不认识的组合返回 null（宁可不抽也不猜） */
function parseWords(expr: string): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of expr.toLowerCase().split(/[\s-]+/).filter((t) => t && t !== "and")) {
    if (w in SMALL) current += SMALL[w];
    else if (w in TENS) current += TENS[w];
    else if (w === "hundred") current = (current || 1) * 100;
    else if (w in SCALES) { total += (current || 1) * SCALES[w]; current = 0; }
    else return null;
    seen = true;
  }
  return seen ? total + current : null;
}

function mention(raw: string, index: number, value: number, unit?: string): NumberMention {
  return { raw, value, scale: 1, unit, kind: unit === "percent" ? "percent" : "arabic", role: "plain", needsHuman: false, index, citedOnly: true };
}

function unitFamily(surface: string): string | undefined {
  return UNIT_FAMILY.find(([re]) => re.test(surface.trim()))?.[1];
}

function scanNumbers(text: string, out: NumberMention[]): void {
  for (const m of text.matchAll(NUMBER_RE)) {
    const [whole, dollar, digits, scaleWord, words, article] = m;
    const index = m.index ?? 0;
    const after = text.slice(index + whole.length);
    let value: number | null;
    if (digits !== undefined) {
      value = Number(digits.replace(/,/g, ""));
      if (scaleWord) value *= scaleWord.toLowerCase() === "hundred" ? 100 : SCALES[scaleWord.toLowerCase()];
    } else value = words !== undefined ? parseWords(words) : 1;
    if (value === null || !Number.isFinite(value)) continue;
    const multiple = MULTIPLE_RE.exec(after);
    if (multiple) { out.push(mention(whole + multiple[0], index, value, "multiple")); continue; }
    if (dollar) { out.push(mention(whole, index, value, "usd")); continue; }
    const unit = UNIT_RE.exec(after);
    if (unit) { out.push(mention(whole + unit[0], index, value, unitFamily(unit[1]))); continue; }
    // 不带单位：阿拉伯数字主抽取器已经抽过；"one" / "a" 单独出现不是数据点
    const bare = words?.toLowerCase();
    if (digits !== undefined && !scaleWord) continue;
    if (article !== undefined || bare === "one") continue;
    out.push(mention(whole, index, value));
  }
}

function scanMonths(text: string, out: NumberMention[]): void {
  for (const m of text.matchAll(MONTH_RE)) {
    const name = m[1].toLowerCase();
    const index = m.index ?? 0;
    const full = MONTHS.indexOf(name);
    // 缩写和 "May"（也是情态动词）只在紧跟日期或年份时才当月份
    const datedAfter = /^\s+\d/.test(text.slice(index + m[0].length));
    const datedBefore = /\d\s+$/.test(text.slice(0, index));
    if ((full < 0 || name === "may") && !datedAfter && !datedBefore) continue;
    // "March" 作动词时首字母小写；整词月份名也要求首字母大写
    if (m[1][0] !== m[1][0].toUpperCase()) continue;
    out.push(mention(m[0], index, full >= 0 ? full + 1 : MONTH_ABBR[name], "calendar_month"));
  }
}

function scanFractions(text: string, out: NumberMention[]): void {
  for (const [re, value] of FRACTIONS) {
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0;
      // half a year / half an hour → 0.5 年 / 0.5 小时
      const timed = /^\s+an?\s+(years?|months?|weeks?|days?|hours?|minutes?)\b/i.exec(text.slice(index + m[0].length));
      out.push(mention(m[0] + (timed?.[0] ?? ""), index, value, timed ? unitFamily(timed[1]) : undefined));
    }
  }
}

/** 英文引文里的补充数字说法；主抽取器的结果照用，这里只追加 */
export function extractEnglishNumbers(text: string): NumberMention[] {
  const out: NumberMention[] = [];
  scanNumbers(text, out);
  scanMonths(text, out);
  scanFractions(text, out);
  return out;
}
