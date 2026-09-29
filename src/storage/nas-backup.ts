/**
 * 发布即备份 NAS（docs/specs/2026-09-29-nas-backup-on-publish.md）：已发布且 publishedAt 到点的稿件，
 * 整个项目增量复制到归档同一个目标（archiveTarget）并逐文件核对。只读不删；7 天后的归档据此只需核对再删本机。
 * NAS 未挂载 / 拷贝或核对失败都记进项目的 backup-state.json（视图渲染成 NAS备份状态.txt），下一轮自动重试。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Content } from "./local-store.js";
import { listContents } from "./local-store.js";
import { readLibraryLocation, getLibraryRoot } from "./storage-roots.js";
import { readProjectRegistry, resolveContentProject, isMissing } from "./content-project.js";
import { writeErrorSection } from "./my-content-errors.js";
import { withFileOwnership } from "./file-ownership.js";
import { withRoundPublishTime } from "./round-publish-time.js";
import { VIEW_DIR } from "./my-content-view.js";
import { copyProject, keptName, sha256File, walkProject, type ArchivedFile, type CopyImpl, type ProjectLink } from "./nas-archive-copy.js";
import { safeNasPath, assertInside } from "./nas-safe-path.js";
import { archiveTarget, isReachable, DEFAULT_ARCHIVE_ROOT } from "./nas-archive.js";
import {
  BACKUP_FAIL_LIMIT, LINKS_NOTE, NAS_META_DIR, isBackupBookkeeping, latestBackupRecord, latestBackupFiles, readBackupState, writeBackupRecord, writeBackupState,
} from "./nas-backup-state.js";

export interface BackupOptions { archiveRoot?: string; now?: Date; copyImpl?: CopyImpl }
export interface BackupReport { skipped?: string; backedUp: string[]; pending: number; errors: string[] }
interface Ctx { root: string; now: Date; copy: CopyImpl; reachable: boolean }

/** 创始人定：平时增量跳过，每条稿每 7 天完整重读核对一次 NAS */
export const FULL_VERIFY_EVERY_MS = 7 * 24 * 60 * 60_000;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 已发布且公开时间已到点（定时稿到点才算）；不受「最近 5 条」和认领限制——备份只读不删 */
export function backupCandidates(contents: Content[], now: Date): Content[] {
  return contents.filter((c) => {
    const at = c.publishedAt ? Date.parse(c.publishedAt) : NaN;
    return c.status === "published" && !Number.isNaN(at) && at <= now.getTime();
  });
}

function sameFiles(a: ArchivedFile[], prev: Map<string, ArchivedFile>): boolean {
  return a.length === prev.size && a.every((f) => {
    const p = prev.get(f.rel);
    return p?.sha256 === f.sha256 && p.destMtimeMs === f.destMtimeMs;
  });
}

/** 本机相对上次备份有没有变化（只比大小和修改时间，不读 NAS） */
async function changedSinceBackup(projectRoot: string, prev: Map<string, ArchivedFile>): Promise<boolean> {
  const files = (await walkProject(projectRoot)).files.filter((f) => !isBackupBookkeeping(f.rel));
  return files.length !== prev.size || files.some((f) => {
    const p = prev.get(f.rel);
    return !p || p.size !== f.size || p.mtimeMs !== f.mtimeMs;
  });
}

async function markUnmounted(projectRoot: string, target: string, ctx: Ctx): Promise<boolean> {
  const prev = await latestBackupFiles(projectRoot, target);
  const state = await readBackupState(projectRoot);
  if (state?.status === "backed_up" && !(await changedSinceBackup(projectRoot, prev))) return false;
  await writeBackupState(projectRoot, {
    ...(state ?? { failures: 0 }), status: "unmounted", target, lastAttempt: ctx.now.toISOString(),
    reason: `NAS 未挂载（${ctx.root}）`,
  });
  return true;
}

/**
 * 归档过的项目：本机素材已删，只有 NAS 上那份。按归档记录核对这些文件还在、大小一致（不每天重算整份哈希，
 * 与 NAS 侧增量跳过的取舍一致）；缺了或大小不对就报出来，这一轮不算备份完成。
 */
/** 只剩 NAS 上那份的文件：不经过链接读（路径上有链接直接算问题） */
async function checkNasOnly(target: string, f: ArchivedFile, full: boolean): Promise<string | null> {
  const file = path.join(target, f.rel);
  const st = await fs.lstat(file).catch(() => null);
  if (!st) return "NAS 上也不见了";
  try { await assertInside(target, f.rel); } catch (e) { return errMsg(e); }
  if (!st.isFile()) return "NAS 上那份不是普通文件";
  if (st.size !== f.size) return `NAS 上那份大小不对（记录 ${f.size}，现在 ${st.size}）`;
  if (full && (await sha256File(file)) !== f.sha256) return "NAS 上那份内容校验不一致（完整核对）";
  return null;
}

/**
 * 历史归档记录可能指向被新版本替换过的固定路径（封面等）：旧那份被 keepAside 改名留底为 `<名>.<sha8>[-n].<扩展名>`。
 * 按这条记录的版本（sha）找对应那份：原路径对得上就用它，否则找留底副本；都对不上才报问题（报原路径的问题）。
 */
async function checkNasVersion(target: string, f: ArchivedFile, full: boolean): Promise<string | null> {
  const first = await checkNasOnly(target, f, full);
  if (!first) return null;
  const base = keptName(f.rel, f.sha256), ext = path.extname(base);
  for (let i = 1; i <= 20; i++) {
    const rel = i === 1 ? base : `${base.slice(0, base.length - ext.length)}-${i}${ext}`;
    const st = await fs.lstat(path.join(target, rel)).catch(() => null);
    if (!st) break;
    if (!(await checkNasOnly(target, { ...f, rel }, full))) return null;
  }
  return first;
}

async function checkArchivedOnNas(projectRoot: string, full: boolean): Promise<string[]> {
  const notes = path.join(projectRoot, "00-project/notes");
  let names: string[] = [];
  try { names = await fs.readdir(notes); } catch (e) { if (isMissing(e)) return []; throw e; }
  const problems: string[] = [];
  for (const name of names.filter((n) => /^archive-.+\.json$/.test(n))) {
    const record = JSON.parse(await fs.readFile(path.join(notes, name), "utf8")) as { target: string; files: ArchivedFile[] };
    for (const f of record.files) {
      if (await fs.stat(path.join(projectRoot, f.rel)).then(() => true, () => false)) continue; // 本机还在，照常备份
      const problem = await checkNasVersion(record.target, f, full);
      if (problem) problems.push(`${f.rel}：本机已归档删除，${problem}`);
    }
  }
  return problems;
}

/** 链接只登记：NAS 项目根写一份清单（落点同样不经过链接） */
async function writeLinksNote(target: string, links: ProjectLink[]): Promise<void> {
  const dest = await safeNasPath(target, LINKS_NOTE);
  await fs.writeFile(dest, JSON.stringify({ note: "项目里的符号链接（NAS 上不建链接，只记指向）", links }, null, 2));
}

/** full = 每周一次的完整核对：不走增量跳过，NAS 上每个文件都重读算 sha256；不一致从本机重拷 */
async function copyOnce(projectRoot: string, target: string, ctx: Ctx, full: boolean): Promise<ArchivedFile[]> {
  const prev = await latestBackupFiles(projectRoot, target);
  if (await fs.lstat(path.join(projectRoot, NAS_META_DIR)).then(() => true, () => false)) {
    throw new Error(`项目里有 ${NAS_META_DIR}，跟 NAS 备份的保留目录重名，请改名`);
  }
  const { files, errors, links } = await copyProject(projectRoot, target, ctx.copy, [], {
    previous: prev, skipUnchanged: !full, exclude: isBackupBookkeeping, recordSymlinks: true,
  });
  errors.push(...(await checkArchivedOnNas(projectRoot, full)));
  if (errors.length) throw new Error(`复制或核对出错：${errors.join("；")}`);
  const prevLinks = (await latestBackupRecord(projectRoot))?.links ?? [];
  if (links.length || prevLinks.length) await writeLinksNote(target, links);
  if (!sameFiles(files, prev) || JSON.stringify(links) !== JSON.stringify(prevLinks)) {
    await writeBackupRecord(projectRoot, { version: 1, backedUpAt: ctx.now.toISOString(), target, files, links });
  }
  return files;
}

async function runBackup(data: string, ctx: Ctx, report: BackupReport): Promise<void> {
  const contents = await Promise.all((await listContents(data)).map((c) => withRoundPublishTime(c, data)));
  for (const c of backupCandidates(contents, ctx.now)) {
    try {
      const binding = resolveContentProject(c.id, data);
      if (!binding) throw new Error("没有项目目录");
      // 与 record 落位 / 登记 / 重开 / 归档同一把文件归属互斥（本体 §7）：拷的时候项目里的文件不会被挪动，一条一放
      await withFileOwnership(() => backupOneAt(c, binding.project_root, ctx, report));
    } catch (e) { report.errors.push(`${c.title}（${c.id}）：${errMsg(e)}`); }
  }
}

/** 备份一条：不可达记「未挂载」，成功/失败都写状态；连续失败到上限才进 ⚠️ 同步出错.txt */
async function backupOneAt(c: Content, projectRoot: string, ctx: Ctx, report: BackupReport): Promise<void> {
  const target = archiveTarget(ctx.root, c, projectRoot);
  if (!ctx.reachable) {
    if (await markUnmounted(projectRoot, target, ctx)) report.pending++;
    return;
  }
  const state = await readBackupState(projectRoot);
  const lastFull = state?.target === target ? state.lastFullVerifyAt : undefined;
  const full = !lastFull || ctx.now.getTime() - Date.parse(lastFull) >= FULL_VERIFY_EVERY_MS;
  try {
    const files = await copyOnce(projectRoot, target, ctx, full);
    await writeBackupState(projectRoot, {
      status: "backed_up", lastAttempt: ctx.now.toISOString(), failures: 0, target, backedUpAt: ctx.now.toISOString(),
      fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0),
      lastFullVerifyAt: full ? ctx.now.toISOString() : lastFull,
    });
    report.backedUp.push(c.title);
  } catch (e) {
    const failures = (state?.status === "failed" ? state.failures : 0) + 1;
    await writeBackupState(projectRoot, {
      status: "failed", lastAttempt: ctx.now.toISOString(), failures, target, reason: errMsg(e), lastFullVerifyAt: lastFull,
    });
    report.pending++;
    if (failures >= BACKUP_FAIL_LIMIT) report.errors.push(`${c.title}（${c.id}）连续 ${failures} 次备份失败：${errMsg(e)}`);
  }
}

export async function backupPublished(dataDir?: string, opts: BackupOptions = {}): Promise<BackupReport> {
  const report: BackupReport = { backedUp: [], pending: 0, errors: [] };
  if (!readLibraryLocation()) return { ...report, skipped: "没有配置资料库（旧版 ~/.autocrew），不做 NAS 备份" };
  const libRoot = getLibraryRoot();
  const data = dataDir ?? path.join(libRoot, "workspaces", "default");
  if (!readProjectRegistry(data)) return { ...report, skipped: "工作区还没有项目目录结构，不做 NAS 备份" };
  const root = opts.archiveRoot ?? DEFAULT_ARCHIVE_ROOT;
  const ctx: Ctx = { root, now: opts.now ?? new Date(), copy: opts.copyImpl ?? ((s, d) => fs.copyFile(s, d)), reachable: await isReachable(root) };
  try { await runBackup(data, ctx, report); }
  catch (e) { report.errors.push(`备份中断：${errMsg(e)}`); }
  const view = path.join(libRoot, VIEW_DIR);
  await fs.mkdir(view, { recursive: true });
  await writeErrorSection(view, "backup", report.errors);
  return report;
}
