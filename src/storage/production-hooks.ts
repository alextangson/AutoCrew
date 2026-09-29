/**
 * 稿件写锁里的两处本体钩子（spec §2.1 / §2.5 / §13-C）。只被 local-store 在同一把写锁里调，
 * 所以这里只用不取锁的存储原语。
 *
 * - 正文写口：本轮已冻结 → 拒（覆盖 content update、writer submit、我的内容回写、版本回滚、auto_fix…
 *   所有写正文的路都经 updateContentLocked）。待录制改稿：创始人改 → 认稿重绑新正文；agent 改 → 认稿失效
 *   （正文哈希对不上即失效），启用后 status 投影回 draft_ready。
 * - 状态流转：推到「认稿」及之后是创始人决定，模型一律拒；创始人认稿即写认稿决定（绑正文哈希），
 *   创始人把认过的稿拉回写稿段即写撤回。
 */
import type { ContentStatus } from "./local-store.js";
import {
  appendTimeline, bodyHash, isFrozen, isOntologyEnabled, latestScriptDecision, newId, readProductionDoc, readProductionDocOrEmpty,
  ScriptFrozenError, stampEvents, writeProductionDoc,
} from "./production-store.js";
import type { ProductionDoc } from "./production-types.js";
import { isVideoPlatform } from "./stage-guard.js";

/** 模型不能推到的状态：认稿及之后（§2.1，Codex P1-2） */
export const FOUNDER_ONLY_STATUSES: ReadonlySet<ContentStatus> = new Set([
  "approved", "editing", "cover_pending", "publish_ready", "publishing", "published",
]);

export const SCRIPT_APPROVAL_FOUNDER_ONLY =
  "认稿（以及之后的剪辑、待发布、已发布）是创始人的决定，只能由创作者在看板或工作台上点，AI 宿主不能代推。稿子写好就停在「等你认稿」，把链接交给创作者。";

const WRITING_BACK: ReadonlySet<ContentStatus> = new Set(["drafting", "reviewing", "revision", "draft_ready"]);

export type Editor = "founder" | "agent";

export interface ScriptEditPlan {
  /** 需要写回 production.json 的重绑决定（锁内、meta 落盘后写） */
  rebind: { doc: ProductionDoc; hash: string } | null;
  /** 启用后 agent 改稿作废认稿：status 投影回写稿段 */
  status: ContentStatus | null;
}

/** 正文要变之前：冻结就拒；有认稿就按改稿人定重绑 / 作废 */
export async function planScriptEdit(
  id: string, dataDir: string | undefined,
  existing: { status: ContentStatus; platform?: string; body: string },
  nextBody: string, editor: Editor,
): Promise<ScriptEditPlan> {
  const none: ScriptEditPlan = { rebind: null, status: null };
  if (nextBody === existing.body) return none;
  const doc = await readProductionDoc(id, dataDir);
  if (isFrozen(doc)) throw new ScriptFrozenError();
  if (!doc || !isVideoPlatform(existing.platform)) return none;
  const d = latestScriptDecision(doc);
  if (d?.type !== "script_approval" || d.body_hash !== bodyHash(existing.body)) return none;
  if (editor === "founder") return { rebind: { doc, hash: bodyHash(nextBody) }, status: null };
  const enabled = await isOntologyEnabled(dataDir);
  return { rebind: null, status: enabled && existing.status === "approved" ? "draft_ready" : null };
}

export async function applyScriptEdit(id: string, dataDir: string | undefined, plan: ScriptEditPlan): Promise<void> {
  if (!plan.rebind) return;
  const { doc, hash } = plan.rebind;
  const next = structuredClone(doc);
  next.decisions.push({ id: newId("dec"), type: "script_approval", round: next.round, at: new Date().toISOString(), source: "founder", body_hash: hash, note: "创始人改稿，认稿重绑新正文" });
  const events = stampEvents(next, [{ type: "script_rebound", detail: { body_hash: hash } }]);
  await writeProductionDoc(id, dataDir, next, doc.revision);
  await appendTimeline(id, dataDir, events);
}

/** 流转进锁前的硬门：模型推到认稿及之后一律拒（force 也不行） */
export function modelTransitionRefusal(target: ContentStatus, decidedBy: Editor | undefined): string | null {
  return decidedBy === "agent" && FOUNDER_ONLY_STATUSES.has(target) ? SCRIPT_APPROVAL_FOUNDER_ONLY : null;
}

/** 创始人流转落盘后：认稿写决定；从认过稿的状态拉回写稿段写撤回 */
export async function recordScriptTransition(
  id: string, dataDir: string | undefined,
  content: { platform?: string; body: string }, from: ContentStatus, to: ContentStatus, decidedBy: Editor | undefined,
): Promise<void> {
  if (decidedBy !== "founder" || !isVideoPlatform(content.platform)) return;
  const approving = to === "approved" && from !== "approved";
  const revoking = WRITING_BACK.has(to) && FOUNDER_ONLY_STATUSES.has(from);
  if (!approving && !revoking) return;
  const doc = await readProductionDocOrEmpty(id, dataDir);
  const next = structuredClone(doc);
  const at = new Date().toISOString();
  const hash = bodyHash(content.body);
  next.decisions.push(approving
    ? { id: newId("dec"), type: "script_approval", round: next.round, at, source: "founder", body_hash: hash }
    : { id: newId("dec"), type: "script_revoke", round: next.round, at, source: "founder" });
  const events = stampEvents(next, [{ type: approving ? "script_approved" : "script_revoked", detail: { body_hash: hash, from, to } }], at);
  await writeProductionDoc(id, dataDir, next, doc.revision);
  await appendTimeline(id, dataDir, events);
}
