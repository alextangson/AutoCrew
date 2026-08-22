/**
 * time.test.ts —— 字幕横屏排版的确定性锁（横屏 spec §2.2）。
 *
 * 这一层全是纯函数：同样的词流每次必须分出同样的行、算出同样的字号。
 * 渲染的逐帧一致性就建立在这上面，所以这里的用例是字面量，不是「差不多」。
 */
import { describe, it, expect } from 'vitest';
import type { CaptionWord } from './manifest';
import {
  captionBackdropSpans,
  captionFontSize,
  captionLayout,
  estimateWidthEm,
  groupWordsIntoLines,
  spansContain,
} from './time';

const LANDSCAPE = captionLayout(1920, 1080);

const word = (w: string, startMs: number, endMs: number): CaptionWord => ({ w, startMs, endMs });

describe('estimateWidthEm', () => {
  it('CJK 1em / 数字 0.6em / 拉丁 0.55em', () => {
    expect(estimateWidthEm('今天')).toBe(2);
    expect(estimateWidthEm('12')).toBeCloseTo(1.2, 5);
    expect(estimateWidthEm('ab')).toBeCloseTo(1.1, 5);
  });

  it('混排按字符累加，中英文各算各的', () => {
    // 「聊」1 + FDE 0.55×3 + 「3」0.6 = 3.25
    expect(estimateWidthEm('聊FDE3')).toBeCloseTo(3.25, 5);
  });

  it('中英文标点与空格都按 0.5 兜底（宁可高估——高估只提前断行，低估会冲出画面）', () => {
    expect(estimateWidthEm('，')).toBe(1); // 全角标点是方块字宽
    expect(estimateWidthEm(',')).toBe(0.5);
    expect(estimateWidthEm(' ')).toBe(0.5);
  });

  it('空串是 0，不是 NaN', () => {
    expect(estimateWidthEm('')).toBe(0);
  });
});

describe('captionLayout（1920×1080）', () => {
  it('单行最大宽度 = 画布宽 80%，字号区间 56–64', () => {
    expect(LANDSCAPE.rowWidthPx).toBe(1536);
    expect(LANDSCAPE.maxFontSize).toBe(64);
    expect(LANDSCAPE.minFontSize).toBe(56);
  });

  it('断行预算 = 一行在基准字号下装得下的 em 数（24em ≈ 24 个汉字）', () => {
    expect(LANDSCAPE.maxWidthEm).toBe(24);
  });

  it('字号跟画布高度走：换画幅不会让字幕忽大忽小', () => {
    expect(captionLayout(3840, 2160).maxFontSize).toBe(128);
  });
});

describe('captionFontSize —— 超长句缩字号优先于折行', () => {
  it('装得下就用基准字号', () => {
    expect(captionFontSize(10, LANDSCAPE)).toBe(64);
    expect(captionFontSize(24, LANDSCAPE)).toBe(64);
  });

  it('略超一行 → 缩字号塞回一行，而不是立刻折行', () => {
    // 1536 / 25 = 61.44 → 61，仍在 56–64 区间内
    expect(captionFontSize(25, LANDSCAPE)).toBe(61);
  });

  it('缩到下限还装不下 → 停在下限，交给折行（最多 2 行）', () => {
    expect(captionFontSize(40, LANDSCAPE)).toBe(56);
  });

  it('空行不炸：宽度 0 时返回基准字号', () => {
    expect(captionFontSize(0, LANDSCAPE)).toBe(64);
  });
});

describe('groupWordsIntoLines —— 按像素估宽断行', () => {
  it('按宽度断行：横屏一行放得下 20+ 汉字，不再是 10 字一刀切', () => {
    const words = [...'一二三四五六七八九十一二三四五六七八九十'].map((c, i) => word(c, i * 60, i * 60 + 60));
    const lines = groupWordsIntoLines(words, { maxWidthEm: LANDSCAPE.maxWidthEm });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.words).toHaveLength(20);
    expect(lines[0]!.widthEm).toBe(20);
  });

  it('超出宽度预算就断行，断点在超出的那个词之前', () => {
    const words = [...'一二三四五'].map((c, i) => word(c, i * 60, i * 60 + 60));
    const lines = groupWordsIntoLines(words, { maxWidthEm: 3 });
    expect(lines.map((l) => l.words.map((w) => w.w).join(''))).toEqual(['一二三', '四五']);
  });

  it('拉丁文按 0.55em 算，同样宽度能多放近一倍', () => {
    const words = 'aaaa aaaa aaaa'.split(' ').map((w, i) => word(w, i * 500, i * 500 + 500));
    // 每个 4 字母词 = 2.2em；预算 5em 只装得下 2 个
    const lines = groupWordsIntoLines(words, { maxWidthEm: 5, maxDurationMs: 10_000 });
    expect(lines.map((l) => l.words.length)).toEqual([2, 1]);
  });

  it('单个词超宽时自成一行（不切词——FDE 不许断成 FD / E）', () => {
    const lines = groupWordsIntoLines([word('超级长的一个词', 0, 500)], { maxWidthEm: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.words[0]!.w).toBe('超级长的一个词');
  });

  it('时长仍然断行：说得慢的时候不让一行挂太久', () => {
    const words = [word('慢', 0, 2000), word('话', 2000, 4000)];
    const lines = groupWordsIntoLines(words, { maxWidthEm: 24, maxDurationMs: 2500 });
    expect(lines).toHaveLength(2);
  });

  it('空白词被丢掉，不占宽度也不占位', () => {
    const lines = groupWordsIntoLines([word(' ', 0, 100), word('字', 100, 300)], { maxWidthEm: 24 });
    expect(lines[0]!.words.map((w) => w.w)).toEqual(['字']);
  });

  it('上屏区间挂到下一行开始，最多多挂 lingerMs', () => {
    const words = [word('一', 0, 200), word('二', 5000, 5200)];
    const lines = groupWordsIntoLines(words, { maxWidthEm: 24, maxDurationMs: 1000, lingerMs: 1000 });
    expect(lines[0]!.showUntilMs).toBe(1200);
    expect(lines[1]!.showFromMs).toBe(5000);
  });

  it('没有词就没有行（空转写不该崩）', () => {
    expect(groupWordsIntoLines([])).toEqual([]);
  });
});

describe('底板时段', () => {
  it('只有整屏屏录/图版之上才垫板——真人底轨本来就暗，不必全程加板', () => {
    const spans = captionBackdropSpans([
      { kind: 'screen', outputStartMs: 1000, durationMs: 2000 },
      { kind: 'image', outputStartMs: 5000, durationMs: 1000 },
      { kind: 'graphic', outputStartMs: 8000, durationMs: 1000 },
      { kind: 'ai', outputStartMs: 9000, durationMs: 1000 },
    ]);
    expect(spans).toEqual([
      { startMs: 1000, endMs: 3000 },
      { startMs: 5000, endMs: 6000 },
    ]);
  });

  it('区间左闭右开：结束那一刻底板就撤', () => {
    const spans = [{ startMs: 1000, endMs: 2000 }];
    expect(spansContain(spans, 1000)).toBe(true);
    expect(spansContain(spans, 1999)).toBe(true);
    expect(spansContain(spans, 2000)).toBe(false);
    expect(spansContain([], 1000)).toBe(false);
  });
});
