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

/** 字幕分行阈值：每行 ≤10 字（中文无空格，按字符数）或 ≤2.5 秒。 */
export const CAPTION_MAX_CHARS_PER_LINE = 10;
export const CAPTION_MAX_LINE_DURATION_MS = 2500;
/** 一行讲完后最多再挂 1 秒（下一行来了就换），避免长停顿时字幕悬空。 */
export const CAPTION_LINGER_MS = 1000;

export type CaptionLine = {
  words: CaptionWord[];
  startMs: number;
  endMs: number;
  /** 实际上屏区间 [showFromMs, showUntilMs)，由 groupWordsIntoLines 一并算好。 */
  showFromMs: number;
  showUntilMs: number;
};

function visibleLength(word: string): number {
  return [...word.trim()].length;
}

/**
 * 词 → 行。规则：累计字符数超过 maxChars，或行时长超过 maxDurationMs 就断行。
 * 单个词本身超长时自成一行（不切词）。
 */
export function groupWordsIntoLines(
  words: CaptionWord[],
  opts?: { maxChars?: number; maxDurationMs?: number; lingerMs?: number; totalDurationMs?: number },
): CaptionLine[] {
  const maxChars = opts?.maxChars ?? CAPTION_MAX_CHARS_PER_LINE;
  const maxDurationMs = opts?.maxDurationMs ?? CAPTION_MAX_LINE_DURATION_MS;
  const lingerMs = opts?.lingerMs ?? CAPTION_LINGER_MS;

  const usable = words.filter((w) => visibleLength(w.w) > 0);
  const lines: CaptionLine[] = [];
  let bucket: CaptionWord[] = [];
  let chars = 0;

  const flush = () => {
    if (bucket.length === 0) return;
    const startMs = bucket[0]!.startMs;
    const endMs = Math.max(...bucket.map((w) => w.endMs));
    lines.push({ words: bucket, startMs, endMs, showFromMs: startMs, showUntilMs: endMs });
    bucket = [];
    chars = 0;
  };

  for (const word of usable) {
    const len = visibleLength(word.w);
    if (bucket.length > 0) {
      const wouldBeChars = chars + len;
      const wouldBeSpanMs = word.endMs - bucket[0]!.startMs;
      if (wouldBeChars > maxChars || wouldBeSpanMs > maxDurationMs) flush();
    }
    bucket.push(word);
    chars += len;
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
