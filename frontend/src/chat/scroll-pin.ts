/**
 * 对话区「贴底跟随」的判定（纯函数，不碰 DOM）。
 *
 * 规则：离底 80px 以内算「在底部」→ 新内容来了继续跟；用户往上翻出这个范围 → 停止跟随，
 * 新内容到达时亮「↓ 有新内容」。程序自己滚动（跟随、回到底部）期间的 scroll 事件不能被误读成
 * 用户上翻——这是这类功能最常见的 bug，所以程序滚动打一个标记，直到滚到底或用户真的动手才清掉。
 */
export const PIN_THRESHOLD_PX = 80;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface PinState {
  /** 是否跟随新内容贴底 */
  following: boolean;
  /** 程序发起的滚动还在进行（smooth 动画中途的 scroll 事件不算用户操作） */
  programmatic: boolean;
  /** 上一次看到的 scrollTop，用来分辨「往上翻」 */
  lastTop: number;
  /** 停止跟随之后有没有来过新内容 */
  hasNew: boolean;
}

export const INITIAL_PIN: PinState = { following: true, programmatic: false, lastTop: 0, hasNew: false };

export function isAtBottom(m: ScrollMetrics, threshold = PIN_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.clientHeight - m.scrollTop <= threshold;
}

/** 收到一次 scroll 事件 */
export function onScroll(s: PinState, m: ScrollMetrics): PinState {
  if (isAtBottom(m)) return { following: true, programmatic: false, lastTop: m.scrollTop, hasNew: false };
  // 程序滚动途中：不改跟随状态
  if (s.programmatic) return { ...s, lastTop: m.scrollTop };
  // 只有往上翻才停止跟随；内容变短导致的 scrollTop 被夹小会落在底部分支里，不会走到这
  if (m.scrollTop < s.lastTop) return { ...s, following: false, lastTop: m.scrollTop };
  return { ...s, lastTop: m.scrollTop };
}

/** 用户真的动手了（滚轮、触摸、键盘）：程序滚动的标记作废，之后的 scroll 按用户意图算 */
export function onUserIntent(s: PinState): PinState {
  return s.programmatic ? { ...s, programmatic: false } : s;
}

/** 内容变了：返回新状态，以及要不要把视口滚到底 */
export function onContent(s: PinState): { state: PinState; scroll: boolean } {
  if (s.following) return { state: { ...s, programmatic: true }, scroll: true };
  return { state: { ...s, hasNew: true }, scroll: false };
}

/** 主动回到底部（发消息、点「有新内容」、开栏、切会话）：恢复跟随 */
export function pinToBottom(s: PinState): PinState {
  return { ...s, following: true, programmatic: true, hasNew: false };
}

export function showJumpButton(s: PinState): boolean {
  return !s.following && s.hasNew;
}
