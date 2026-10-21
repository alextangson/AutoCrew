import { describe, expect, it } from "vitest";
import { INITIAL_PIN, isAtBottom, onContent, onScroll, onUserIntent, pinToBottom, showJumpButton, type PinState } from "./scroll-pin";

const m = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight });
const bottom = 1500;

describe("isAtBottom", () => {
  it("离底 80px 以内算在底部，超过就不算", () => {
    expect(isAtBottom(m(bottom))).toBe(true);
    expect(isAtBottom(m(bottom - 80))).toBe(true);
    expect(isAtBottom(m(bottom - 81))).toBe(false);
  });
  it("内容不满一屏也算在底部", () => {
    expect(isAtBottom(m(0, 300, 500))).toBe(true);
  });
});

describe("onScroll", () => {
  const atBottom: PinState = { ...INITIAL_PIN, lastTop: bottom };
  it("用户往上翻出 80px → 停止跟随", () => {
    expect(onScroll(atBottom, m(bottom - 200)).following).toBe(false);
  });
  it("80px 以内的小幅上翻仍然跟随", () => {
    expect(onScroll(atBottom, m(bottom - 50)).following).toBe(true);
  });
  it("程序滚动途中的 scroll 事件不算用户上翻", () => {
    const s = pinToBottom({ ...atBottom, following: false, lastTop: 900 });
    // smooth 动画中途：位置还在中段
    const mid = onScroll(s, m(1000));
    expect(mid.following).toBe(true);
    // 到底后标记清掉
    const done = onScroll(mid, m(bottom));
    expect(done.programmatic).toBe(false);
    expect(onScroll(done, m(bottom - 300)).following).toBe(false);
  });
  it("用户在程序滚动中动手 → 标记作废，之后上翻照常停跟随", () => {
    const s = onUserIntent(pinToBottom({ ...atBottom, lastTop: 1200 }));
    expect(s.programmatic).toBe(false);
    expect(onScroll(s, m(1000)).following).toBe(false);
  });
  it("内容变短把 scrollTop 夹小时落在底部，不停跟随", () => {
    const s = onScroll(atBottom, m(700, 1200, 500));
    expect(s.following).toBe(true);
  });
  it("没跟随时往下翻但没到底：保持不跟随", () => {
    const s = { ...atBottom, following: false, lastTop: 500 };
    expect(onScroll(s, m(800)).following).toBe(false);
  });
  it("翻回底部 → 恢复跟随并清掉新内容提示", () => {
    const s = { ...atBottom, following: false, hasNew: true, lastTop: 500 };
    const r = onScroll(s, m(bottom - 10));
    expect(r.following).toBe(true);
    expect(showJumpButton(r)).toBe(false);
  });
});

describe("onContent", () => {
  it("跟随中：要求滚到底，不亮按钮", () => {
    const r = onContent(INITIAL_PIN);
    expect(r.scroll).toBe(true);
    expect(showJumpButton(r.state)).toBe(false);
  });
  it("没跟随：不滚，亮「有新内容」", () => {
    const r = onContent({ ...INITIAL_PIN, following: false });
    expect(r.scroll).toBe(false);
    expect(showJumpButton(r.state)).toBe(true);
  });
  it("上翻了但还没来新内容：不亮按钮", () => {
    expect(showJumpButton({ ...INITIAL_PIN, following: false })).toBe(false);
  });
});

describe("pinToBottom", () => {
  it("发消息/点按钮：恢复跟随、清提示", () => {
    const r = pinToBottom({ following: false, programmatic: false, lastTop: 10, hasNew: true });
    expect(r.following).toBe(true);
    expect(r.hasNew).toBe(false);
    expect(showJumpButton(r)).toBe(false);
  });
});
