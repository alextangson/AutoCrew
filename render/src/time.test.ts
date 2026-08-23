/**
 * time.test.ts —— 字幕块内排版的确定性锁（v2 spec §2.1 / §2.2）。
 *
 * 这一层全是纯函数：同一块 cue 每次必须折出同样的行、算出同样的字号。
 * 渲染的逐帧一致性就建立在这上面，所以这里的用例是字面量，不是「差不多」。
 *
 * 断句已经不在这一层了（cue 由 assemble 冻结），所以本文件不再有 linger / 行时长的概念。
 */
import { describe, it, expect } from 'vitest';
import type { CaptionWord } from './manifest';
import { captionLayout, estimateWidthEm, fitCue, wrapCueLines } from './time';

const LANDSCAPE = captionLayout(1920, 1080);

const word = (w: string, startMs: number, endMs: number): CaptionWord => ({ w, startMs, endMs });
const chars = (text: string): CaptionWord[] =>
  [...text].map((c, i) => word(c, i * 60, i * 60 + 60));

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

describe('wrapCueLines —— 按像素估宽折行', () => {
  it('装得下就一行', () => {
    const lines = wrapCueLines(chars('一二三四五六七八九十'), LANDSCAPE.maxWidthEm);
    expect(lines).toHaveLength(1);
    expect(lines[0]!).toHaveLength(10);
  });

  it('超出行宽就折，断点在超出的那个词之前', () => {
    const lines = wrapCueLines(chars('一二三四五'), 3);
    expect(lines.map((l) => l.map((w) => w.w).join(''))).toEqual(['一二三', '四五']);
  });

  it('拉丁文按 0.55em 算，同样宽度能多放近一倍', () => {
    const words = 'aaaa aaaa aaaa'.split(' ').map((w, i) => word(w, i * 500, i * 500 + 500));
    // 每个 4 字母词 = 2.2em；预算 5em 只装得下 2 个
    expect(wrapCueLines(words, 5).map((l) => l.length)).toEqual([2, 1]);
  });

  it('单个词超宽时自成一行（不切词——FDE 不许断成 FD / E）', () => {
    const lines = wrapCueLines([word('超级长的一个词', 0, 500)], 2);
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]!.w).toBe('超级长的一个词');
  });

  it('没有词就没有行', () => {
    expect(wrapCueLines([], 24)).toEqual([]);
  });
});

describe('fitCue —— ≤2 行，装不下就下压字号', () => {
  it('一行装得下：基准字号 64，一行', () => {
    const fitted = fitCue(chars('今天聊聊 FDE'), LANDSCAPE);
    expect(fitted.fontSize).toBe(64);
    expect(fitted.lines).toHaveLength(1);
  });

  it('两行装得下就不缩字号（≤2 行是合法版式，不是兜底）', () => {
    const fitted = fitCue(chars('一二三四五六七八九十一二三四五六七八九十一二三四五六七八'), LANDSCAPE);
    expect(fitted.fontSize).toBe(64);
    expect(fitted.lines).toHaveLength(2);
  });

  it('三行才装得下 → 下压字号直到塞进 2 行', () => {
    const fitted = fitCue(chars('一'.repeat(52)), LANDSCAPE);
    expect(fitted.lines).toHaveLength(2);
    expect(fitted.fontSize).toBeLessThan(64);
    // 塞进 2 行的最大字号：1536 / 26 = 59.07 → 59
    expect(fitted.fontSize).toBe(59);
  });

  it('超长单 token 比一行还宽 → 字号下压到放得下为止，绝不溢出（边界 #7）', () => {
    const url = 'https://example.com/a-very-long-path-that-never-ends-and-keeps-going';
    const fitted = fitCue([word(url, 0, 2000)], LANDSCAPE);
    expect(fitted.lines).toHaveLength(1);
    // 该 token 宽度 em × 字号 必须 ≤ 行宽
    expect(estimateWidthEm(url) * fitted.fontSize).toBeLessThanOrEqual(LANDSCAPE.rowWidthPx);
    expect(fitted.fontSize).toBeLessThan(LANDSCAPE.minFontSize);
  });

  it('下压不会低于 1px（极端输入不产出 0 字号）', () => {
    const fitted = fitCue([word('字'.repeat(4000), 0, 1000)], LANDSCAPE);
    expect(fitted.fontSize).toBeGreaterThanOrEqual(1);
    expect(fitted.lines).toHaveLength(1);
  });

  it('空白词被丢掉，不占宽度也不占位', () => {
    const fitted = fitCue([word(' ', 0, 100), word('字', 100, 300)], LANDSCAPE);
    expect(fitted.lines[0]!.map((w) => w.w)).toEqual(['字']);
  });

  it('全空白 → 没有行（该段无字幕，不崩；边界 #8）', () => {
    expect(fitCue([word('  ', 0, 100)], LANDSCAPE).lines).toEqual([]);
    expect(fitCue([], LANDSCAPE).lines).toEqual([]);
  });
});
