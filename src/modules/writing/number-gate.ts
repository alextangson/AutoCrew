/**
 * 数字硬门（P1 spec §4.4 / codex #17 #18 #19）——成稿里的每个数字都必须在证据账本里找得到同值同单位的出处。
 *
 * P0c 的「31/31 数字有据」是字符串级匹配：`5` 能命中 `15`，`30%` 能配上 `30 元`。本模块改成
 * **归一元组匹配**：正文与账本引文都过同一个抽取器，比的是 `{value, unit family}`，不是字符串。
 *
 * 三条口径值得记住：
 * 1. 只豁免有明确语法角色的数字（第 N、列表编号、版本号）；年份与时间单位照验（codex #18）。
 * 2. 无法确定的模糊量词（十几、数十）标 `needsHuman`，是 advisory 不是放行——不静默通过，也不硬拦。
 * 3. 中文单字数词 + 量词（一个、两次）是行文量词不是数据点，直接不抽——否则硬门会把每句白话都拦下来，
 *    模型永远修不完。写成阿拉伯数字（3 个）就当数据点验，因为写数字本身就是在给读者「这是数据」的信号。
 */

import type { LedgerEntry, LedgerSource } from "../research/evidence-ledger.js";

export type NumberKind = "arabic" | "chinese" | "percent" | "range";
export type NumberRole = "ordinal" | "version" | "list" | "year" | "duration" | "plain";
export type ScriptField = "title" | "hook" | "body" | "cta";

export interface ScriptFields {
  title: string;
  hook: string;
  body: string;
  cta: string;
}

export interface NumberMention {
  /** 原文片段（含单位），反馈给模型时逐字展示 */
  raw: string;
  /** 归一后的数值（已乘 scale）；模糊量词为 null */
  value: number | null;
  /** 原文里出现的量级倍数：1 / 1e4（万）/ 1e8（亿） */
  scale: number;
  /** 单位族（percent / percent_point / cny / second / count …），无单位为 undefined */
  unit?: string;
  kind: NumberKind;
  role: NumberRole;
  /** 模糊/近似量词，人工确认项（不拦门） */
  needsHuman: boolean;
  /** 在所属字段文本中的起始下标 */
  index: number;
  /** kind === "range" 时的区间端点 */
  range?: { min: number; max: number };
}

export interface FieldNumberMention extends NumberMention {
  field: ScriptField;
  /** 前后各 20 字的上下文，反馈用 */
  context: string;
}

/** 账本类型只有一份真相，在 research/evidence-ledger.ts；这里只转出去给写稿侧用 */
export type { LedgerEntry, LedgerSource };

export interface VerifiedNumber {
  mention: FieldNumberMention;
  entryId: string;
  source: LedgerSource;
}

export interface NumberVerdict {
  verified: VerifiedNumber[];
  unverified: FieldNumberMention[];
  needsHuman: FieldNumberMention[];
  exempt: FieldNumberMention[];
}

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_MAG: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 1e4, 亿: 1e8 };

/** 单位表：长的排前面（个月 先于 月，百分点 先于 百分）。family 决定兼容性。 */
const UNITS: ReadonlyArray<readonly [string, string]> = [
  ["百分点", "percent_point"], ["个百分点", "percent_point"],
  ["%", "percent"], ["％", "percent"], ["个点", "percent_point"],
  ["个月", "month"], ["分钟", "minute"], ["秒钟", "second"], ["小时", "hour"],
  ["美元", "usd"], ["人民币", "cny"], ["万元", "cny"], ["元", "cny"], ["块钱", "cny"], ["块", "cny"],
  ["秒", "second"], ["天", "day"], ["日", "day"], ["周", "week"], ["星期", "week"],
  ["月", "month"], ["年", "year"], ["岁", "age"], ["倍", "multiple"],
  ["个", "count"], ["人", "count"], ["次", "count"], ["家", "count"], ["条", "count"],
  ["款", "count"], ["篇", "count"], ["台", "count"], ["种", "count"], ["项", "count"],
  ["份", "count"], ["张", "count"], ["名", "count"], ["位", "count"], ["步", "count"],
  ["轮", "count"], ["遍", "count"], ["页", "count"], ["行", "count"], ["字", "count"],
];

const DURATION_FAMILIES = new Set(["second", "minute", "hour", "day", "week", "month", "year"]);
/** 近似量词：抽出来标 needsHuman，不猜数值 */
const APPROX_RE =
  /^(?:好几十|好几百|好几千|十几万|十几|几十万|几十|数十|数百|几百|数千|几千|数万|几万|数亿|几亿|十来|数百万|几百万|若干)/;
const CN_EXPR_SRC = "(?:[零〇一二两三四五六七八九十百千万亿]|\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)+";
const CN_EXPR_RE = new RegExp(`^${CN_EXPR_SRC}`);
const ARABIC_SCI_RE = /^-?\d+(?:\.\d+)?[eE][+-]?\d+/;
const VERSION_RE = /^(?:[vV]\d+(?:\.\d+)+|\d+(?:\.\d+){2,})(?:[-+][0-9A-Za-z.]+)?/;
const RANGE_SEP_RE = /^\s*(?:-|–|—|~|～|至|到)\s*/;
const SIGN_RE = /^[-−]/;
const START_CHARS = /[0-9零〇一二两三四五六七八九十百千万亿第vV半数几−-]/;
/** `GPT-4`、`V4`、`o3`：紧跟字母的数字是型号不是数据点，不进硬门 */
const IDENTIFIER_TAIL_RE = /[A-Za-z][-_]?$/;

/** 全角数字/百分号归一；1:1 替换，下标不变 */
function normalize(text: string): string {
  return text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/．/g, ".");
}

/** 混合数字表达式求值：九万五千 / 9万5千 / 9.5万 / 95,386 / 二〇二六 走同一条路径 */
function parseMixedNumber(expr: string): { value: number; scale: number } | null {
  let total = 0;
  let section = 0;
  let current: number | null = null;
  let scale = 1;
  let i = 0;
  let sawDigit = false;
  let prevWasCnDigit = false;
  while (i < expr.length) {
    const ch = expr[i];
    const numMatch = /^(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/.exec(expr.slice(i));
    if (numMatch) {
      current = Number(numMatch[0].replace(/,/g, ""));
      if (!Number.isFinite(current)) return null;
      i += numMatch[0].length;
      sawDigit = true;
      prevWasCnDigit = false;
      continue;
    }
    const digit = CN_DIGIT[ch];
    if (digit !== undefined) {
      current = prevWasCnDigit && current !== null ? current * 10 + digit : digit;
      i += 1;
      sawDigit = true;
      prevWasCnDigit = true;
      continue;
    }
    const mag = CN_MAG[ch];
    if (mag === undefined) return null;
    if (mag >= 1e4) {
      scale = Math.max(scale, mag);
      const base = section + (current ?? 0) || 1;
      total += base * mag;
      section = 0;
    } else {
      section += (current ?? 1) * mag;
    }
    current = null;
    i += 1;
    sawDigit = true;
    prevWasCnDigit = false;
  }
  if (!sawDigit) return null;
  return { value: total + section + (current ?? 0), scale };
}

function matchUnit(text: string, pos: number): { raw: string; family: string } | null {
  const rest = text.slice(pos);
  const spaced = /^\s*/.exec(rest)?.[0].length ?? 0;
  const body = rest.slice(spaced);
  for (const [surface, family] of UNITS) {
    if (body.startsWith(surface)) return { raw: rest.slice(0, spaced + surface.length), family };
  }
  return null;
}

function roleFor(value: number | null, unit: string | undefined, raw: string): NumberRole {
  if (unit && DURATION_FAMILIES.has(unit)) {
    const isYear =
      unit === "year" && value !== null && Number.isInteger(value) && value >= 1900 && value <= 2199;
    return isYear ? "year" : "duration";
  }
  if (!unit && value !== null && Number.isInteger(value) && value >= 1900 && value <= 2199 && /^\d{4}$/.test(raw)) {
    return "year";
  }
  return "plain";
}

function kindFor(unit: string | undefined, sawChinese: boolean): NumberKind {
  if (unit === "percent") return "percent";
  return sawChinese ? "chinese" : "arabic";
}

interface ScanState {
  text: string;
  i: number;
  out: NumberMention[];
}

/** 列表编号的位置：行首，或紧跟在句末标点后（`1. …；2. …` 这种行内枚举同样是编号不是数据） */
function atListPosition(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "\n") return true;
    if ("；;。！!？?".includes(ch)) return true;
    if (ch !== " " && ch !== "\t" && ch !== "　") return false;
  }
  return true;
}

/** 第 N 条 / 第三章 → ordinal（豁免） */
function scanOrdinal(s: ScanState): NumberMention | null {
  const rest = s.text.slice(s.i);
  if (!rest.startsWith("第")) return null;
  const after = /^第\s*/.exec(rest)?.[0].length ?? 1;
  const expr = CN_EXPR_RE.exec(rest.slice(after));
  if (!expr) return null;
  const parsed = parseMixedNumber(expr[0]);
  const unitHit = matchUnit(s.text, s.i + after + expr[0].length);
  const raw = rest.slice(0, after + expr[0].length + (unitHit?.raw.length ?? 0));
  return {
    raw, value: parsed?.value ?? null, scale: parsed?.scale ?? 1, unit: unitHit?.family,
    kind: /[零〇一二两三四五六七八九十百千万亿]/.test(expr[0]) ? "chinese" : "arabic",
    role: "ordinal", needsHuman: false, index: s.i,
  };
}

function scanVersion(s: ScanState): NumberMention | null {
  const m = VERSION_RE.exec(s.text.slice(s.i));
  if (!m) return null;
  return { raw: m[0], value: null, scale: 1, kind: "arabic", role: "version", needsHuman: false, index: s.i };
}

function scanApprox(s: ScanState): NumberMention | null {
  const m = APPROX_RE.exec(s.text.slice(s.i));
  if (!m) return null;
  const unitHit = matchUnit(s.text, s.i + m[0].length);
  return {
    raw: m[0] + (unitHit?.raw ?? ""), value: null, scale: 1, unit: unitHit?.family,
    kind: "chinese", role: "plain", needsHuman: true, index: s.i,
  };
}

/** 百分之三十 / 三分之一 */
function scanFraction(s: ScanState): NumberMention | null {
  const rest = s.text.slice(s.i);
  const pct = new RegExp(`^百分之(${CN_EXPR_SRC})`).exec(rest);
  if (pct) {
    const parsed = parseMixedNumber(pct[1]);
    return {
      raw: pct[0], value: parsed?.value ?? null, scale: 1, unit: "percent",
      kind: "percent", role: "plain", needsHuman: parsed === null, index: s.i,
    };
  }
  const frac = new RegExp(`^(${CN_EXPR_SRC})分之(${CN_EXPR_SRC})`).exec(rest);
  if (!frac) return null;
  const denom = parseMixedNumber(frac[1]);
  const numer = parseMixedNumber(frac[2]);
  const value = denom && numer && denom.value !== 0 ? numer.value / denom.value : null;
  return {
    raw: frac[0], value, scale: 1, kind: "chinese", role: "plain",
    needsHuman: value === null, index: s.i,
  };
}

function scanRange(s: ScanState): NumberMention | null {
  const rest = s.text.slice(s.i);
  const left = CN_EXPR_RE.exec(rest);
  if (!left) return null;
  const sep = RANGE_SEP_RE.exec(rest.slice(left[0].length));
  if (!sep) return null;
  const afterSep = left[0].length + sep[0].length;
  const right = CN_EXPR_RE.exec(rest.slice(afterSep));
  if (!right) return null;
  const a = parseMixedNumber(left[0]);
  const b = parseMixedNumber(right[0]);
  if (!a || !b) return null;
  const unitHit = matchUnit(s.text, s.i + afterSep + right[0].length);
  const raw = rest.slice(0, afterSep + right[0].length + (unitHit?.raw.length ?? 0));
  return {
    raw, value: null, scale: Math.max(a.scale, b.scale), unit: unitHit?.family, kind: "range",
    role: "plain", needsHuman: false, index: s.i,
    range: { min: Math.min(a.value, b.value), max: Math.max(a.value, b.value) },
  };
}

function scanHalf(s: ScanState): NumberMention | null {
  const rest = s.text.slice(s.i);
  const m = /^(?:一半|半)/.exec(rest);
  if (!m) return null;
  const unitHit = matchUnit(s.text, s.i + m[0].length);
  return {
    raw: m[0] + (unitHit?.raw ?? ""), value: 0.5, scale: 1, unit: unitHit?.family,
    kind: "chinese", role: "plain", needsHuman: false, index: s.i,
  };
}

function scanScientific(s: ScanState): NumberMention | null {
  const sign = SIGN_RE.exec(s.text.slice(s.i))?.[0] ?? "";
  const m = ARABIC_SCI_RE.exec(s.text.slice(s.i + sign.length));
  if (!m) return null;
  const unitHit = matchUnit(s.text, s.i + sign.length + m[0].length);
  const value = Number(m[0]) * (sign ? -1 : 1);
  return {
    raw: sign + m[0] + (unitHit?.raw ?? ""), value, scale: 1, unit: unitHit?.family,
    kind: kindFor(unitHit?.family, false), role: roleFor(value, unitHit?.family, m[0]),
    needsHuman: false, index: s.i,
  };
}

/** 主体：混合数字表达式 + 可选单位；「三成」= 30% 在这里收 */
function scanNumeric(s: ScanState): NumberMention | null {
  const sign = SIGN_RE.exec(s.text.slice(s.i))?.[0] ?? "";
  const rest = s.text.slice(s.i + sign.length);
  const expr = CN_EXPR_RE.exec(rest);
  if (!expr) return null;
  const raw0 = parseMixedNumber(expr[0]);
  if (!raw0) return null;
  const parsed = { value: sign ? -raw0.value : raw0.value, scale: raw0.scale };
  const sawChinese = /[零〇一二两三四五六七八九十百千万亿]/.test(expr[0]);
  const afterExpr = s.i + sign.length + expr[0].length;
  const cheng = /^\s*成(?![功交本熟长为])/.exec(s.text.slice(afterExpr));
  if (cheng && parsed.value <= 10) {
    return {
      raw: sign + expr[0] + cheng[0], value: parsed.value * 10, scale: 1, unit: "percent",
      kind: "percent", role: "plain", needsHuman: false, index: s.i,
    };
  }
  const unitHit = matchUnit(s.text, afterExpr);
  // 行文量词豁免：中文单字数词 + 量词（一个、两次）不是数据点
  if (sawChinese && expr[0].length === 1 && unitHit?.family === "count") return null;
  // 「一块主板」「两块板子」：块 在这里是量词不是「元」；只有「一块钱」「三块多」才是钱
  if (sawChinese && expr[0].length === 1 && unitHit?.raw === "块" && !/^[钱多]/.test(s.text.slice(afterExpr + 1))) return null;
  if (sawChinese && expr[0].length === 1 && !unitHit) return null;
  const raw = sign + expr[0] + (unitHit?.raw ?? "");
  const listRole = !sawChinese && atListPosition(s.text, s.i) && /^\s*[.、)）]/.test(s.text.slice(afterExpr));
  return {
    raw, value: parsed.value, scale: parsed.scale, unit: unitHit?.family,
    kind: kindFor(unitHit?.family, sawChinese),
    role: listRole ? "list" : roleFor(parsed.value, unitHit?.family, expr[0]),
    needsHuman: false, index: s.i,
  };
}

const SCANNERS = [scanVersion, scanOrdinal, scanApprox, scanFraction, scanRange, scanHalf, scanScientific, scanNumeric];

/**
 * 抽取一段文本里所有需要证据的数字。扫描按位置从左到右，命中即跳过整段 raw——
 * 同一个数字不会被两个规则重复计。
 */
/**
 * 证据编号里的数字不是数据点：写作包要求「引用时带 id」，正文里会出现 `ev-T1.1`、`om:abc-3`、
 * `user-2` 这类 token（P3 真机 2026-09-06：四个编号被当成 1/2/3/4 打回）。等长掩成空格，下标不变。
 */
const EVIDENCE_ID_RE = /(?:ev|om|user)[-:][A-Za-z0-9][A-Za-z0-9.-]*/g;
function maskEvidenceIds(text: string): string {
  return text.replace(EVIDENCE_ID_RE, (m) => " ".repeat(m.length));
}

export function extractNumbers(text: string): NumberMention[] {
  const norm = maskEvidenceIds(normalize(text));
  const state: ScanState = { text: norm, i: 0, out: [] };
  while (state.i < norm.length) {
    const ch = norm[state.i];
    if (!START_CHARS.test(ch)) {
      state.i += 1;
      continue;
    }
    // 紧跟数字的连字符是区间分隔符的残余（区间已在左端点整段消费），不是负号
    if ((ch === "-" || ch === "−") && /\d/.test(norm[state.i - 1] ?? "")) {
      state.i += 1;
      continue;
    }
    if (/[0-9-−]/.test(ch) && IDENTIFIER_TAIL_RE.test(norm.slice(Math.max(0, state.i - 2), state.i))) {
      state.i += 1;
      continue;
    }
    let hit: NumberMention | null = null;
    for (const scan of SCANNERS) {
      hit = scan(state);
      if (hit) break;
    }
    if (!hit || hit.raw.length === 0) {
      state.i += 1;
      continue;
    }
    state.out.push(hit);
    state.i += hit.raw.length;
  }
  return state.out;
}

const EXEMPT_ROLES = new Set<NumberRole>(["ordinal", "version", "list"]);

/** 单位兼容表：数值相等还不够，口径不同就是两个数（codex #17：`30%` ≠ `30 元`） */
function unitCompatible(mention: NumberMention, quote: NumberMention): boolean {
  const a = mention.unit;
  const b = quote.unit;
  if (a === b) return true;
  // 年份自证：引文里裸写 2026 与写成 2026 年是同一件事
  if (mention.role === "year" && (b === undefined || b === "year")) return true;
  if (a === undefined && b === "count") return true;
  if (a === "count" && b === undefined) return true;
  return false;
}

function valueEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function matches(mention: NumberMention, quote: NumberMention): boolean {
  if (!unitCompatible(mention, quote)) return false;
  if (mention.kind === "range" || quote.kind === "range") {
    if (!mention.range || !quote.range) return false;
    return valueEqual(mention.range.min, quote.range.min) && valueEqual(mention.range.max, quote.range.max);
  }
  if (mention.value === null || quote.value === null) return false;
  return valueEqual(mention.value, quote.value);
}

const SOURCE_RANK: Record<LedgerSource, number> = { verified_quote: 0, own_claim: 1, user_claim: 2 };

function contextAround(text: string, index: number, rawLength: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + rawLength + 20);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function collectFieldMentions(fields: ScriptFields): FieldNumberMention[] {
  const out: FieldNumberMention[] = [];
  for (const field of ["title", "hook", "body", "cta"] as const) {
    const text = normalize(fields[field]);
    for (const mention of extractNumbers(text)) {
      out.push({ ...mention, field, context: contextAround(text, mention.index, mention.raw.length) });
    }
  }
  return out;
}

/**
 * 逐字段核验。`[未证实]` 这类文本标记在这里没有任何特权——带标记的数字照样进 unverified。
 * 命中 own_claim / user_claim 也算过门，但来源标签透出去，展示与审稿自己决定怎么用（spec §4.4 来源分级）。
 */
export function verifyNumbers(fields: ScriptFields, entries: readonly LedgerEntry[]): NumberVerdict {
  const index = entries.map((entry) => ({
    entry,
    mentions: extractNumbers(normalize(entry.quote)).filter((m) => m.role !== "version"),
  }));
  const verdict: NumberVerdict = { verified: [], unverified: [], needsHuman: [], exempt: [] };
  for (const mention of collectFieldMentions(fields)) {
    if (EXEMPT_ROLES.has(mention.role)) {
      verdict.exempt.push(mention);
      continue;
    }
    if (mention.needsHuman) {
      verdict.needsHuman.push(mention);
      continue;
    }
    const hits = index.filter((e) => e.mentions.some((q) => matches(mention, q)));
    if (hits.length === 0) {
      verdict.unverified.push(mention);
      continue;
    }
    hits.sort((a, b) => SOURCE_RANK[a.entry.source] - SOURCE_RANK[b.entry.source]);
    verdict.verified.push({ mention, entryId: hits[0].entry.id, source: hits[0].entry.source });
  }
  return verdict;
}

const FIELD_LABEL: Record<ScriptField, string> = { title: "标题", hook: "钩子", body: "正文", cta: "结尾" };

/** 模型侧的打回文案：每个无据数字给上下文 + 三条允许的改法，别的改法都不接受 */
export function formatNumberGateFeedback(verdict: NumberVerdict): string {
  const blocks: string[] = [];
  if (verdict.unverified.length > 0) {
    const lines = verdict.unverified.map(
      (m) => `- 「${m.raw}」（${FIELD_LABEL[m.field]}）：${m.context}`,
    );
    blocks.push(
      `数字硬门未通过：以下 ${verdict.unverified.length} 处数字在证据账本里找不到同值同单位的出处。\n` +
        `${lines.join("\n")}\n` +
        `每处三选一（没有第四种改法）：\n` +
        `1. 删除——去掉这个数字，改成不带数字的表述；\n` +
        `2. 改成材料里的数——用账本里确实出现的数字，单位口径也要一致（% 和百分点、元不能互换）；\n` +
        `3. 用 find_evidence 查证——查到了再写，查不到就回到 1。\n` +
        `注：写「[未证实]」不算查证，带这个标记的数字同样过不了门。`,
    );
  }
  if (verdict.needsHuman.length > 0) {
    const lines = verdict.needsHuman.map((m) => `- 「${m.raw}」（${FIELD_LABEL[m.field]}）：${m.context}`);
    blocks.push(`[需人工确认] 以下模糊量词无法机器核验，不拦你，但请确认材料里撑得住：\n${lines.join("\n")}`);
  }
  if (blocks.length === 0) return "";
  return `${blocks.join("\n\n")}\n修好后重新调用 submit_script 提交完整成稿（全文重交，不是只交修改段）。`;
}
