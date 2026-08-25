/**
 * 清洗的确定性部分（转写纠错 spec §4）：分词、词级对齐、合并防线、防过拟合闸、结果拼装。
 *
 * 与 `transcript-clean.ts` 的分工照抄 rough-cut 那对姊妹文件：那边调模型、分窗、并发、降级；
 * 这边把「模型交回来的一段文字」变成词级产物。切开是因为失败模式完全不同——
 * 这边错了是**算错**（时间戳错位一格，字幕逐词高亮就整句歪掉），那边错了是外部不可用。
 * 本文件**零 IO、零模型**，全是纯函数，用边界用例锁死。
 *
 * 三条口径写在最前面，后面每个函数都按它来：
 * - **词是原子**：只能重排、重分**已有**的时间，绝不新造时间戳；单调不重叠，允许零宽。
 * - **标点只进 text 不进 words**（spec §0）：字幕消费 words，所以清洗加的标点改善阅读，
 *   不改变字幕行为——显式决定，不是疏漏。
 * - **改不动就原样透传**：任何一条防线不过，该组弃改 + 一句人话，绝不硬改。
 */
import { clock, norm, pct } from "./rough-cut-units.js";
import type { TranscriptSegment, TranscriptWord } from "./types.js";

/**
 * 允许被合并吞掉的最大停顿。超过它的相邻分句**不许合成一句**：`buildOutputMap` 按分句
 * 边界取源区间，把一段长静音包进同一个分句就等于把静音剪进成片，成片时长凭空变长。
 * 500ms 是「换气」与「停顿」的分界线，改这个数就是在改成片时长的口径。
 */
export const MERGE_MAX_GAP_MS = 500;

/** 一组最多合并几个原分句：不设上限的话，模型可以把整窗合成一组，把下面几条比例闸稀释掉 */
export const MAX_GROUP_SEGMENTS = 6;

/** 短文本按绝对编辑数判，长文本按比例判——短句里 30% 只有一两个字，比例闸形同虚设 */
const SHORT_TEXT_WORDS = 12;
/** 长文本的编辑距离上限（分母 = max(原, 新) 长度，显式写死，不留歧义） */
const LONG_TEXT_EDIT_RATIO = 0.3;
/** 长度变化上限：清洗只纠错不改写，长度大变一定是模型在重写而不是在纠错 */
const MAX_LENGTH_DELTA_RATIO = 0.3;
/** LCS 的规模上限（防御性）：正常是几十词的量级，真撞上超大输入宁可退化成全不匹配 */
const LCS_MAX_CELLS = 4_000_000;

// ---------------------------------------------------------------------------
// 分词：与 sidecar 同口径
// ---------------------------------------------------------------------------

/**
 * 与 sidecar `asr.py` 的 `WORD_UNIT_RE` **同口径**：一个汉字、或一串连续的拉丁字母数字
 * （含撇号）算一个词，标点与空白不占词。两侧差一个字符，词与时间戳就整体错位一格。
 *
 * 为什么不逐字节照抄 python 的 `[A-Za-z0-9']+|[^\s\W_]`：JS 的 `\w` 恒为 ASCII（加 `u` 也不变），
 * 照抄过来 `[^\s\W_]` 会退化成 `[A-Za-z0-9]`，一个汉字都匹配不上。python 的 `\w`（re.UNICODE）
 * 等价于 `[\p{L}\p{N}_]`，所以这里写成 `[\p{L}\p{N}]`——**等价的是行为，不是字面**。
 * 两侧共用 `sidecars/asr/word-units.contract.json` 那组样本做双侧契约测试锁死。
 */
export const WORD_UNIT_RE = /[A-Za-z0-9']+|[\p{L}\p{N}]/gu;

export interface TokenSpan {
  w: string;
  /** 在原文里的字符区间 `[start, end)`——重拼 text 时靠它把标点原样带回来 */
  start: number;
  end: number;
}

export function tokenizeWordUnits(text: string): TokenSpan[] {
  // 带 g 的正则有 lastIndex 状态，每次新建一个，免得并发/重入时互相踩
  const re = new RegExp(WORD_UNIT_RE.source, WORD_UNIT_RE.flags);
  const out: TokenSpan[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ w: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export const tokenWords = (tokens: readonly TokenSpan[]): string[] => tokens.map((t) => t.w);

/**
 * 取 `[from, to)` 这几个词在原文里的那一段：从首词起点到**下一个词的起点**为止。
 * 于是句末标点跟着前一段走、下一段的前导空白被 trim 掉——标点因此只进 text 不进 words。
 */
export function sliceTokenText(text: string, tokens: readonly TokenSpan[], from: number, to: number): string {
  if (to <= from || from >= tokens.length) return "";
  const start = tokens[from].start;
  const end = to < tokens.length ? tokens[to].start : text.length;
  return text.slice(start, end).trim();
}

// ---------------------------------------------------------------------------
// 词级 LCS 对齐
// ---------------------------------------------------------------------------

/** 一对匹配：原词第 `origIndex` 个 ↔ 新词第 `tokenIndex` 个（norm 后相等） */
export interface AlignMatch {
  origIndex: number;
  tokenIndex: number;
}

/** norm 后相等才算同一个词；空 norm（纯撇号之类）永不匹配，免得两个「空词」互相认亲 */
const sameWord = (x: string, y: string): boolean => x !== "" && x === y;

/**
 * 词级 LCS（norm 不敏感）。**不用前后缀锚定**：一句里有两处纠错时，锚定会把中间那段
 * 完全正确的词一并判成「变了」跟着重分时间——评审点名的 P0。
 */
export function lcsMatches(a: readonly string[], b: readonly string[]): AlignMatch[] {
  const [n, m] = [a.length, b.length];
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > LCS_MAX_CELLS) return [];
  const at = (i: number, j: number): number => i * (m + 1) + j;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = sameWord(a[i], b[j])
        ? dp[at(i + 1, j + 1)] + 1
        : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const out: AlignMatch[] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (sameWord(a[i], b[j])) out.push({ origIndex: i++, tokenIndex: j++ });
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) i++;
    else j++;
  }
  return out;
}

/** 一段没对上的词：原词 `[oFrom, oTo)` 换成新词 `[tFrom, tTo)` */
interface UnmatchedRun {
  oFrom: number;
  oTo: number;
  tFrom: number;
  tTo: number;
}

/**
 * 局部重分：新词按**本段原有的时间跨度**分（拉丁按字符数、CJK 按字数加权），
 * 取整后 clamp 保单调、允许零宽，**永不越出这一段的原跨度**——所以一处纠错的影响半径
 * 就是那几个字，不会波及整句里其它正确的词。
 */
function pushRun(
  out: TranscriptWord[],
  original: readonly TranscriptWord[],
  tokens: readonly string[],
  run: UnmatchedRun,
): void {
  const slice = tokens.slice(run.tFrom, run.tTo);
  if (slice.length === 0) return; // 只删不加：这几个原词被清洗删掉了，时间跟着消失
  if (run.oTo <= run.oFrom) {
    // 凭空插进来的词：没有可分的跨度，落成零宽，钉在前一个词的末尾（且不许越过后一个词的起点）
    const prev = out[out.length - 1]?.endMs ?? original[run.oFrom]?.startMs ?? 0;
    const at = Math.min(prev, original[run.oFrom]?.startMs ?? prev);
    for (const w of slice) out.push({ w, startMs: at, endMs: at });
    return;
  }
  const start = original[run.oFrom].startMs;
  const end = Math.max(start, original[run.oTo - 1].endMs);
  const weights = slice.map((w) => Math.max(1, [...w].length));
  const total = weights.reduce((sum, w) => sum + w, 0);
  let cum = 0;
  let cursor = start;
  for (const [k, w] of slice.entries()) {
    cum += weights[k];
    // 末词直接落在 end 上：累加取整的误差不许攒到最后一格上去
    const bound = k === slice.length - 1 ? end : start + Math.round(((end - start) * cum) / total);
    const endMs = Math.min(end, Math.max(cursor, bound));
    out.push({ w, startMs: cursor, endMs });
    cursor = endMs;
  }
}

/**
 * 全局单调兜底。正常情况下它什么都不做（匹配词沿用原时间、重分词困在自己那一段里）；
 * 只有 ASR 事实本身时间倒挂时才会生效——那时「单调不重叠」比「不越出原跨度」更要紧，
 * 因为 outputMap 与字幕投影都建立在单调假设上。
 */
function enforceMonotonic(words: TranscriptWord[]): TranscriptWord[] {
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const w of words) {
    w.startMs = Math.max(w.startMs, prevEnd === Number.NEGATIVE_INFINITY ? w.startMs : prevEnd);
    w.endMs = Math.max(w.endMs, w.startMs);
    prevEnd = w.endMs;
  }
  return words;
}

/**
 * 把一段新文字的词序列对回原词序列的时间轴（转写纠错 spec §4）。
 * **手工改字（§6）复用同一个函数**——机器改与人改必须落在同一套时间语义上，
 * 两份实现迟早会在某个边界上分叉。
 */
export function realignWords(original: readonly TranscriptWord[], tokens: readonly string[]): TranscriptWord[] {
  const matches = lcsMatches(original.map((w) => norm(w.w)), tokens.map(norm));
  const out: TranscriptWord[] = [];
  let oi = 0;
  let ti = 0;
  // 末尾补一个哨兵，让「最后一处匹配之后的残段」和中间的段落走同一条路径
  for (const match of [...matches, { origIndex: original.length, tokenIndex: tokens.length }]) {
    pushRun(out, original, tokens, { oFrom: oi, oTo: match.origIndex, tFrom: ti, tTo: match.tokenIndex });
    if (match.origIndex < original.length && match.tokenIndex < tokens.length) {
      // 对上的词原样保留时间；文字取**新**的那一份（大小写/写法以清洗结果为准）
      const src = original[match.origIndex];
      out.push({ w: tokens[match.tokenIndex], startMs: src.startMs, endMs: src.endMs });
    }
    oi = match.origIndex + 1;
    ti = match.tokenIndex + 1;
  }
  return enforceMonotonic(out);
}

/** 原词序列在第 `boundary` 个词处切一刀 → 新词序列该切在哪（第一个对上 boundary 或更后原词的新词） */
export function tokenCutAt(matches: readonly AlignMatch[], tokenCount: number, boundary: number): number {
  for (const m of matches) if (m.origIndex >= boundary) return m.tokenIndex;
  return tokenCount;
}

// ---------------------------------------------------------------------------
// 防过拟合多重闸（spec §4）
// ---------------------------------------------------------------------------

/** 逐字符 Levenshtein；只在一个 group 的量级上跑（几十到几百字），O(n·m) 够用 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 多重闸：任何一条超限 → 该 group 弃改（原样透传）+ 一句人话。返回 null 才是放行。
 *
 * 为什么不是单条比例闸：模型「顺手把这句话说通顺」时，改动往往均匀铺在整句上，比例看着不高；
 * 而短句里改两个字就是把话改了。绝对数管短句、比例管长句、长度变化管重写、跨度管稀释，
 * 四条各堵一种过拟合姿势（评审 P0）。
 */
export function overfitReason(
  original: readonly TranscriptWord[],
  tokens: readonly string[],
  segmentCount: number,
): string | null {
  if (segmentCount > MAX_GROUP_SEGMENTS) {
    return `一组合并了 ${segmentCount} 个分句，超过上限 ${MAX_GROUP_SEGMENTS}`;
  }
  if (tokens.length === 0) return "改完一个词都不剩（纯标点或空文本）";
  const before = original.map((w) => norm(w.w)).join("");
  const after = tokens.map(norm).join("");
  if (before.length === 0) return null; // 原文没有可比的文字，无从判定，放行给后面的覆盖率自检
  const longest = Math.max(before.length, after.length);
  const delta = Math.abs(after.length - before.length);
  if (delta > longest * MAX_LENGTH_DELTA_RATIO) {
    return `长度变了 ${pct(delta / longest)}（上限 ${pct(MAX_LENGTH_DELTA_RATIO)}），这是改写不是纠错`;
  }
  const dist = editDistance(before, after);
  if (original.length <= SHORT_TEXT_WORDS) {
    const cap = Math.ceil(original.length / 3);
    return dist > cap ? `短句改了 ${dist} 处（${original.length} 词最多允许 ${cap} 处）` : null;
  }
  return dist > longest * LONG_TEXT_EDIT_RATIO
    ? `改动占 ${pct(dist / longest)}（上限 ${pct(LONG_TEXT_EDIT_RATIO)}）`
    : null;
}

// ---------------------------------------------------------------------------
// 应用：group → cseg
// ---------------------------------------------------------------------------

/** 模型交回来的一组：覆盖 `[fromSeg, toSeg]` 这几个原分句，`text` 是改后的整段文字 */
export interface CleanGroup {
  fromSeg: string;
  toSeg: string;
  text: string;
}

export interface CleanApplyResult {
  segments: TranscriptSegment[];
  /** 被防线拦下的组：人话 + 时间码，冒到选段卡上（降级必须可见） */
  warnings: string[];
}

interface PlannedGroup {
  from: number;
  to: number;
  text: string;
}

const csegId = (order: number): string => `cseg-${String(order).padStart(4, "0")}`;

const spanLabel = (segs: readonly TranscriptSegment[]): string =>
  `${clock(segs[0].startMs)}-${clock(segs[segs.length - 1].endMs)}`;

/**
 * 跨窗合并模型给的组：排序、丢掉引用不存在分句的与相互重叠的。
 * 单窗内的连续/不重叠/全覆盖由工具层当场校验并打回自纠，这里是**跨窗兜底**，
 * 正常永远不触发；真触发了也要说出来，不静默吞掉。
 */
function planGroups(
  segments: readonly TranscriptSegment[],
  groups: readonly CleanGroup[],
): { groups: PlannedGroup[]; warnings: string[] } {
  const index = new Map(segments.map((s, i) => [s.id, i]));
  const warnings: string[] = [];
  const parsed: PlannedGroup[] = [];
  for (const g of groups) {
    const from = index.get(g.fromSeg);
    const to = index.get(g.toSeg);
    if (from === undefined || to === undefined || from > to) {
      warnings.push(`清洗结果引用了对不上的分句区间（${g.fromSeg} → ${g.toSeg}），这一组已忽略`);
      continue;
    }
    parsed.push({ from, to, text: g.text });
  }
  parsed.sort((a, b) => a.from - b.from || a.to - b.to);
  const out: PlannedGroup[] = [];
  for (const g of parsed) {
    const last = out[out.length - 1];
    if (last && g.from <= last.to) {
      warnings.push(`清洗结果里 ${segments[g.from].id} 被两组同时覆盖，后一组已忽略`);
      continue;
    }
    out.push(g);
  }
  return { groups: out, warnings };
}

/** 原样透传：文字与时间一个字不动，只等着被赋新 id */
const passthrough = (seg: TranscriptSegment): TranscriptSegment => ({
  id: seg.id,
  text: seg.text,
  startMs: seg.startMs,
  endMs: seg.endMs,
  words: seg.words.map((w) => ({ ...w })),
});

/** 相邻分句之间停顿超过 `MERGE_MAX_GAP_MS` 的位置（covered 内的下标）：这些地方不许合并 */
function hardCuts(covered: readonly TranscriptSegment[]): number[] {
  const cuts: number[] = [];
  for (let i = 1; i < covered.length; i++) {
    if (covered[i].startMs - covered[i - 1].endMs > MERGE_MAX_GAP_MS) cuts.push(i);
  }
  return cuts;
}

/** 按硬切点把一组拆成若干连续子段（闭区间下标） */
function subRanges(count: number, cuts: readonly number[]): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let from = 0;
  for (const cut of cuts) {
    ranges.push({ from, to: cut - 1 });
    from = cut;
  }
  ranges.push({ from, to: count - 1 });
  return ranges;
}

/**
 * 把一组的新文字铺回若干子段。子段之间是**硬边界**（大停顿），所以先按对齐结果把新词序列
 * 切开、再逐子段各自重分时间——这样任何一段重分都不会跨过静音，成片时长不受影响。
 */
function buildGroupSegments(
  covered: readonly TranscriptSegment[],
  tokens: readonly TokenSpan[],
  text: string,
  cuts: readonly number[],
): TranscriptSegment[] {
  const words = covered.flatMap((s) => s.words ?? []);
  const matches = lcsMatches(words.map((w) => norm(w.w)), tokens.map((t) => norm(t.w)));
  const ranges = subRanges(covered.length, cuts);
  const out: TranscriptSegment[] = [];
  let wordCursor = 0;
  let tokenCursor = 0;
  for (const [k, range] of ranges.entries()) {
    const subSegs = covered.slice(range.from, range.to + 1);
    const subWords = subSegs.flatMap((s) => s.words ?? []);
    wordCursor += subWords.length;
    const tokenEnd =
      k === ranges.length - 1
        ? tokens.length
        : Math.max(tokenCursor, tokenCutAt(matches, tokens.length, wordCursor));
    const slice = tokens.slice(tokenCursor, tokenEnd);
    // 这一小段的字被改没了：宁可原样留着，也不出一个没有词的空分句（下游按词算时间与字幕）
    if (slice.length === 0) out.push(...subSegs.map(passthrough));
    else {
      out.push({
        id: "",
        text: sliceTokenText(text, tokens, tokenCursor, tokenEnd),
        // 分句的起止仍是**原分句边界**：合并只合并文字，源区间一毫秒都不新造
        startMs: subSegs[0].startMs,
        endMs: subSegs[subSegs.length - 1].endMs,
        words: realignWords(subWords, tokenWords(slice)),
      });
    }
    tokenCursor = tokenEnd;
  }
  return out;
}

function applyOne(covered: readonly TranscriptSegment[], text: string, warnings: string[]): TranscriptSegment[] {
  const tokens = tokenizeWordUnits(text);
  const bad = overfitReason(covered.flatMap((s) => s.words ?? []), tokenWords(tokens), covered.length);
  if (bad) {
    warnings.push(`${spanLabel(covered)} 的清洗结果没采纳（${bad}），这一段保持原样`);
    return covered.map(passthrough);
  }
  const cuts = hardCuts(covered);
  if (cuts.length > 0) {
    warnings.push(
      `${spanLabel(covered)} 中间有超过 ${MERGE_MAX_GAP_MS}ms 的停顿，没有合并成一句（合并会把静音剪进成片、改变片长）`,
    );
  }
  return buildGroupSegments(covered, tokens, text, cuts);
}

/**
 * 应用清洗结果（§4）。没被任何一组覆盖的分句（失败的窗口、没有词的静音句）原样透传——
 * 「部分窗口没跑成」因此只损失那几段的纠错，不会让整条转写退回原样。
 *
 * 产出的段 id 一律重排成 `cseg-XXXX`：这一版文字是清洗的产物，边界由清洗划，
 * 与 ASR 的 `seg-XXXX` 分开才看得出「这一段是谁划的」（types.ts 的约定）。
 */
export function applyCleanGroups(
  segments: readonly TranscriptSegment[],
  groups: readonly CleanGroup[],
): CleanApplyResult {
  const planned = planGroups(segments, groups);
  const warnings = [...planned.warnings];
  const out: TranscriptSegment[] = [];
  const push = (seg: TranscriptSegment): void => void out.push({ ...seg, id: csegId(out.length + 1) });
  let i = 0;
  for (const g of planned.groups) {
    while (i < g.from) push(passthrough(segments[i++]));
    for (const seg of applyOne(segments.slice(g.from, g.to + 1), g.text, warnings)) push(seg);
    i = g.to + 1;
  }
  while (i < segments.length) push(passthrough(segments[i++]));
  return { segments: out, warnings };
}

/**
 * 词覆盖率自检：分句 text 里的文字有多少被 words 覆盖到（口径与粗剪的健康检查一致）。
 * 清洗产物按构造应该恒等于 1——words 就是从同一段 text 分出来的。跌破 0.9 说明分词或
 * 拼装出了 bug，调用方据此整体退回原样转写（AI 粗剪拿 0.9 当开关，带病产物会让它整段跳过）。
 */
export function cleanWordCoverage(segments: readonly TranscriptSegment[]): number {
  const textChars = segments.reduce((sum, s) => sum + norm(s.text).length, 0);
  if (textChars === 0) return 0;
  const wordChars = segments.reduce((sum, s) => sum + s.words.reduce((n, w) => n + norm(w.w).length, 0), 0);
  return wordChars / textChars;
}
