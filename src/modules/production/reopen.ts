/**
 * 「重开文稿」（spec §2.5，§13-D）：唯一的解冻方式，只由创始人在浏览器会话里点。
 *
 * 原子地结束当前 round：本轮事实、批准、登记转入历史（不删文件，本轮原片挪进 `02-aroll/_作废-<round>/`，
 * 被 ChatCut 工程引用的原片不挪）；round+1；解冻；认稿失效，稿子回写稿中；阶段回推导。
 * 挪原片走文件归属事务日志，中途崩了启动时按事务 id 恢复。
 */
import path from "node:path";
import { contentRoot } from "../../storage/content-project.js";
import { newId, readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { reserveTarget } from "./files.js";
import { withFileOwnership } from "./mutex.js";
import { ensureProductionReady, mutateProduction } from "./service.js";
import { dropTxn, rollbackTxn, runMove, saveTxn, type Txn } from "./txn.js";

export interface ReopenResult { ok: boolean; round?: number; moved?: string[]; error?: string; code?: string }

function arollsToRetire(doc: ProductionDoc): Fact[] {
  const referenced = new Set(doc.facts.filter((f) => f.round === doc.round && f.kind === "chatcut_project").flatMap((f) => f.uses_aroll ?? []));
  return doc.facts.filter((f) => f.round === doc.round && f.kind === "aroll" && f.state === "accepted" && f.availability === "present"
    && f.path && !path.isAbsolute(f.path) && f.path.startsWith("02-aroll/") && !f.path.startsWith("02-aroll/_作废-") && !referenced.has(f.id) && f.sha256);
}

async function moveRetired(contentId: string, dataDir: string, doc: ProductionDoc, txn: Txn): Promise<Map<string, string>> {
  const root = contentRoot(contentId, dataDir);
  const moved = new Map<string, string>();
  for (const fact of arollsToRetire(doc)) {
    const source = path.join(root, fact.path!);
    const ext = path.extname(source);
    const target = await reserveTarget(path.join(root, "02-aroll", `_作废-${doc.round}`), path.basename(source, ext), ext);
    const op = { op: "move" as const, source, target, sha256: fact.sha256!, step: "planned" as const };
    txn.ops.push(op);
    await saveTxn(dataDir, txn);
    await runMove(dataDir, txn, op, async () => undefined);
    moved.set(fact.id, path.relative(root, target));
  }
  return moved;
}

export async function reopenScript(contentId: string, dataDir: string, note?: string): Promise<ReopenResult> {
  await ensureProductionReady(dataDir);
  return withFileOwnership(async () => {
    const doc = await readProductionDocOrEmpty(contentId, dataDir);
    const txn: Txn = { id: newId("txn"), kind: "reopen", content_id: contentId, round: doc.round, ops: [], at: new Date().toISOString() };
    let moved: Map<string, string>;
    try { moved = await moveRetired(contentId, dataDir, doc, txn); }
    catch (err) {
      await rollbackTxn(dataDir, txn).catch(() => undefined);
      return { ok: false, code: "reopen_failed", error: `重开失败，原片没动：${err instanceof Error ? err.message : String(err)}` };
    }
    const commit = () => mutateProduction(contentId, dataDir, (d) => {
      if (d.round !== doc.round) throw new Error("这条刚被别处重开过，刷新再看");
      for (const f of d.facts) if (moved.has(f.id)) f.path = moved.get(f.id);
      const ended = d.round;
      d.decisions.push({ id: newId("dec"), type: "reopen", round: ended, at: new Date().toISOString(), source: "founder", ...(note ? { note } : {}) });
      d.round = ended + 1;
      d.frozen = null;
      d.commit_failure = null;
      if (txn.ops.length) d.txns = [...(d.txns ?? []), txn.id];
      return { value: ended + 1, events: [{ type: "script_reopened", detail: { ended_round: ended, retired: [...moved.values()] } }] };
    });
    let round: number;
    try { round = (await commit()).value; }
    catch (err) {
      await rollbackTxn(dataDir, txn).catch(() => undefined);
      return { ok: false, code: "reopen_failed", error: `重开没提交，原片已挪回：${err instanceof Error ? err.message : String(err)}` };
    }
    await dropTxn(dataDir, txn.id);
    return { ok: true, round, moved: [...moved.values()] };
  });
}
