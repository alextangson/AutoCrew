/**
 * 文件归属事务日志（spec §7）：所有搬运、克隆先落日志再动文件；提交点 = production.json 里记下事务 id。
 *
 * 沿用 aroll-move.ts 的做法（先日志后动文件、同卷 rename、跨卷复制→核哈希→删源），但以事务 id 判提交，
 * 不以 handoff 判：旧恢复器 `recoverArollMoves` 会把没有交接的新搬运当未提交撤回（Codex P1-6），
 * 所以本体的日志放在自己的目录（`production/txns/`），旧恢复器看不到。
 *
 * 恢复：已提交 → 删日志；未提交 → 按步骤倒着撤（挪的挪回原处、克隆的删掉项目里那份）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { productionServiceDir, readProductionDoc } from "../../storage/production-store.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { relocate } from "../video/handoff/aroll-move.js";
import { sha256File } from "../video/handoff/manifest.js";

export type OpStep = "planned" | "copying" | "placed";

export interface TxnOp {
  /** replace：克隆到一个已有文件的位置（登记拷封面），原文件先挪到 backup；撤回时放回 */
  op: "move" | "clone" | "replace";
  backup?: string;
  source: string;
  target: string;
  sha256: string;
  step: OpStep;
  /** 跨卷复制后删源失败：原件还在 source */
  source_left?: boolean;
}

export interface Txn {
  id: string;
  kind: "record" | "reopen" | "register";
  content_id: string;
  round: number;
  ops: TxnOp[];
  at: string;
  /** 改挂（归属转移）：接收方提交成功之后才释放原稿；提交点之前崩了 = 原稿照旧独占 */
  release?: ReleaseOp;
}

export interface ReleaseOp { owner: string; sha256: string; to: string }

function txnFile(dataDir: string, id: string): string {
  if (!/^txn-[a-z0-9-]+$/.test(id)) throw new Error(`事务 id 不合法：${id}`);
  return productionServiceDir(dataDir, "txns", `${id}.json`);
}

export async function saveTxn(dataDir: string, txn: Txn): Promise<void> {
  await writeJsonAtomicMkdir(txnFile(dataDir, txn.id), txn);
}

export async function dropTxn(dataDir: string, id: string): Promise<void> {
  await fs.rm(txnFile(dataDir, id), { force: true });
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, () => false);
}

async function hashIs(file: string, sha256: string): Promise<boolean> {
  return (await exists(file)) && (await sha256File(file)) === sha256;
}

/** 挪：先把步骤落盘，再动文件；`beforeUnlink` 在跨卷删源前再核源身份（E28） */
export async function runMove(dataDir: string, txn: Txn, op: TxnOp, beforeUnlink: () => Promise<void>): Promise<void> {
  try {
    const deleted = await relocate(op.source, op.target, op.sha256, async () => {
      op.step = "copying";
      await saveTxn(dataDir, txn);
    }, beforeUnlink);
    if (!deleted) op.source_left = true;
  } catch (err) {
    if (await exists(op.source)) await fs.rm(op.target, { force: true });
    throw err;
  }
  op.step = "placed";
  await saveTxn(dataDir, txn);
  if (!(await hashIs(op.target, op.sha256))) throw new Error("原片在挪动过程中被改动过（挪后校验不一致）");
}

/** 目标还是这次事务放下的东西：不存在、是 0 字节占位（还没落位）、或字节就是事务记的那份 */
async function targetIsOurs(op: TxnOp): Promise<"absent" | "placeholder" | "ours" | "changed"> {
  const st = await fs.lstat(op.target).catch(() => null);
  if (!st) return "absent";
  if (st.isFile() && st.size === 0 && op.step === "planned") return "placeholder";
  return (await hashIs(op.target, op.sha256)) ? "ours" : "changed";
}

/**
 * 撤一步（只对确定未提交的事务）：先核目标仍是本事务放下的那份——被人改过就停下报冲突，绝不删唯一的新版本（Codex 审 P1）。
 * 源还完好 → 删项目里那份；源没了 → 把项目里那份挪回原处（原处被占就加后缀）。
 */
async function undoOp(op: TxnOp): Promise<void> {
  if (op.op === "replace") return undoReplace(op);
  const target = await targetIsOurs(op);
  if (target === "changed") throw new Error(`恢复冲突：${op.target} 在崩溃后被改过，不删不挪，请人工核对（原片记录 sha ${op.sha256.slice(0, 12)}）`);
  if (target === "absent") return;
  if (target === "placeholder" || op.op === "clone" || (op.source !== op.target && await hashIs(op.source, op.sha256))) {
    await fs.rm(op.target, { force: true });
    return;
  }
  let dest = op.source;
  for (let n = 2; await exists(dest); n++) {
    const ext = path.extname(op.source);
    dest = `${op.source.slice(0, op.source.length - ext.length)} (${n})${ext}`;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await relocate(op.target, dest, op.sha256, async () => undefined);
}

/** 撤回 replace：目标是我们放的就删掉，再把备份挪回；目标被人改过就停 */
async function undoReplace(op: TxnOp): Promise<void> {
  const target = await targetIsOurs(op);
  if (target === "changed") throw new Error(`恢复冲突：${op.target} 在崩溃后被改过，不删不换，请人工核对`);
  if (target !== "absent") await fs.rm(op.target, { force: true });
  if (op.backup && (await exists(op.backup))) await fs.rename(op.backup, op.target);
}

/** 提交后清掉 replace 留下的备份 */
export async function dropBackups(txn: Txn): Promise<void> {
  for (const op of txn.ops) if (op.backup) await fs.rm(op.backup, { force: true }).catch(() => undefined);
}

export async function rollbackTxn(dataDir: string, txn: Txn): Promise<void> {
  for (const op of [...txn.ops].reverse()) await undoOp(op);
  await dropTxn(dataDir, txn.id);
}

/** 提交点核定：production.json 里记了这个事务 id = 已提交；读不了 = 不确定（null） */
export async function isCommitted(dataDir: string, contentId: string, txnId: string): Promise<boolean | null> {
  try { return Boolean((await readProductionDoc(contentId, dataDir))?.txns?.includes(txnId)); } catch { return null; }
}

export interface RecoveryOutcome { id: string; content_id: string; outcome: "committed" | "rolled_back" | `failed:${string}` }

/** 启动时（开放写入前）核定：按 production.json 里有没有这个事务 id 判提交。单条失败不挡其余 */
export async function recoverTxns(dataDir: string): Promise<RecoveryOutcome[]> {
  const dir = productionServiceDir(dataDir, "txns");
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^txn-[a-z0-9-]+\.json$/.test(n));
  const out: RecoveryOutcome[] = [];
  for (const name of names) {
    let txn: Txn | null = null;
    try {
      txn = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Txn;
      const doc = await readProductionDoc(txn.content_id, dataDir);
      if (doc?.txns?.includes(txn.id)) {
        if (txn.release) await (await import("./release.js")).applyRelease(dataDir, txn.release);
        await dropBackups(txn);
        await dropTxn(dataDir, txn.id);
        out.push({ id: txn.id, content_id: txn.content_id, outcome: "committed" });
      } else {
        await rollbackTxn(dataDir, txn);
        out.push({ id: txn.id, content_id: txn.content_id, outcome: "rolled_back" });
      }
    } catch (err) {
      out.push({ id: txn?.id ?? name, content_id: txn?.content_id ?? "", outcome: `failed:${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}
