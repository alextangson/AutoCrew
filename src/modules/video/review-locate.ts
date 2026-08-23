/**
 * 打回定位（lifecycle spec §2.4）——**纯函数**：给一个成片时间戳，算出它落在哪。
 *
 * 为什么不放前端：定位结果要落进 `review-decision.v<K>.json`，刷新、换窗口、
 * 第二天再打开都得看得见同一句「你说的是这一段」。纯前端算的定位活不过一次刷新。
 *
 * 判定次序即语义：覆盖轨优先（人在那一秒看见的是 B-roll，抱怨的就是它），
 * 否则落到分句；落在间隙或越界时**就近取分句，不返回 null 也不抛**（§4 #8）。
 */
import type { ReviewLocation } from "./review-decision.js";

/** 输出时间域的一段区间；`[startMs, endMs)` 左闭右开 */
export interface LocateSpan {
  id: string;
  startMs: number;
  endMs: number;
}

function containing(spans: readonly LocateSpan[], t: number): LocateSpan | null {
  // 同起点时取先出现的那一条：定位必须确定，不能随数组顺序摇摆
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return sorted.find((s) => t >= s.startMs && t < s.endMs) ?? null;
}

function distance(span: LocateSpan, t: number): number {
  if (t < span.startMs) return span.startMs - t;
  if (t >= span.endMs) return t - span.endMs + 1;
  return 0;
}

/** 就近分句：距离相同时取靠前的那一句（早说的那句更可能是问题的起点） */
function nearest(spans: readonly LocateSpan[], t: number): LocateSpan | null {
  let best: LocateSpan | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const d = distance(span, t);
    if (d < bestDist) {
      best = span;
      bestDist = d;
    }
  }
  return best;
}

export function locateReviewTarget(
  timestampMs: number,
  overlays: readonly LocateSpan[],
  segments: readonly LocateSpan[],
): ReviewLocation | null {
  if (!Number.isFinite(timestampMs)) return null;
  const overlay = containing(overlays, timestampMs);
  if (overlay) return { kind: "overlay", overlayId: overlay.id };
  const segment = containing(segments, timestampMs) ?? nearest(segments, timestampMs);
  return segment ? { kind: "segment", segmentId: segment.id } : null;
}

/** 落点 → 建议回哪道门。覆盖轨归门二（成片计划），话归门一（选段） */
export function suggestedGate(location: ReviewLocation | null): "edit" | "cut" {
  return location?.kind === "overlay" ? "edit" : "cut";
}
