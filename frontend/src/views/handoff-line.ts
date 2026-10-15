/** 看板卡 / 卡片面板上「交出去之后」那一句（spec 2026-10-15 §B5），纯函数 */

/** 没人接手多久算「没接上？」 */
export const PICKUP_STALE_MS = 30 * 60_000;

export interface HandoffView { host: string; label: string; at: string; pickedUp: boolean; holder: string | null }

/** 卡上那一句：谁正认领着 → 「X 在写」；接手了 → 「X 在写」；没人接 → 「已交给 X，等它接手」；超过 30 分钟 → 「X 没接上？」 */
export function handoffLine(h: HandoffView | undefined, now = Date.now()): { text: string; stale: boolean } | null {
  if (!h) return null;
  if (h.holder) return { text: `${h.holder} 在写`, stale: false };
  if (h.pickedUp) return { text: `${h.label} 在写`, stale: false };
  if (now - Date.parse(h.at) < PICKUP_STALE_MS) return { text: `已交给 ${h.label}，等它接手`, stale: false };
  return { text: `${h.label} 没接上？`, stale: true };
}
