/**
 * A-roll 改挂的释放一步（创始人确认改挂，§2.5）：接收方的事实提交之后才把原稿那条标成已改挂。幂等——
 * 启动恢复时按事务日志重放也不会重复写。
 */
import type { ReleaseOp } from "./txn.js";
import { mutateProduction } from "./service.js";

export async function applyRelease(dataDir: string, r: ReleaseOp): Promise<number> {
  const at = new Date().toISOString();
  return (await mutateProduction(r.owner, dataDir, (doc) => {
    const released = doc.facts.filter((f) => f.kind === "aroll" && f.sha256 === r.sha256 && f.state === "accepted" && !f.released_to);
    for (const f of released) { f.released_to = r.to; f.released_at = at; }
    return { value: released.length, events: released.length ? [{ type: "aroll_reassigned", detail: { sha256: r.sha256, to: r.to, facts: released.map((f) => f.id) } }] : [] };
  })).value;
}
