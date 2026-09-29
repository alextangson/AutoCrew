/**
 * A-roll 进项目用「挪」不用「复制」（P6 §13.4-F，codex 评审 #2 #3 #13）。
 *
 * - 目标 `02-aroll/<原文件名>`，保留创始人按标题起的名字；同名占用就加 ` (2)`、` (3)`……
 *   先用独占创建占住目标名（占位文件），再把原片 rename 过去覆盖占位——两个交接抢同一个名字也不会互相覆盖。
 * - **移动日志先落盘，再动文件**：原路径、目标路径、sha256、请求号、所处步骤。
 * - 同卷 rename 瞬间完成；跨卷（EXDEV）先复制、校验 sha256、再删源。删源失败不算交接失败，回执写明原件还在哪。
 * - 移动后再算一次 sha256（两次 stat 证明不了没人在写）。
 *
 * 恢复规则（有效副本在哪、残留怎么清、锁何时释放）：
 * - 复制中途中断（copying）：源还在且哈希对 → 源就是有效副本，删掉目标残片，释放锁；
 * - 校验通过后删源失败：交接照常提交，两份都在，回执说原件位置；撤回时删项目里那份、源留着；
 * - 删源之后崩溃（copied / moved）：有效副本在项目里；没提交就挪回原处，校验后才释放锁；
 * - 回滚 / 撤回时原路径被占：放回 Downloads 并加后缀；
 * - 同名后缀竞争：独占占位，输的一方拿下一个后缀；
 * - 移回时跨卷：同样复制、校验、删项目里那份。
 * 提交结果不确定（PROJECT_COMMIT_UNCERTAIN）时日志和原片锁都留着，重启后 `recoverArollMoves` 核定：
 * 已提交 → 原片留在项目；未提交 → 移回原处。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../../storage/local-store.js";
import { sha256File } from "./manifest.js";
import { pullDir, readRecord, releaseArollLock, writeRecord } from "./pull-store.js";

export type MoveStep = "planned" | "copying" | "copied" | "moved" | "committed";

export interface MoveJournal {
  request_id?: string;
  content_id: string;
  generation: number;
  source: string;
  target: string;
  sha256: string;
  step: MoveStep;
  cross_volume?: boolean;
  /** 跨卷复制后删源失败：原件还在 source */
  source_left?: boolean;
  at: string;
}

/** 文件系统动作的注入口：测试用它模拟跨卷（EXDEV）与删源失败 */
export interface MoveOps {
  rename: (from: string, to: string) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
  unlink: (file: string) => Promise<void>;
}

const realOps: MoveOps = { rename: fs.rename, copyFile: (a, b) => fs.copyFile(a, b), unlink: fs.unlink };
let ops: MoveOps = realOps;

export function setMoveOps(patch: Partial<MoveOps> | null): void {
  ops = patch ? { ...realOps, ...patch } : realOps;
}

export function journalFile(dataDir: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("sha256 不合法");
  return pullDir(dataDir, "move-journals", `${sha256}.json`);
}

export async function readJournal(dataDir: string, sha256: string): Promise<MoveJournal | null> {
  return readRecord<MoveJournal>(journalFile(dataDir, sha256));
}

async function saveJournal(dataDir: string, journal: MoveJournal): Promise<void> {
  await writeRecord(journalFile(dataDir, journal.sha256), journal);
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, () => false);
}

/** 独占占住一个不冲突的名字：`name.ext` → `name (2).ext` → … */
export async function reserveName(dir: string, fileName: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(fileName), stem = fileName.slice(0, fileName.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, n === 1 ? fileName : `${stem} (${n})${ext}`);
    try {
      await (await fs.open(candidate, "wx")).close();
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`同名文件太多，占不到名字：${fileName}`);
}

/**
 * rename；跨卷就复制 → 校验 → 删源。返回 false = 删源失败（两份都在）。
 * `beforeUnlink`（本体 record 用，E28）：删源前再核一次源身份，抛错即中止——目标副本由调用方清掉，原件不动。
 */
export async function relocate(from: string, to: string, sha256: string, onCopy: () => Promise<void>, beforeUnlink?: () => Promise<void>): Promise<boolean> {
  try {
    await ops.rename(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  await onCopy();
  await ops.copyFile(from, to);
  if (await sha256File(to) !== sha256) throw new Error(`复制后校验不一致：${to}`);
  if (beforeUnlink) await beforeUnlink();
  try {
    await ops.unlink(from);
    return true;
  } catch {
    return false;
  }
}

/** 交接提交里的挪入：先落日志（planned）再动文件；返回写好步骤的日志 */
export async function moveArollIn(dataDir: string, plan: Omit<MoveJournal, "target" | "step" | "at">, targetDir: string): Promise<MoveJournal> {
  const target = await reserveName(targetDir, path.basename(plan.source));
  const journal: MoveJournal = { ...plan, target, step: "planned", at: new Date().toISOString() };
  await saveJournal(dataDir, journal);
  const deleted = await relocate(plan.source, target, plan.sha256, async () => {
    journal.cross_volume = true;
    journal.step = "copying";
    await saveJournal(dataDir, journal);
  });
  journal.step = "moved";
  if (!deleted) journal.source_left = true;
  await saveJournal(dataDir, journal);
  if (await sha256File(target) !== plan.sha256) throw new Error("原片在挪动过程中被改动过（挪后校验不一致）");
  return journal;
}

export async function markCommitted(dataDir: string, journal: MoveJournal): Promise<void> {
  await saveJournal(dataDir, { ...journal, step: "committed" });
}

async function hashIs(file: string, sha256: string): Promise<boolean> {
  return (await exists(file)) && (await sha256File(file)) === sha256;
}

/**
 * 按日志把原片放回：原路径空着就回原路径，被占就回 Downloads 加后缀；校验通过才删日志、释放原片锁。
 * 返回有效副本最后所在的位置。
 */
export async function moveArollBack(dataDir: string, journal: MoveJournal, downloadsDir: string): Promise<string> {
  if (await hashIs(journal.source, journal.sha256)) {
    // 源还在（复制中断 / 删源失败）：源就是有效副本，项目里那份是残片或多余副本
    if (await exists(journal.target)) await ops.unlink(journal.target);
    return finish(dataDir, journal, journal.source);
  }
  if (!(await hashIs(journal.target, journal.sha256))) {
    // 两处都没有完好的原片：不释放锁、不删日志，留给人看
    throw new Error(`找不到完好的原片：原路径 ${journal.source}、项目 ${journal.target} 都对不上 sha256`);
  }
  const free = !(await exists(journal.source));
  const dest = free ? await reserveName(path.dirname(journal.source), path.basename(journal.source)) : await reserveName(downloadsDir, path.basename(journal.source));
  const deleted = await relocate(journal.target, dest, journal.sha256, async () => undefined);
  if (!(await hashIs(dest, journal.sha256))) throw new Error(`移回后校验不一致：${dest}`);
  if (!deleted) await ops.unlink(journal.target).catch(() => undefined);
  return finish(dataDir, journal, dest);
}

async function finish(dataDir: string, journal: MoveJournal, where: string): Promise<string> {
  await releaseArollLock(dataDir, journal.sha256, journal.content_id);
  await fs.rm(journalFile(dataDir, journal.sha256), { force: true });
  return where;
}

/** 某个原路径的原片已经被哪次交接挪走了（原路径空了，只能按日志认） */
export async function journalBySource(dataDir: string, source: string): Promise<MoveJournal | null> {
  const dir = pullDir(dataDir, "move-journals");
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const journal = /^[a-f0-9]{64}\.json$/.test(name) ? await readRecord<MoveJournal>(path.join(dir, name)) : null;
    if (journal?.source === source) return journal;
  }
  return null;
}

/** 这条日志对应的交接是否已提交且仍有效 */
async function isLive(journal: MoveJournal, dataDir: string): Promise<boolean> {
  const c = await getContent(journal.content_id, dataDir);
  const h = c?.video?.handoff;
  return Boolean(h && h.generation === journal.generation && h.aroll_sha256 === journal.sha256 && !(c!.video!.revoked ?? []).includes(h.hash));
}

/** 启动时核定：已提交 → 标 committed；未提交或已撤回 → 移回并释放锁。单条失败不挡其余 */
export async function recoverArollMoves(dataDir: string, downloadsDir: string): Promise<Array<{ sha256: string; outcome: string }>> {
  const dir = pullDir(dataDir, "move-journals");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Array<{ sha256: string; outcome: string }> = [];
  for (const name of names.filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
    const journal = await readRecord<MoveJournal>(path.join(dir, name));
    if (!journal) continue;
    try {
      if (await isLive(journal, dataDir)) {
        if (journal.step !== "committed") await markCommitted(dataDir, journal);
        out.push({ sha256: journal.sha256, outcome: "committed" });
      } else {
        out.push({ sha256: journal.sha256, outcome: `returned:${await moveArollBack(dataDir, journal, downloadsDir)}` });
      }
    } catch (err) {
      out.push({ sha256: journal.sha256, outcome: `failed:${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}
