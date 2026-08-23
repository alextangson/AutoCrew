/**
 * 审片裁决的**不可变记录**（lifecycle spec §2.4）——`review-decision.v<renderedRevision>.json`。
 *
 * 与 `editor-decision.ts` 是同一个形状的东西：一个人在门上做完决定，产物落一份不可改的账。
 * 它同时是三样东西：
 * - 打回的备注与播放位置（纯前端存的备注活不过一次刷新，而人回到门上第一件事就是想知道自己说过什么）
 * - 定位结果（目标门据此高亮那一槽 / 那一句）
 * - 「哪一版通过、哪一版被拒」的账——§3 收尾清理的判定依据就是它
 */
import { readVersioned, videoDir, writeVersioned } from "./video-store.js";

/** 打回定位的落点：时间戳落在某个 overlay 槽里 → 回门二；否则落到某一句 → 回门一 */
export type ReviewLocation =
  | { kind: "overlay"; overlayId: string }
  | { kind: "segment"; segmentId: string };

export interface VideoReviewDecision {
  schemaVersion: 1;
  renderedRevision: number;
  verdict: "approve" | "reject";
  /** 打回去哪道门；approve 时缺省 */
  target?: "edit" | "cut";
  /** 人在播放器上停的位置（输出时间域毫秒） */
  timestampMs?: number;
  note?: string;
  /** 由纯函数按时间戳算出的落点；时间戳落间隙时就近取分句（§4 #8） */
  locate?: ReviewLocation;
  decidedAt: string;
}

export function writeReviewDecision(
  dataDir: string,
  contentId: string,
  decision: VideoReviewDecision,
): Promise<string> {
  return writeVersioned(videoDir(dataDir, contentId), "review-decision", decision.renderedRevision, decision);
}

/** 这一版成片有没有被裁决过；没有 = null（还没审，或旧稿件） */
export function readReviewDecision(
  dataDir: string,
  contentId: string,
  renderedRevision: number,
): Promise<VideoReviewDecision | null> {
  return readVersioned<VideoReviewDecision>(videoDir(dataDir, contentId), "review-decision", renderedRevision);
}
