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

const LEAD_SRC = [...Object.keys(SMALL), ...Object.keys(TENS)].sort((a, b) => b.length - a.length).join("|");
const WORD_SRC = [LEAD_SRC, "hundred", ...Object.keys(SCALES)].join("|");
/** 一串数词（必须以基数词开头，单独的 hundred / million 不算）：six / twenty-five / two hundred fifty thousand / one hundred and twenty */
const WORDS_SRC = `(?:${LEAD_SRC})(?:[\\s-]+(?:and[\\s-]+)?(?:${WORD_SRC}))*`;
const DIGITS_SRC = `\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?`;
const SCALE_SRC = Object.keys(SCALES).join("|");
const NUMBER_RE = new RegExp(
  `(\\$\\s?)?(?<![\\w.,])(?:(${DIGITS_SRC})(?![\\d.,]\\d)(?:\\s+(${SCALE_SRC}|hundred)\\b)?|\\b(${WORDS_SRC})\\b|\\b(an?)\\b)`, "gi",
);
/** 区间：3-5 years / 3 to 5 / between two and three years；两端都要对上，端点不单独当数 */
const RANGE_END_SRC = `${DIGITS_SRC}|\\b(?:${LEAD_SRC})\\b`;
const RANGE_RE = new RegExp(
  `(?<![\\w.,])(between\\s+)?(${RANGE_END_SRC})\\s*(?:-|–|—|to|and)\\s*(${RANGE_END_SRC})(?![\\d.,]\\d)`, "gi",
);

/** 跟在数后面的英文单位；family 与 number-gate 的 UNITS 同名（欧元/英镑/日元中文侧没有，配不上任何东西，正好不放过） */
const UNIT_RE = /^[\s-]*(percentage points?|per\s?cent|percent|years?|months?|weeks?|days?|hours?|minutes?|mins?|seconds?|dollars?|usd|yuan|rmb|euros?|pounds?|yen)\b/i;
const UNIT_FAMILY: ReadonlyArray<readonly [RegExp, string]> = [
  [/^percentage/i, "percent_point"], [/^per/i, "percent"], [/^year/i, "year"], [/^month/i, "month"],
  [/^week/i, "week"], [/^day/i, "day"], [/^hour/i, "hour"], [/^min/i, "minute"], [/^second/i, "second"],
  [/^(?:dollar|usd)/i, "usd"], [/^(?:yuan|rmb)/i, "cny"], [/^euro/i, "eur"], [/^pound/i, "gbp"], [/^yen/i, "jpy"],
];
/** 倍数：6 to 1 / six-to-one / 6:1 / 6x / 6-fold / 6 times as(more…)；分母必须整个是 1（6 to 1.5 不算） */
const MULTIPLE_RE = /^(?:[\s-]*to[\s-]*(?:1(?![.,]?\d)|one\b)|\s?[:∶]\s?1(?![.,]?\d)|x\b|[\s-]*fold\b|\s+times\s+(?:as|more|larger|higher|faster|bigger|greater|longer|that|the)\b)/i;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = new RegExp(`\\b(${MONTHS.join("|")}|${Object.keys(MONTH_ABBR).join("|")})\\b\\.?`, "gi");

const FRACTIONS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(?:a|one)[\s-]+half\b|\bhalf\b/gi, 0.5],
  [/\b(?:a|one)[\s-]+third\b/gi, 1 / 3], [/\btwo[\s-]+thirds\b/gi, 2 / 3],
  [/\b(?:a|one)[\s-]+quarter\b/gi, 0.25], [/\bthree[\s-]+quarters\b/gi, 0.75],
];

type Prev = "none" | "small" | "tens" | "hundred" | "scale" | "and";

/** 数词串按英文语法求值；不合语法（two and three、two three）返回 null——宁可不抽也不猜 */
function parseWords(expr: string): number | null {
  let total = 0;
  let current = 0;
  let prev: Prev = "none";
  let lastScale = Infinity;
  for (const w of expr.toLowerCase().split(/[\s-]+/).filter(Boolean)) {
    const fresh = prev === "none" || prev === "hundred" || prev === "scale" || prev === "and";
    if (w === "and") { if (prev !== "hundred" && prev !== "scale") return null; prev = "and"; }
    else if (w in SMALL) {
      if (!fresh && !(prev === "tens" && SMALL[w] > 0 && SMALL[w] < 10)) return null;
      current += SMALL[w]; prev = "small";
    } else if (w in TENS) { if (!fresh) return null; current += TENS[w]; prev = "tens"; }
    else if (w === "hundred") { if (prev !== "small" || current === 0) return null; current *= 100; prev = "hundred"; }
    else if (w in SCALES) {
      if (prev === "none" || prev === "and" || prev === "scale" || SCALES[w] >= lastScale || current === 0) return null;
      total += current * SCALES[w]; current = 0; lastScale = SCALES[w]; prev = "scale";
    } else return null;
  }
  return prev === "none" || prev === "and" ? null : total + current;
}

function mention(raw: string, index: number, value: number, unit?: string): NumberMention {
  return { raw, value, scale: 1, unit, kind: unit === "percent" ? "percent" : "arabic", role: "plain", needsHuman: false, index, citedOnly: true };
}

function unitFamily(surface: string): string | undefined {
  return UNIT_FAMILY.find(([re]) => re.test(surface.trim()))?.[1];
}

/** 已被分数 / 区间认领的片段：里面的数不再单独当证据（half an hour 不出 1 hour，3-5 years 不出 5 years） */
type Claimed = Array<readonly [number, number]>;
const isClaimed = (claimed: Claimed, at: number) => claimed.some(([s, e]) => at >= s && at < e);

function endpoint(raw: string): number | null {
  return /^\d/.test(raw) ? Number(raw.replace(/,/g, "")) : parseWords(raw);
}

function scanRanges(text: string, out: NumberMention[], claimed: Claimed): void {
  for (const m of text.matchAll(RANGE_RE)) {
    const [whole, between, left, right] = m;
    const index = m.index ?? 0;
    const sep = whole.slice((between?.length ?? 0) + left.length, whole.length - right.length).trim().toLowerCase();
    if (sep === "and" && !between) continue;
    // twenty-five 是一个数不是区间
    if (sep !== "to" && sep !== "and" && /^[a-z]/i.test(left)) continue;
    // "6 to 1" 是比例不是区间，交给倍数
    if (sep === "to" && /^(?:1|one)$/i.test(right)) continue;
    const a = endpoint(left);
    const b = endpoint(right);
    if (a === null || b === null) continue;
    const unit = UNIT_RE.exec(text.slice(index + whole.length));
    const raw = whole + (unit?.[0] ?? "");
    claimed.push([index, index + raw.length]);
    out.push({ ...mention(raw, index, 0, unit ? unitFamily(unit[1]) : undefined), value: null, kind: "range", range: { min: Math.min(a, b), max: Math.max(a, b) } });
  }
}

/** 数前面单独的负号（不是 3-5、COVID-19 里的连字符）：-5 percent → -5 */
function signAt(text: string, index: number): { sign: number; start: number } | null {
  const dash = text[index - 1];
  if (dash === undefined || !"-−–".includes(dash)) return { sign: 1, start: index };
  return /[\w.,]/.test(text[index - 2] ?? "") ? null : { sign: -1, start: index - 1 };
}

function scanNumbers(text: string, out: NumberMention[], claimed: Claimed): void {
  for (const m of text.matchAll(NUMBER_RE)) {
    const [whole, dollar, digits, scaleWord, words, article] = m;
    const index = m.index ?? 0;
    if (isClaimed(claimed, index)) continue;
    const signed = digits !== undefined && !dollar ? signAt(text, index) : { sign: 1, start: index };
    if (!signed) continue;
    const after = text.slice(index + whole.length);
    let value: number | null;
    if (digits !== undefined) {
      value = Number(digits.replace(/,/g, "")) * signed.sign;
      if (scaleWord) value *= scaleWord.toLowerCase() === "hundred" ? 100 : SCALES[scaleWord.toLowerCase()];
    } else value = words !== undefined ? parseWords(words) : 1;
    if (value === null || !Number.isFinite(value)) continue;
    const raw = text.slice(signed.start, index + whole.length);
    const multiple = MULTIPLE_RE.exec(after);
    if (multiple) { out.push(mention(raw + multiple[0], signed.start, value, "multiple")); continue; }
    if (dollar) { out.push(mention(raw, signed.start, value, "usd")); continue; }
    const unit = UNIT_RE.exec(after);
    if (unit) { out.push(mention(raw + unit[0], signed.start, value, unitFamily(unit[1]))); continue; }
    // 不带单位：阿拉伯数字主抽取器已经抽过；"one" / "a" 单独出现不是数据点
    if (digits !== undefined && !scaleWord) continue;
    if (article !== undefined || words?.toLowerCase() === "one") continue;
    out.push(mention(raw, signed.start, value));
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

function scanFractions(text: string, out: NumberMention[], claimed: Claimed): void {
  for (const [re, value] of FRACTIONS) {
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0;
      if (isClaimed(claimed, index)) continue;
      // half a year / half an hour → 0.5 年 / 0.5 小时
      const timed = /^\s+an?\s+(years?|months?|weeks?|days?|hours?|minutes?)\b/i.exec(text.slice(index + m[0].length));
      const raw = m[0] + (timed?.[0] ?? "");
      claimed.push([index, index + raw.length]);
      out.push(mention(raw, index, value, timed ? unitFamily(timed[1]) : undefined));
    }
  }
}

/** 英文引文里的补充数字说法；主抽取器的结果照用，这里只追加 */
export function extractEnglishNumbers(text: string): NumberMention[] {
  const out: NumberMention[] = [];
  const claimed: Claimed = [];
  scanFractions(text, out, claimed);
  scanRanges(text, out, claimed);
  scanNumbers(text, out, claimed);
  scanMonths(text, out);
  return out;
}
