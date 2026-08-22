/**
 * 输出时间域 ↔ 帧的确定性换算，以及字幕分行。
 * 纯函数，无 IO、无随机——同一 manifest 每次渲染必须逐帧一致。
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

export const CAPTION_MAX_LINE_DURATION_MS = 2500;
/** 一行讲完后最多再挂 1 秒（下一行来了就换），避免长停顿时字幕悬空。 */
export const CAPTION_LINGER_MS = 1000;

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

/**
 * 字号自适应：一行装得下就用基准字号；装不下**先缩字号**（到 minFontSize 为止），
 * 仍装不下才让它折到第二行——「超长句缩字号优先于折行」（spec §2.2）。
 */
export function captionFontSize(widthEm: number, layout: CaptionLayout): number {
  if (widthEm <= 0) return layout.maxFontSize;
  const fitsOneRow = Math.floor(layout.rowWidthPx / widthEm);
  if (fitsOneRow >= layout.maxFontSize) return layout.maxFontSize;
  if (fitsOneRow >= layout.minFontSize) return fitsOneRow;
  return layout.minFontSize;
}

export type CaptionLine = {
  words: CaptionWord[];
  startMs: number;
  endMs: number;
  /** 实际上屏区间 [showFromMs, showUntilMs)，由 groupWordsIntoLines 一并算好。 */
  showFromMs: number;
  showUntilMs: number;
  /** 整行的估算宽度（em），字号自适应据此计算。 */
  widthEm: number;
};

function visibleText(word: string): string {
  return word.trim();
}

/**
 * 词 → 行。规则：累计估算宽度超过 maxWidthEm，或行时长超过 maxDurationMs 就断行。
 * 单个词本身超宽时自成一行（不切词）——切词会把 FDE 断成 FD/E，那比折行难看得多。
 */
export function groupWordsIntoLines(
  words: CaptionWord[],
  opts?: { maxWidthEm?: number; maxDurationMs?: number; lingerMs?: number; totalDurationMs?: number },
): CaptionLine[] {
  const maxWidthEm = opts?.maxWidthEm ?? captionLayout(1920, 1080).maxWidthEm;
  const maxDurationMs = opts?.maxDurationMs ?? CAPTION_MAX_LINE_DURATION_MS;
  const lingerMs = opts?.lingerMs ?? CAPTION_LINGER_MS;

  const usable = words.filter((w) => visibleText(w.w).length > 0);
  const lines: CaptionLine[] = [];
  let bucket: CaptionWord[] = [];
  let widthEm = 0;

  const flush = () => {
    if (bucket.length === 0) return;
    const startMs = bucket[0]!.startMs;
    const endMs = Math.max(...bucket.map((w) => w.endMs));
    lines.push({ words: bucket, startMs, endMs, showFromMs: startMs, showUntilMs: endMs, widthEm });
    bucket = [];
    widthEm = 0;
  };

  for (const word of usable) {
    const em = estimateWidthEm(visibleText(word.w));
    if (bucket.length > 0) {
      const wouldBeSpanMs = word.endMs - bucket[0]!.startMs;
      if (widthEm + em > maxWidthEm || wouldBeSpanMs > maxDurationMs) flush();
    }
    bucket.push(word);
    widthEm += em;
  }
  flush();

  // 上屏区间：挂到下一行开始，但最多多挂 lingerMs。
  const totalDurationMs = opts?.totalDurationMs;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    const hardStop = next ? next.startMs : (totalDurationMs ?? line.endMs + lingerMs);
    line.showUntilMs = Math.min(hardStop, line.endMs + lingerMs);
    if (line.showUntilMs <= line.showFromMs) line.showUntilMs = line.showFromMs + 1;
  }
  return lines;
}

export type TimeSpan = { startMs: number; endMs: number };

/**
 * 需要给字幕垫半透明底板的时段：整屏屏录/图版之上。
 * 描边扛不住白色界面（spec §2.2），而真人底轨本来就暗，不必全程加板。
 */
export function captionBackdropSpans(
  overlays: readonly { kind: string; outputStartMs: number; durationMs: number }[],
): TimeSpan[] {
  return overlays
    .filter((o) => o.kind === 'screen' || o.kind === 'image')
    .map((o) => ({ startMs: o.outputStartMs, endMs: o.outputStartMs + o.durationMs }));
}

export function spansContain(spans: readonly TimeSpan[], ms: number): boolean {
  return spans.some((s) => ms >= s.startMs && ms < s.endMs);
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
