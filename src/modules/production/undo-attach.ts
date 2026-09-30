/**
 * 撤销自动挂上（1b §4.1）与当前轮改挂（§7）——原 spec §2.5「只有重开文稿能解冻」的**受限例外**（§14-10），只为撤销系统自己做错的挂载。
 *
 * 前提（锁内核）：模拟移除这条事实后重新推导必须回到「待录制」（或仍在写稿段）；本轮没有任何批准、登记、发布观察、
 * 「我发了」依赖它；没被 `chatcut_project.uses_aroll` 引用。
 *
 * 撤销 = 一个持久事务（§14-11）：文件挪回 source_path 所在目录（逐段 lstat 拒链接、核目录身份 dev/ino 前后一致；
 * 目录没了 → 挪回收件箱）；目标名排他占位（原名被占 → `-2`），不覆盖任何文件；决定 + 事实转 rejected + 清 doc.frozen
 * 与事务 id 同一次写入（提交点）。中途失败按事务日志撤回；撤不回就保留日志、报文件实际所在路径。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot } from "../../storage/content-project.js";
import type { Content } from "../../storage/local-store.js";
import { newId } from "../../storage/production-store.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { deriveExplanation } from "./explain.js";
import { identityOf, reserveTarget, sameIdentity, stableFingerprint } from "./files.js";
import { movableRoots, now } from "./roots.js";
import { chatcutHold } from "./chatcut-refs.js";
import { mutateProduction } from "./service.js";
import { dropTxn, isCommitted, rollbackTxn, runMove, saveTxn, type Txn } from "./txn.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string): Result => ({ ok: false, code, error });

export const IN_EDIT = "这条已经在剪了，要换原片请重开文稿";
export const IN_EDIT_REASSIGN = "这条已经在剪了，要改挂请先重开文稿";
export const CHANGED = "项目里的原片在挂上之后被改过，不能自动撤销；要换原片请重开文稿";
export const CHATCUT_USES = "ChatCut 工程在用这个原片，先在 ChatCut 里换掉";

const DEPENDENT: ReadonlySet<string> = new Set(["cut_approval", "cover_approval", "i_published", "publish_confirm"]);

/** 能不能把这条原片从这条稿上撤下来（撤销 / 改挂共用）；null = 可以 */
export function undoBlocker(content: Content, doc: ProductionDoc, fact: Fact): string | null {
  if (fact.kind !== "aroll" || fact.state !== "accepted" || fact.round !== doc.round) return "这条原片已经不在本轮了，刷新再看";
  if (doc.facts.some((f) => f.round === doc.round && f.kind === "chatcut_project" && f.uses_aroll?.includes(fact.id))) return CHATCUT_USES;
  const round = <T extends { round: number }>(xs: T[]): T[] => xs.filter((x) => x.round === doc.round);
  if (round(doc.decisions).some((d) => DEPENDENT.has(d.type)) || round(doc.registrations).length || round(doc.facts).some((f) => f.kind === "publish")) return IN_EDIT;
  const sim = structuredClone(doc);
  sim.facts.find((f) => f.id === fact.id)!.state = "rejected";
  const exp = deriveExplanation({ content, doc: sim, enabled: true, publish: { verified: false } });
  return exp.phase === "writing" || exp.stage === "待录制" ? null : IN_EDIT;
}

/** 挪回的目录：source_path 所在目录，逐段不能是符号链接；不在了回收件箱 */
async function homeDir(fact: Fact, dataDir: string): Promise<{ dir: string; fallback: boolean } | string> {
  const dir = fact.source_path ? path.dirname(fact.source_path) : null;
  if (dir) {
    let ok = true;
    const parts = dir.split(path.sep);
    for (let i = 2; i <= parts.length && ok; i++) {
      const st = await fs.lstat(parts.slice(0, i).join(path.sep)).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isDirectory()) ok = false;
    }
    if (ok) return { dir, fallback: false };
  }
  const inbox = (await movableRoots(dataDir)).inbox;
  return inbox ? { dir: inbox, fallback: true } : "原来的文件夹不在了，收件箱也找不到，没挪";
}

async function reserveHome(fact: Fact, dataDir: string): Promise<{ target: string; fallback: boolean } | string> {
  const home = await homeDir(fact, dataDir);
  if (typeof home === "string") return home;
  const before = await fs.stat(home.dir);
  const name = path.basename(fact.source_path ?? fact.path!);
  const ext = path.extname(name);
  const target = await reserveTarget(home.dir, path.basename(name, ext), ext);
  const after = await fs.lstat(home.dir).catch(() => null);
  // 占位前后目录身份要一致、仍不是链接：被换掉就放弃，不往陌生目录里放
  if (!after || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    await fs.rm(target, { force: true });
    return "挪回的目录在这期间被换过，没挪";
  }
  return { target, fallback: home.fallback };
}

/** 事实里的文件：原地收下的存绝对路径，挪进项目的存项目内相对路径（Codex 审 segB5 P2） */
export async function factFile(content: Content, fact: Fact, dataDir: string): Promise<string> {
  return path.isAbsolute(fact.path!) ? fact.path! : path.join(await fs.realpath(contentRoot(content.id, dataDir)), fact.path!);
}

export const chatcutInUse = (project: string) => `ChatCut 工程《${project}》在用这个原片，先在 ChatCut 里换掉再点`;

async function commitUndo(content: Content, fact: Fact, txn: Txn | null, target: string, dataDir: string): Promise<void> {
  await mutateProduction(content.id, dataDir, (doc) => {
    const f = doc.facts.find((x) => x.id === fact.id)!;
    Object.assign(f, { state: "rejected", path: target, availability: "present", evidence: txn ? `创始人说不是这条（撤销自动挂上），已挪回 ${target}` : "创始人说不是这条（撤销自动挂上）；原片本来就留在原处，没挪" });
    doc.decisions.push({ id: newId("dec"), type: "auto_attach_undo", round: doc.round, at: new Date().toISOString(), source: "founder", fact_id: f.id, sha256: f.sha256, note: target });
    doc.frozen = null; // 冻结副本文件留作历史
    if (txn) doc.txns = [...(doc.txns ?? []), txn.id];
    return { value: null, events: [{ type: "auto_attach_undone", detail: { fact_id: f.id, to: target } }] };
  });
}

/** 调用方持有文件归属锁（founderDecision） */
export async function undoAutoAttach(content: Content, doc: ProductionDoc, fact: Fact, dataDir: string): Promise<Result> {
  if (!fact.auto_attached) return fail("not_auto", "这条原片是人确认挂上的，不是系统自动挂的；要换原片请重开文稿");
  const blocked = undoBlocker(content, doc, fact);
  if (blocked) return fail("undo_blocked", blocked);
  const source = await factFile(content, fact, dataDir);
  const id = await identityOf(source).catch(() => null);
  if (!id) return fail("file_missing", `原片不见了（${fact.path}），没法撤`);
  // 本机 ChatCut 工程按路径在用（还没有 uses_aroll 事实也算，Codex 审 segB5 P1）：挪走会断它的素材链接
  const hold = await chatcutHold(source);
  if (hold.project) return fail("undo_blocked", chatcutInUse(hold.project));
  // 先核完整哈希、再占名 / 挪（Codex 审 segB3 P1）：被外部改过的字节一旦挪出去，撤回会因哈希对不上拒绝放回，文件两头都不在
  const fp = await stableFingerprint(source, now());
  if (!fp.ok || fp.value.sha256 !== fact.sha256) return fail("undo_blocked", CHANGED);
  // 原地收下的（绝对路径，当初就没挪进项目，Codex 审 segB5 P2）：不动任何文件，只记决定、拒事实、解冻
  if (path.isAbsolute(fact.path!)) {
    await commitUndo(content, fact, null, source, dataDir);
    return { ok: true, fact_id: fact.id, moved_to: null, note: `原片本来就留在原处（${source}），没挪` };
  }
  const home = await reserveHome(fact, dataDir);
  if (typeof home === "string") return fail("undo_blocked", home);
  const txn: Txn = { id: newId("txn"), kind: "undo", content_id: content.id, round: doc.round, ops: [{ op: "move", source, target: home.target, sha256: fact.sha256!, step: "planned" }], at: new Date().toISOString() };
  await saveTxn(dataDir, txn);
  try {
    await runMove(dataDir, txn, txn.ops[0], async () => { if (!sameIdentity(id, await identityOf(source))) throw new Error("原片在挪回途中变了"); });
    await commitUndo(content, fact, txn, home.target, dataDir);
  } catch (err) {
    return undoFailed(content, txn, home.target, source, dataDir, err);
  }
  await dropTxn(dataDir, txn.id);
  const renamed = path.basename(home.target) !== path.basename(fact.source_path ?? "");
  const where = home.fallback ? `原来的文件夹不在了，挪回了收件箱：${home.target}` : renamed ? `原名被占，挪回时改成了 ${path.basename(home.target)}` : `已挪回 ${home.target}`;
  return { ok: true, fact_id: fact.id, moved_to: home.target, note: where };
}

async function undoFailed(content: Content, txn: Txn, target: string, source: string, dataDir: string, err: unknown): Promise<Result> {
  const msg = err instanceof Error ? err.message : String(err);
  const committed = await isCommitted(dataDir, content.id, txn.id);
  if (committed) { await dropTxn(dataDir, txn.id); return { ok: true, moved_to: target, warning: `已撤销，但之后的派生写入失败：${msg}` }; }
  if (committed === false) {
    const undone = await rollbackTxn(dataDir, txn).then(() => true, () => false);
    return fail("undo_failed", undone ? `没撤成，原片留在项目里：${msg}` : `没撤成，也没能自动放回（事务日志留着，重启时核定）；文件现在可能在 ${target} 或 ${source}：${msg}`);
  }
  return fail("undo_uncertain", `结果不确定（读不了制作记录），事务日志留着，重启时核定；文件现在可能在 ${target} 或 ${source}：${msg}`);
}
