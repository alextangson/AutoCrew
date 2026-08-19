/**
 * 总编辑栏的常驻偏好（对话控制面设计 §Phase 3「常驻与上下文」）。
 *
 * 两条纪律：
 * 1. **缺省翻转不覆盖老用户**：没存过值 = 新用户 → 默认展开；存过 "0"（手动收起过）
 *    的老用户照旧收起——缺省改的是"没表态"那一支，不是替用户重新表态。
 * 2. **宽度自己夹**：localStorage 是用户能手改的地方，读出来的值一律 clamp，
 *    坏值退回 360，不让对话栏变成 3px 的缝或者吃掉整屏。
 */
export const DOCK_WIDTH_DEFAULT = 360;
export const DOCK_WIDTH_MIN = 320;
export const DOCK_WIDTH_MAX = 560;

export const DOCK_OPEN_KEY = "dock-open";
export const DOCK_WIDTH_KEY = "dock-width";

/** localStorage 的最小面（node 测试注入假实现；浏览器给真的） */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): PrefStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // 隐私模式下访问会抛——没有记忆也不能让壳起不来
  }
}

/** 夹到 [320, 560]；空值/非数字/NaN 回默认 360（Number("") 是 0，不能当宽度用） */
export function clampDockWidth(value: unknown): number {
  if (value === null || value === undefined || value === "") return DOCK_WIDTH_DEFAULT;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DOCK_WIDTH_DEFAULT;
  return Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, Math.round(n)));
}

/** 缺省展开：只有显式存过 "0"（用户手动收起）才收起 */
export function readDockOpen(store: PrefStore | null = defaultStore()): boolean {
  try {
    return store?.getItem(DOCK_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeDockOpen(open: boolean, store: PrefStore | null = defaultStore()): void {
  try {
    store?.setItem(DOCK_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* 存不下最多是下次回默认，不影响本次开合 */
  }
}

export function readDockWidth(store: PrefStore | null = defaultStore()): number {
  try {
    const raw = store?.getItem(DOCK_WIDTH_KEY);
    return raw === null || raw === undefined ? DOCK_WIDTH_DEFAULT : clampDockWidth(raw);
  } catch {
    return DOCK_WIDTH_DEFAULT;
  }
}

export function writeDockWidth(width: number, store: PrefStore | null = defaultStore()): void {
  try {
    store?.setItem(DOCK_WIDTH_KEY, String(clampDockWidth(width)));
  } catch {
    /* 同上 */
  }
}
