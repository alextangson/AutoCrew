/**
 * overlay.test.ts —— 覆盖轨 fit 默认值（横屏 spec §2.5）。
 * 这条规则的代价很实：默认错了，屏录里的一行字就被裁掉，而人在成片里才看得见。
 */
import { describe, it, expect } from 'vitest';
import { defaultFit } from './overlay';

describe('defaultFit', () => {
  it('屏录与图版默认 contain——黑边好过裁字', () => {
    expect(defaultFit('screen')).toBe('contain');
    expect(defaultFit('image')).toBe('contain');
  });

  it('AI 镜头维持 cover——生成画面裁边不丢信息', () => {
    expect(defaultFit('ai')).toBe('cover');
  });

  it('graphic 用不上 fit，取默认值也不该是 cover（它自己铺满画布）', () => {
    expect(defaultFit('graphic')).toBe('contain');
  });
});
