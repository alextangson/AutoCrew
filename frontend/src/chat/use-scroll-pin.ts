import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { INITIAL_PIN, onContent, onScroll, onUserIntent, pinToBottom, showJumpButton, type PinState } from "./scroll-pin";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * 把 scroll-pin 的判定接到一个滚动容器上。
 * contentKey 变 = 内容变了（新消息、进度、流式正文）；open 从关到开 = 重新贴底（不做动画）。
 */
export function useScrollPin(ref: RefObject<HTMLElement | null>, contentKey: unknown[], open: boolean) {
  const stateRef = useRef<PinState>(INITIAL_PIN);
  const [showJump, setShowJump] = useState(false);

  const commit = useCallback((next: PinState) => {
    stateRef.current = next;
    setShowJump(showJumpButton(next));
  }, []);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    // 瞬时滚动：立刻按当前位置结算一次，别让「程序滚动」标记挂着吞掉用户后面的上翻
    if (!smooth) commit(onScroll(stateRef.current, el));
  }, [ref, commit]);

  /** 发消息 / 切会话 / 开新会话：直接到底并恢复跟随 */
  const pin = useCallback(() => {
    commit(pinToBottom(stateRef.current));
    scrollToBottom(false);
  }, [commit, scrollToBottom]);

  /** 「↓ 有新内容」：回到底部；减少动态效果时瞬时 */
  const jumpToBottom = useCallback(() => {
    commit(pinToBottom(stateRef.current));
    scrollToBottom(!prefersReducedMotion());
  }, [commit, scrollToBottom]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleScroll = () => commit(onScroll(stateRef.current, el));
    const handleIntent = () => { stateRef.current = onUserIntent(stateRef.current); };
    el.addEventListener("scroll", handleScroll, { passive: true });
    for (const t of ["wheel", "touchstart", "keydown", "pointerdown"] as const) el.addEventListener(t, handleIntent, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      for (const t of ["wheel", "touchstart", "keydown", "pointerdown"] as const) el.removeEventListener(t, handleIntent);
    };
  }, [ref, commit]);

  useLayoutEffect(() => {
    const { state, scroll } = onContent(stateRef.current);
    commit(state);
    if (scroll) scrollToBottom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, contentKey);

  useLayoutEffect(() => {
    if (open) pin();
  }, [open, pin]);

  return { showJump, jumpToBottom, pin };
}
