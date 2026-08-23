/**
 * 输出时间域 ↔ 帧的确定性换算，以及**块内**字幕排版。
 * 纯函数，无 IO、无随机——同一 manifest 每次渲染必须逐帧一致。
 *
 * 断句不在这里：cue 由 assemble 冻进 manifest（v2 spec §2.1），
 * 渲染端只管「这一块怎么放得下」，不管「这一块该断在哪」。
 */
import type { CaptionWord } from './manifest';

/** ms → 帧号（四舍五入）。 */
export function msToFrames(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

/** ms → 帧数（时长用，至少 1 帧，避免 0 帧 Sequence 被 Remotion 拒绝）。 */
export function msToDurationFrames(ms: number, fps: number): number {
  return Math.max(1, Math.round((ms / 1000) * fps));
}

/** 帧号 → 输出域毫秒。 */
export function framesToMs(frame: number, fps: number): number {
  return (frame / fps) * 1000;
}

// ---------------------------------------------------------------------------
// 字幕排版（横屏 spec §2.2）
// ---------------------------------------------------------------------------

/**
 * 按**像素宽度**估宽而不是字符数：横屏一行放得下 20+ 个汉字，但同样 20 个拉丁字母只占一半宽，
 * 按字符数断行会让中文行溢出、英文行空半屏。权重单位是 em（1em = 当前字号）。
 */
const CJK_EM = 1;
const DIGIT_EM = 0.6;
const LATIN_EM = 0.55;
/** 标点、空格与其余字符：宁可高估——高估只会提前断行，低估会让字幕冲出画面。 */
const OTHER_EM = 0.5;

/**
 * CJK 部首/汉字/假名 + 中日标点 + 全角字符：这些是等宽的方块字。
 * 用码点转义而不是直接贴字符——范围里含表意空格（U+3000），贴字面量既看不出来也过不了 lint。
 */
const CJK_RE = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/;
const DIGIT_RE = /[0-9]/;
const LATIN_RE = /[A-Za-z\u00C0-\u024F]/;

/** 文本的估算宽度（em）。纯函数、无 DOM 测量——渲染必须逐帧确定性。 */
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

/** 单行最大宽度 = 画布宽 80%（左右各留 10% 安全边）。 */
export const CAPTION_ROW_WIDTH_RATIO = 0.8;
/** 最多 2 行，目标 1 行。 */
export const CAPTION_MAX_ROWS = 2;
/** 1080 高基准 56–64px：上限是常态字号，下限是「宁可缩字也别折行」的底。 */
export const CAPTION_FONT_MAX_RATIO = 64 / 1080;
export const CAPTION_FONT_MIN_RATIO = 56 / 1080;
/** 下沿安全区：画面高度的 15%。 */
export const CAPTION_BOTTOM_SAFE_RATIO = 0.15;

export type CaptionLayout = {
  rowWidthPx: number;
  maxFontSize: number;
  minFontSize: number;
  /** 断行预算：一行在**基准字号**下装得下多少 em——目标 1 行就是这么来的。 */
  maxWidthEm: number;
};

export function captionLayout(canvasWidth: number, canvasHeight: number): CaptionLayout {
  const rowWidthPx = canvasWidth * CAPTION_ROW_WIDTH_RATIO;
  const maxFontSize = Math.round(canvasHeight * CAPTION_FONT_MAX_RATIO);
  return {
    rowWidthPx,
    maxFontSize,
    minFontSize: Math.round(canvasHeight * CAPTION_FONT_MIN_RATIO),
    maxWidthEm: rowWidthPx / maxFontSize,
  };
}

function visibleText(word: string): string {
  return word.trim();
}

/** 贪心折行：单个词本身超宽时自成一行（不切词）——切词会把 FDE 断成 FD/E，比折行难看得多。 */
export function wrapCueLines(words: readonly CaptionWord[], rowWidthEm: number): CaptionWord[][] {
  const lines: CaptionWord[][] = [];
  let bucket: CaptionWord[] = [];
  let widthEm = 0;
  for (const word of words) {
    const em = estimateWidthEm(visibleText(word.w));
    if (bucket.length > 0 && widthEm + em > rowWidthEm) {
      lines.push(bucket);
      bucket = [];
      widthEm = 0;
    }
    bucket.push(word);
    widthEm += em;
  }
  if (bucket.length > 0) lines.push(bucket);
  return lines;
}

export type CueLayout = { fontSize: number; lines: CaptionWord[][] };

/**
 * 一块 cue 的排版：≤2 行、每行 ≤80% 画布宽，字号自基准值起逐档下压直到装得下。
 *
 * 下压是**兜底而非常态**：assemble 的宽度预算已经把 cue 卡在 2 行以内，这里只处理
 * 「一个 token（长 URL / 长英文词）本身就比一行还宽」的情况——绝不让它溢出画布（边界 #7）。
 * 纯函数、整数字号：同一 cue 每次渲染逐帧一致。
 */
export function fitCue(words: readonly CaptionWord[], layout: CaptionLayout): CueLayout {
  const usable = words.filter((w) => visibleText(w.w).length > 0);
  if (usable.length === 0) return { fontSize: layout.maxFontSize, lines: [] };
  for (let fontSize = layout.maxFontSize; fontSize >= 1; fontSize--) {
    const rowWidthEm = layout.rowWidthPx / fontSize;
    const lines = wrapCueLines(usable, rowWidthEm);
    const fits = lines.length <= CAPTION_MAX_ROWS &&
      lines.every((line) => line.reduce((sum, w) => sum + estimateWidthEm(visibleText(w.w)), 0) <= rowWidthEm);
    if (fits) return { fontSize, lines };
  }
  return { fontSize: 1, lines: [usable] };
}

/** 转场淡入淡出：入出各 fadeFrames 帧的 opacity 插值输入区间（严格递增，短片段自动收窄）。 */
export function fadeRanges(
  durationInFrames: number,
  fadeFrames: number,
): { input: number[]; output: number[] } | null {
  if (fadeFrames <= 0 || durationInFrames <= 1) return null;
  const f = Math.min(fadeFrames, Math.floor((durationInFrames - 1) / 2));
  if (f <= 0) return null;
  return { input: [0, f, durationInFrames - f, durationInFrames], output: [0, 1, 1, 0] };
}
