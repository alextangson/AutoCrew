/**
 * 成片计划的**确认产物**（lifecycle spec §2.1）——`editor-decision.v<N>.json`。
 *
 * 它替掉了 `overlays.v<cutRevision>.json`。旧写法把确认产物钉在 cut 号上，于是：
 * - cut 不变的第二次确认必撞「版本化产物不可覆盖」（打回门二改一处再确认 = 死路）；
 * - 删到零时干脆不写文件，assemble 读不到就回落成「没有覆盖轨」——**旧 overlay 静默复活**
 *   （因为上一版文件还在盘上，读的是它）。
 *
 * 现在：一版 plan 对一份 decision，N = plan revision；**空计划显式写 `overlays: []`**。
 * assemble 只读 decision，读不到就是真没确认过，当场说人话，不猜。
 */
import type { OverlaySlot } from "./timeline-build.js";
import { readVersioned, videoDir, writeVersioned } from "./video-store.js";

export interface VideoEditorDecision {
  schemaVersion: 1;
  /** 派生自哪一版 plan（= 文件的 v 号），也是 state.confirmedEditorRevision */
  planRevision: number;
  /** 确认那一刻的选段版本。assemble 用它核对「这份决策是不是对当前 keeps 排的」 */
  cutRevision: number;
  /** 覆盖轨槽位。**空数组是合法且有意义的**：纯口播，且旧 overlay 不复活 */
  overlays: OverlaySlot[];
  decidedAt: string;
}

export function writeEditorDecision(
  dataDir: string,
  contentId: string,
  decision: VideoEditorDecision,
): Promise<string> {
  return writeVersioned(videoDir(dataDir, contentId), "editor-decision", decision.planRevision, decision);
}

/** 读不到 = 这一版计划没被确认过（不是「没有覆盖轨」）——两者的区别是本刀的地基 */
export function readEditorDecision(
  dataDir: string,
  contentId: string,
  planRevision: number,
): Promise<VideoEditorDecision | null> {
  return readVersioned<VideoEditorDecision>(videoDir(dataDir, contentId), "editor-decision", planRevision);
}

/**
 * assemble 的读法：读确认产物 + 核对它是对当前选段排的。**任一不成立都当场说人话**——
 * 读不到就当成「没有覆盖轨」往下走，正是这一刀要消灭的静默降级。
 */
export type ConfirmedOverlays =
  | { ok: true; overlays: OverlaySlot[] }
  | { ok: false; errorCode: string; reason: string };

export async function loadConfirmedOverlays(
  dataDir: string,
  contentId: string,
  at: { confirmedEditorRevision?: number; cutRevision: number },
): Promise<ConfirmedOverlays> {
  const revision = at.confirmedEditorRevision;
  if (!revision) {
    return {
      ok: false,
      errorCode: "editor_decision_missing",
      reason: "这一稿还没确认过成片计划（或它来自旧版本的产物）——回成片计划确认一次再组装",
    };
  }
  const decision = await readEditorDecision(dataDir, contentId, revision);
  if (!decision) {
    return {
      ok: false,
      errorCode: "editor_decision_missing",
      reason: `读不到 editor-decision.v${revision}，产物可能被删了——回成片计划重新确认一次`,
    };
  }
  if (decision.cutRevision !== at.cutRevision) {
    return {
      ok: false,
      errorCode: "editor_decision_stale",
      reason:
        `确认过的成片计划是对选段 v${decision.cutRevision} 排的，当前选段已是 v${at.cutRevision}——` +
        "回成片计划按新选段重排并确认一次",
    };
  }
  return { ok: true, overlays: decision.overlays };
}
