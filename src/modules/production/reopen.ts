/**
 * 「重开文稿」（spec §2.5，§13-D）：唯一的解冻方式，只由创始人在浏览器会话里点。
 *
 * 原子地结束当前 round：本轮事实、批准、登记转入历史（不删文件，本轮原片挪进 `02-aroll/_作废-<round>/`，
 * 被 ChatCut 工程引用的原片不挪）；round+1；解冻；认稿失效，稿子回写稿中；阶段回推导。
 * 挪原片走文件归属事务日志，中途崩了启动时按事务 id 恢复。
 */
import path from "node:path";
import { contentRoot } from "../../storage/content-project.js";
import { isOntologyActive, newId, readProductionDoc, readProductionDocOrEmpty } from "../../storage/production-store.js";
import { checkTargetDir } from "./record-plan.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { reserveTarget } from "./files.js";
import { withFileOwnership } from "./mutex.js";
import { ensureProductionReady, mutateProduction } from "./service.js";
import { dropTxn, rollbackTxn, runMove, saveTxn, type Txn } from "./txn.js";

export interface ReopenResult { ok: boolean; round?: number; moved?: string[]; error?: string; code?: string; warning?: string }

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
    const safe = await checkTargetDir(root, `02-aroll/_作废-${doc.round}`);
    if (!safe.ok) throw new Error(safe.error);
    const target = await reserveTarget(path.join(root, "02-aroll", `_作废-${doc.round}`), path.basename(source, ext), ext);
    const op = { op: "move" as const, source, target, sha256: fact.sha256!, step: "planned" as const };
    txn.ops.push(op);
    await saveTxn(dataDir, txn);
    await runMove(dataDir, txn, op, async () => undefined);
    moved.set(fact.id, path.relative(root, target));
  }
  return moved;
}

/**
 * 重开写 production.json（提交点）之后，投影 / 时间线 / 索引还会写；那几步失败不能撤回已提交的重开（Codex 审 P1）。
 * 按提交点核定：已提交 → 只报派生写入失败；确定未提交 → 撤回挪动；读不了 → 留日志，重启时核定。
 */
async function commitFailed(contentId: string, dataDir: string, txn: Txn, round: number, moved: Map<string, string>, err: unknown): Promise<ReopenResult> {
  const msg = err instanceof Error ? err.message : String(err);
  const doc = await readProductionDoc(contentId, dataDir).catch(() => undefined);
  const committed = doc === undefined ? null : Boolean(doc && doc.round > round);
  if (committed) {
    await dropTxn(dataDir, txn.id);
    return { ok: true, round: doc!.round, moved: [...moved.values()], warning: `重开已提交，但之后的派生写入失败：${msg}` };
  }
  if (committed === false) {
    const undone = await rollbackTxn(dataDir, txn).then(() => true, () => false);
    return { ok: false, code: "reopen_failed", error: undone ? `重开没提交，原片已挪回：${msg}` : `重开没提交，原片也没能自动挪回（日志留着，重启时核定）：${msg}` };
  }
  return { ok: false, code: "reopen_uncertain", error: `重开结果不确定（读不了制作记录），事务日志留着，重启时核定：${msg}` };
}

/**
 * `expectedRound` = 创始人在面板上看到的那一轮（Codex 审 seg3 P2）：锁内核对，别处已经重开过就不再结束新的一轮；
 * 同一轮的重复确认幂等，返回已经开始的新轮。
 */
export async function reopenScript(contentId: string, dataDir: string, note?: string, expectedRound?: number): Promise<ReopenResult> {
  await ensureProductionReady(dataDir);
  if (!(await isOntologyActive(dataDir, contentId))) return { ok: false, code: "ontology_not_enabled", error: "本体还没启用（或这条被排除），没有可重开的制作轮次" };
  return withFileOwnership(async () => {
    const doc = await readProductionDocOrEmpty(contentId, dataDir);
    if (expectedRound !== undefined && doc.round !== expectedRound) {
      const already = doc.decisions.some((d) => d.type === "reopen" && d.round === expectedRound);
      return already
        ? { ok: true, round: doc.round, moved: [], warning: `第 ${expectedRound} 轮已经重开过，现在是第 ${doc.round} 轮，这次没有再结束新的一轮` }
        : { ok: false, code: "stale", error: "这条的轮次和你看到的不一样，刷新后再看" };
    }
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
      d.round_started_at = new Date().toISOString();
      d.frozen = null;
      d.commit_failure = null;
      if (txn.ops.length) d.txns = [...(d.txns ?? []), txn.id];
      return { value: ended + 1, events: [{ type: "script_reopened", detail: { ended_round: ended, retired: [...moved.values()] } }] };
    });
    let round: number;
    try { round = (await commit()).value; }
    catch (err) { return commitFailed(contentId, dataDir, txn, doc.round, moved, err); }
    await dropTxn(dataDir, txn.id);
    return { ok: true, round, moved: [...moved.values()] };
  });
}
