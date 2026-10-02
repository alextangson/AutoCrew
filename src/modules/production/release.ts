/**
 * A-roll 改挂的释放一步（创始人确认改挂，§2.5）：接收方的事实提交之后才把原稿那条标成已改挂。幂等——
 * 启动恢复时按事务日志重放也不会重复写。
 */
import type { ReleaseOp } from "./txn.js";
import { mutateProduction } from "./service.js";
import { newId } from "../../storage/production-store.js";

export async function applyRelease(dataDir: string, r: ReleaseOp): Promise<number> {
  const at = new Date().toISOString();
  if (r.undo) return releaseCurrent(dataDir, r, r.undo, at);
  return (await mutateProduction(r.owner, dataDir, (doc) => {
    const released = doc.facts.filter((f) => f.kind === "aroll" && f.sha256 === r.sha256 && f.state === "accepted" && !f.released_to);
    for (const f of released) { f.released_to = r.to; f.released_at = at; }
    return { value: released.length, events: released.length ? [{ type: "aroll_reassigned", detail: { sha256: r.sha256, to: r.to, facts: released.map((f) => f.id) } }] : [] };
  })).value;
}

/** 当前轮改挂的释放（1b §7）：原稿那条转 rejected、写决定、解冻（冻结副本留作历史）。幂等 */
async function releaseCurrent(dataDir: string, r: ReleaseOp, undo: NonNullable<ReleaseOp["undo"]>, at: string): Promise<number> {
  return (await mutateProduction(r.owner, dataDir, (doc) => {
    const f = doc.facts.find((x) => x.id === undo.fact_id && x.state === "accepted");
    if (!f) return { value: 0, events: [] };
    Object.assign(f, { state: "rejected", evidence: `创始人改挂到了《${undo.to_title}》`, released_to: r.to, released_at: at });
    doc.decisions.push({ id: newId("dec"), type: "aroll_reassign", round: doc.round, at, source: "founder", fact_id: f.id, sha256: r.sha256, note: r.to });
    doc.frozen = null;
    return { value: 1, events: [{ type: "aroll_reassigned", detail: { fact_id: f.id, sha256: r.sha256, to: r.to } }] };
  })).value;
}
