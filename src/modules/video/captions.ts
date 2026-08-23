/**
 * 字幕 cue 切分（剪辑师 v2 spec §2.1）——**全部在 assemble 侧算完冻进 manifest**。
 *
 * 为什么在这边算：edit-units 的单元边界是 AI 划的语义边界，一旦在
 * `projectWordsToOutput` 里被拍平成词流就再也找不回来，渲染端只能按宽度盲断，
 * 断出来的必然是「一屏半句话」。所以断句在这里做一次、冻结，渲染端只负责块内排版。
 *
 * 本文件**零 IO、零模型**：同样的输入永远得到同样的 cue，用例把口径锁死。
 *
 * 跨 workspace 契约：宽度预算的单位是 em（1em = 渲染端基准字号），
 * `estimateWidthEm` 与 render/src/time.ts 里那份**必须同口径**——两边各写各的
 * （render 是独立 npm 包，禁止 import 主仓库源码），靠常量与用例对齐。
 */
import type { OutputMapEntry, TranscriptWord, VideoTranscript } from "./types.js";
import { projectWordsBySegment } from "./output-map.js";

// ---------------------------------------------------------------------------
// 估宽（与 render/src/time.ts 同口径）
// ---------------------------------------------------------------------------

const CJK_EM = 1;
const DIGIT_EM = 0.6;
const LATIN_EM = 0.55;
/** 标点、空格与其余字符：宁可高估——高估只会提前断块，低估会让字幕冲出画面 */
const OTHER_EM = 0.5;

/** 用码点转义而不是贴字面量：范围里含表意空格（U+3000），贴字面量既看不出来也过不了 lint */
const CJK_RE = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/;
const DIGIT_RE = /[0-9]/;
const LATIN_RE = /[A-Za-z\u00C0-\u024F]/;

export function estimateWidthEm(text: string): number {
  let em = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) em += CJK_EM;
    else if (DIGIT_RE.test(ch)) em += DIGIT_EM;
    else if (LATIN_RE.test(ch)) em += LATIN_EM;
    else em += OTHER_EM;
  }
  return em;
}

/**
 * 一屏字幕的宽度预算（em）。渲染端一行放得下约 24em（1536px ÷ 64px 基准字号），
 * 最多 2 行——预算取 40 而不是 48，留出贪心折行时词边界错位的余量：
 * 卡在等号上会逼渲染端下压字号，那是兜底不是常态。
 */
export const CUE_MAX_WIDTH_EM = 40;

/** `origin:"raw"` 回退分组时的时长上限：没有语义边界可依，只能按老口径按时长兜一刀 */
export const RAW_CUE_MAX_DURATION_MS = 2500;

// ---------------------------------------------------------------------------
// cue
// ---------------------------------------------------------------------------

export interface CaptionCue {
  cueId: string;
  /** 输出时间域；显示窗恒等于 [startMs, endMs)，**无 linger**（块间不留残影） */
  startMs: number;
  endMs: number;
  words: TranscriptWord[];
}

const visible = (w: TranscriptWord): string => w.w.trim();

function widthOf(words: readonly TranscriptWord[]): number {
  return words.reduce((sum, w) => sum + estimateWidthEm(visible(w)), 0);
}

/** 句末标点：中英文一视同仁。逗号/顿号也算——一屏一个短句比一屏一句半好读 */
const BREAK_PUNCT_RE = /[，。！？；、：,.!?;:…—]$/u;

/** 候选切点里取最靠中间的那个；并列时取靠前的（确定性优先于美观） */
function nearestToMiddle(candidates: readonly number[], length: number): number | null {
  if (candidates.length === 0) return null;
  const middle = length / 2;
  let best = candidates[0];
  for (const at of candidates) {
    if (Math.abs(at - middle) < Math.abs(best - middle)) best = at;
  }
  return best;
}

/** 优先级 1：标点边界（切在标点之后） */
function punctuationSplit(words: readonly TranscriptWord[]): number | null {
  const candidates: number[] = [];
  for (let i = 1; i < words.length; i++) {
    if (BREAK_PUNCT_RE.test(visible(words[i - 1]))) candidates.push(i);
  }
  return nearestToMiddle(candidates, words.length);
}

/** 优先级 2：最大词间时隙（说话人自己停顿的地方） */
function maxGapSplit(words: readonly TranscriptWord[]): number | null {
  let bestGap = 0;
  const candidates: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].startMs - words[i - 1].endMs;
    if (gap <= 0) continue;
    if (gap > bestGap) {
      bestGap = gap;
      candidates.length = 0;
    }
    if (gap === bestGap) candidates.push(i);
  }
  return nearestToMiddle(candidates, words.length);
}

/** 优先级 3：宽度预算硬切——累计超预算的那个词之前切开 */
function widthSplit(words: readonly TranscriptWord[], budgetEm: number): number {
  let used = 0;
  for (let i = 0; i < words.length; i++) {
    used += estimateWidthEm(visible(words[i]));
    if (used > budgetEm && i >= 1) return i;
  }
  return Math.max(1, words.length - 1);
}

/**
 * 单元内二次切分：标点 → 最大词间时隙 → 宽度预算硬切（spec §2.1）。
 * 切点恒落在 [1, len-1]，所以递归必然收敛。
 */
export function splitUnitWords(
  words: readonly TranscriptWord[],
  budgetEm = CUE_MAX_WIDTH_EM,
): TranscriptWord[][] {
  if (words.length <= 1 || widthOf(words) <= budgetEm) return [[...words]];
  const at = punctuationSplit(words) ?? maxGapSplit(words) ?? widthSplit(words, budgetEm);
  return [
    ...splitUnitWords(words.slice(0, at), budgetEm),
    ...splitUnitWords(words.slice(at), budgetEm),
  ];
}

/**
 * `origin:"raw"` 的回退：没有语义单元可依，按宽度 + 时长分组（老口径，去掉 linger）。
 * 渲染端对此**无感**——它永远只认 cues 一条路径。
 */
export function groupWordsByWidth(
  words: readonly TranscriptWord[],
  budgetEm = CUE_MAX_WIDTH_EM,
  maxDurationMs = RAW_CUE_MAX_DURATION_MS,
): TranscriptWord[][] {
  const groups: TranscriptWord[][] = [];
  let bucket: TranscriptWord[] = [];
  let used = 0;
  for (const word of words) {
    const em = estimateWidthEm(visible(word));
    if (bucket.length > 0 && (used + em > budgetEm || word.endMs - bucket[0].startMs > maxDurationMs)) {
      groups.push(bucket);
      bucket = [];
      used = 0;
    }
    bucket.push(word);
    used += em;
  }
  if (bucket.length > 0) groups.push(bucket);
  return groups;
}

function toCue(words: TranscriptWord[], index: number): CaptionCue {
  return {
    cueId: `cue-${String(index).padStart(4, "0")}`,
    startMs: words[0].startMs,
    endMs: Math.max(...words.map((w) => w.endMs)),
    words,
  };
}

export interface CaptionCueInput {
  transcript: VideoTranscript;
  map: OutputMapEntry[];
  /** 单元来源：llm = 语义 cue，raw = 宽度分组（真实字段名是 edit-units.origin） */
  origin: "llm" | "raw";
  budgetEm?: number;
}

/**
 * 冻进 manifest 的那份 cues。
 *
 * - `llm`：一个单元一屏，过长时块内二次切分。
 * - `raw`：整条词流按宽度分组。
 * - 空 words 的单元产不出 cue，**跳过**（该段无字幕，不崩；边界 #8）。
 */
export function buildCaptionCues(input: CaptionCueInput): CaptionCue[] {
  const budgetEm = input.budgetEm ?? CUE_MAX_WIDTH_EM;
  const { segments } = projectWordsBySegment(input.transcript, input.map);
  const usable = segments.map((s) => s.words.filter((w) => visible(w).length > 0));
  const groups =
    input.origin === "llm"
      ? usable.filter((words) => words.length > 0).flatMap((words) => splitUnitWords(words, budgetEm))
      : groupWordsByWidth(usable.flat(), budgetEm);
  return groups.filter((words) => words.length > 0).map((words, i) => toCue(words, i + 1));
}
