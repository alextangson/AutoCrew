/**
 * emphasis.test.ts —— 强调词匹配（横屏 spec §2.7 + 边界 #14）。
 * 纯函数，确定性用例：命中与不命中都得可预测，否则「哪个词该亮」永远说不清。
 */
import { describe, it, expect } from 'vitest';
import type { CaptionWord } from './manifest';
import { markEmphasis, normalizeEmphasis } from './emphasis';

const words = (...ws: string[]): CaptionWord[] =>
  ws.map((w, i) => ({ w, startMs: i * 100, endMs: i * 100 + 100 }));

describe('normalizeEmphasis', () => {
  it('小写化 + 去标点 + 去空白', () => {
    expect(normalizeEmphasis('FDE，')).toBe('fde');
    expect(normalizeEmphasis('  Deep Work! ')).toBe('deepwork');
    expect(normalizeEmphasis('「效率」')).toBe('效率');
  });

  it('中英文标点一视同仁', () => {
    expect(normalizeEmphasis('A/B 测试')).toBe(normalizeEmphasis('AB测试'));
  });

  it('纯标点归一化后是空串（不会变成能命中一切的通配）', () => {
    expect(normalizeEmphasis('。，！')).toBe('');
  });
});

describe('markEmphasis', () => {
  it('大小写 / 标点不同也命中——精确匹配的死角就在这儿', () => {
    expect(markEmphasis(words('今天', 'FDE，', '很好'), ['fde'])).toEqual([false, true, false]);
  });

  it('跨词短语：ASR 把「工程师」切成三个字，整条短语照样命中', () => {
    expect(markEmphasis(words('是', '工', '程', '师', '啊'), ['工程师'])).toEqual([
      false, true, true, true, false,
    ]);
  });

  it('跨词短语跨标点也认（转写里的逗号不该挡住匹配）', () => {
    expect(markEmphasis(words('深', '度，', '工作'), ['深度工作'])).toEqual([true, true, true]);
  });

  it('多条强调词各管各的，重叠取并集', () => {
    expect(markEmphasis(words('效', '率', '与', '专注'), ['效率', '专注'])).toEqual([true, true, false, true]);
  });

  it('归一化后仍无匹配 → 一个都不亮（边界 #14：不猜、不模糊匹配）', () => {
    expect(markEmphasis(words('今天', '天气', '不错'), ['区块链'])).toEqual([false, false, false]);
  });

  it('部分匹配不算命中：「工程」不该点亮「工程师」里的头两个字之外的东西', () => {
    expect(markEmphasis(words('工', '程', '师'), ['工程'])).toEqual([true, true, false]);
  });

  it('空强调词表 / 纯标点强调词 → 全不亮，不炸', () => {
    expect(markEmphasis(words('一', '二'), [])).toEqual([false, false]);
    expect(markEmphasis(words('一', '二'), ['，', '  '])).toEqual([false, false]);
  });

  it('空词流返回空数组', () => {
    expect(markEmphasis([], ['fde'])).toEqual([]);
  });

  it('同一条短语出现两次，两处都亮', () => {
    expect(markEmphasis(words('效', '率', '和', '效', '率'), ['效率'])).toEqual([true, true, false, true, true]);
  });
});
