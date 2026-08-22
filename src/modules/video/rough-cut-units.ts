/**
 * 粗剪的确定性部分（粗剪 spec §2.1 / §2.3）：词流、窗口划分、区间归一、单元划分、防清空。
 *
 * 与 `rough-cut.ts` 的分工：这里**零 IO、零模型**，全是纯函数，用边界用例锁死；
 * 那边负责调模型、并发调度、失败降级。切开是因为两件事的失败模式完全不同——
 * 这边错了是算错，那边错了是外部不可用，混在一个文件里连测试都不好写。
 *
 * 两条口径写在最前面，后面所有函数都按它来：
 * - **词是原子**：只对 ASR 词序列做分组与取舍，绝不新造、修改、插值 `w/startMs/endMs`。
 * - **区间半开** `[start, end)`：覆盖判定、补集运算、边界用例全按这一个口径。
 */
import type { CutFlag, CutFlagKind, TranscriptSegment, TranscriptWord } from "./types.js";

/** 一行最多这么多词：模型引用任意词时，最近的行首锚点不超过 9 个词的距离 */
export const WORDS_PER_LINE = 10;
/** 词时间戳覆盖率下限（§2.5）：低于此值索引不可靠，跳过 AI */
export const MIN_WORD_COVERAGE = 0.9;
/** 单次可处理的词数上限（§7 #14）；15.5 分钟实测 2732 词 */
export const MAX_WORDS = 8000;
/** scriptCoverage 低于此值禁用 offtopic（§2.4）——跑题是唯一必须以稿子为准绳的判断 */
export const SCRIPT_COVERAGE_FLOOR = 0.5;

/**
 * 窗口目标词数。实测教训：把 2732 词一次性交给模型，它会逐个区间写推理，
 * 写到输出上限被截断，**始终没走到 tool call**（733 秒，54450 token，truncated）。
 * 判断力没问题，纯粹是输出预算问题。切成 300–500 词一窗，每窗独立调用。
 */
export const WINDOW_TARGET_WORDS = 400;
export const WINDOW_MAX_WORDS = 500;
/** 尾窗短于此值就并回上一窗——为二十个词单开一次调用不值当 */
export const WINDOW_MIN_WORDS = 150;

export const CUT_FLAGS: readonly CutFlagKind[] = ["misread", "repeat", "offtopic"];

/** 只留文字与数字：标点/空格在稿子与转写两侧的出现规律完全不同，算进去等于给噪音投票 */
export const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
export const pct = (r: number): string => `${Math.round(r * 100)}%`;

// ---------------------------------------------------------------------------
// 词流
// ---------------------------------------------------------------------------

export interface WordStream {
  words: TranscriptWord[];
  /** 每个原 VAD 分句在词流里的起始索引；它们既是单元切点，也是窗口切点 */
  segStarts: number[];
}

/** 空 `words` 的分句自然不进流（实测尾部 10 句就是这样），其 text 也不参与任何单元 */
export function flattenWords(segments: readonly TranscriptSegment[]): WordStream {
  const words: TranscriptWord[] = [];
  const segStarts: number[] = [];
  for (const seg of segments) {
    if (!seg.words?.length) continue;
    segStarts.push(words.length);
    for (const w of seg.words) words.push({ w: w.w, startMs: w.startMs, endMs: w.endMs });
  }
  return { words, segStarts };
}

/**
 * 词级时间戳覆盖率。真实口径是「有时间戳的文本单元 / 全部文本单元」，但文本单元数只有
 * sidecar 知道，这里用字符数作代理：分句 text 的字符里有多少被 words 覆盖到。
 */
function wordCoverage(segments: readonly TranscriptSegment[], stream: WordStream): number {
  const textChars = segments.reduce((sum, s) => sum + norm(s.text).length, 0);
  if (textChars === 0) return 0;
  return stream.words.reduce((sum, w) => sum + norm(w.w).length, 0) / textChars;
}

/** 前置健康检查（§2.5 + §7 #14）：任一不过就跳过 AI，返回人话原因 */
export function wordStreamHealth(segments: readonly TranscriptSegment[], stream: WordStream): string | null {
  const suffix = "，已跳过 AI 粗剪并保留全留版供人工处理";
  const n = stream.words.length;
  if (n === 0) return `转写里一个带时间戳的词都没有${suffix}`;
  if (n > MAX_WORDS) return `词数 ${n} 超过单次可处理上限 ${MAX_WORDS}${suffix}`;
  const coverage = wordCoverage(segments, stream);
  if (coverage < MIN_WORD_COVERAGE) {
    return `词级时间戳覆盖率只有 ${pct(coverage)}（低于 ${pct(MIN_WORD_COVERAGE)}），索引不可靠${suffix}`;
  }
  for (let i = 1; i < n; i++) {
    if (stream.words[i].startMs < stream.words[i - 1].endMs) {
      return `第 ${i} 个词的时间戳与前一个倒挂（${stream.words[i].startMs}ms < ${stream.words[i - 1].endMs}ms）${suffix}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 呈现：行首索引 + 每行 ≤10 词
// ---------------------------------------------------------------------------

/**
 * 把 `[from, to)` 渲染成 `[k] 文本` 的多行文本：k 是该行首词的**全局**索引，
 * 一行最多 10 个词且不跨分句；`¶` 标出原 VAD 分句起点（自然停顿）。
 * 分窗后索引依然是全局的——每窗重新编号只会在合并时多一层偏移换算，平白多一个错源。
 */
export function renderRange(stream: WordStream, from: number, to: number): string {
  const isSegStart = new Set(stream.segStarts);
  const lines: string[] = [];
  for (let i = Math.max(0, from); i < Math.min(to, stream.words.length); ) {
    let end = Math.min(i + WORDS_PER_LINE, to, stream.words.length);
    for (let k = i + 1; k < end; k++) {
      if (isSegStart.has(k)) {
        end = k;
        break;
      }
    }
    lines.push(`[${i}] ${isSegStart.has(i) ? "¶" : ""}${stream.words.slice(i, end).map((w) => w.w).join("")}`);
    i = end;
  }
  return lines.join("\n");
}

export function renderWordStream(stream: WordStream): string {
  return renderRange(stream, 0, stream.words.length);
}

// ---------------------------------------------------------------------------
// 窗口划分
// ---------------------------------------------------------------------------

/** 一个窗口就是一次独立的模型调用；区间半开，全局索引 */
export interface RoughCutWindow {
  from: number;
  to: number;
}

/** 尾窗太短就并回上一窗；并完超上限则维持原样（宁可短一窗，不可超预算） */
function mergeShortTail(windows: RoughCutWindow[]): RoughCutWindow[] {
  if (windows.length < 2) return windows;
  const last = windows[windows.length - 1];
  const prev = windows[windows.length - 2];
  if (last.to - last.from >= WINDOW_MIN_WORDS) return windows;
  if (last.to - prev.from > WINDOW_MAX_WORDS) return windows;
  return [...windows.slice(0, -2), { from: prev.from, to: last.to }];
}

/**
 * 沿原 VAD 分句边界切窗，每窗约 `WINDOW_TARGET_WORDS` 词，窗间不重叠。
 * 切点只落在分句边界上：窗口内部永远是完整的句子，模型不会拿到半句话去判断重复。
 *
 * 单个分句本身就超上限时它自成一窗（VAD 已经是最小粒度，再切就是切碎句子）。
 */
export function planWindows(stream: WordStream, target: number = WINDOW_TARGET_WORDS): RoughCutWindow[] {
  const n = stream.words.length;
  if (n === 0) return [];
  const bounds = [...new Set([...stream.segStarts, n])].filter((b) => b > 0).sort((a, b) => a - b);
  const windows: RoughCutWindow[] = [];
  let from = 0;
  for (const b of bounds) {
    if (b - from < target && b !== n) continue;
    windows.push({ from, to: b });
    from = b;
  }
  if (from < n) windows.push({ from, to: n });
  return mergeShortTail(windows);
}

/**
 * 沿 VAD 边界就近对半切。给失败窗口重试用：失败根因是「模型把分析写在正文里、耗光
 * 输出配额」——**输出量**问题，同样大小重跑一次大概率同样挂，对半才是打根因。
 *
 * 窗内没有可切的分句边界（整窗就是一个分句）→ null，调用方据此放弃重试而不是硬切碎句子。
 */
export function halveWindow(stream: WordStream, win: RoughCutWindow): [RoughCutWindow, RoughCutWindow] | null {
  const mid = (win.from + win.to) / 2;
  let best: number | null = null;
  for (const s of stream.segStarts) {
    if (s <= win.from || s >= win.to) continue;
    if (best === null || Math.abs(s - mid) < Math.abs(best - mid)) best = s;
  }
  if (best === null) return null;
  return [
    { from: win.from, to: best },
    { from: best, to: win.to },
  ];
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** 窗口的时间码区间——降级 warning 要点名「哪一段没跑成」，人才知道去复核哪儿 */
export function windowLabel(stream: WordStream, w: RoughCutWindow): string {
  const first = stream.words[w.from];
  const last = stream.words[w.to - 1];
  if (!first || !last) return `词 ${w.from}-${w.to}`;
  return `${clock(first.startMs)}-${clock(last.endMs)}`;
}

// ---------------------------------------------------------------------------
// drop 区间：归一与单元划分
// ---------------------------------------------------------------------------

export interface RoughCutDrop {
  startWord: number;
  endWordExclusive: number;
  flag: CutFlagKind;
}

/** 排序 + 去重（完全相同的区间）。真重叠留给 checkOverlap 打回，这里不掩盖它 */
export function dedupeSorted(drops: readonly RoughCutDrop[]): RoughCutDrop[] {
  const seen = new Set<string>();
  const uniq = drops.filter((d) => {
    const key = `${d.startWord}|${d.endWordExclusive}|${d.flag}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return uniq.sort((a, b) => a.startWord - b.startWord || a.endWordExclusive - b.endWordExclusive);
}

/** 完全相同的区间去重后，仍有相交 = 真重叠，打回；相邻（首尾相接）合法 */
export function checkOverlap(sorted: readonly RoughCutDrop[]): string | null {
  for (let i = 1; i < sorted.length; i++) {
    const [prev, cur] = [sorted[i - 1], sorted[i]];
    if (cur.startWord < prev.endWordExclusive) {
      return `drops 里 [${prev.startWord}, ${prev.endWordExclusive}) 与 [${cur.startWord}, ${cur.endWordExclusive}) 重叠；区间必须互不重叠（首尾相接可以）`;
    }
  }
  return null;
}

/**
 * 排序、去重、同 flag 相邻合并——都是代码的活，不要求模型有序（§2.2）。
 * 多窗合并也走这里：窗间不重叠，所以跨窗的相邻区间在这一步自然接成一段。
 */
export function normalizeDrops(drops: readonly RoughCutDrop[]): RoughCutDrop[] {
  const uniq = dedupeSorted(drops);
  const out: RoughCutDrop[] = [];
  for (const d of uniq) {
    const last = out[out.length - 1];
    if (last && last.flag === d.flag && d.startWord <= last.endWordExclusive) {
      last.endWordExclusive = Math.max(last.endWordExclusive, d.endWordExclusive);
      continue;
    }
    out.push({ ...d });
  }
  return out;
}

export interface EditUnitSplit {
  units: TranscriptSegment[];
  droppedIds: string[];
  flags: CutFlag[];
}

/**
 * 在「drop 边界 ∪ 原 VAD 分句边界」两组切点上切分词流（§2.1 第 3 步）。
 * drop 边界保证 AI 的切口落在正确位置；分句边界保证保留区被切成人能逐条勾的粒度
 * （否则一个 keep 区可能长达一分钟，人没法点选修正）。
 *
 * 因为 drop 边界必是切点，每个单元要么整个在某个 drop 里，要么整个在外面——不存在半个。
 */
export function splitEditUnits(stream: WordStream, drops: readonly RoughCutDrop[]): EditUnitSplit {
  const n = stream.words.length;
  const cuts = new Set<number>([0, n, ...stream.segStarts]);
  for (const d of drops) {
    cuts.add(d.startWord);
    cuts.add(d.endWordExclusive);
  }
  const points = [...cuts].filter((c) => c >= 0 && c <= n).sort((a, b) => a - b);
  const split: EditUnitSplit = { units: [], droppedIds: [], flags: [] };
  for (let i = 0; i + 1 < points.length; i++) {
    const [from, to] = [points[i], points[i + 1]];
    const words = stream.words.slice(from, to);
    if (words.length === 0) continue;
    const id = `unit-${String(split.units.length + 1).padStart(4, "0")}`;
    split.units.push({
      id,
      text: words.map((w) => w.w).join(""),
      startMs: words[0].startMs,
      endMs: words[words.length - 1].endMs,
      words,
    });
    const hit = drops.find((d) => d.startWord <= from && to <= d.endWordExclusive);
    if (!hit) continue;
    split.droppedIds.push(id);
    split.flags.push({ segmentId: id, flag: hit.flag });
  }
  return split;
}

/**
 * 防清空**按时长不按句数**（§2.3）：模型可以通过制造长短句操纵句数比例，时长不能。
 * 恰好 50% 放行——spec 写的是「超过一半」。
 * 也刻意不让模型自纠去迎合比例：那会诱导它随便挑几段删来凑数。
 */
export function overDropGuard(split: EditUnitSplit): string | null {
  const dur = (u: TranscriptSegment): number => Math.max(0, u.endMs - u.startMs);
  const total = split.units.reduce((sum, u) => sum + dur(u), 0);
  if (total <= 0) return null;
  const dropped = new Set(split.droppedIds);
  const cut = split.units.filter((u) => dropped.has(u.id)).reduce((sum, u) => sum + dur(u), 0);
  if (cut * 2 <= total) return null;
  return `AI 建议删除超过一半（按时长 ${pct(cut / total)}），已保留全留版供人工处理`;
}
