/**
 * NAS 归档（storage-layout.md「NAS 归档（2026-09-27）」）：发布满 7 天、不在「已发布」最近 5 条里的稿件，
 * 整个项目复制到 NAS 并逐文件核对后，才删本机的素材目录。先写归档记录和路径重定位，再删；中途失败下次续跑。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Content } from "./local-store.js";
import { listContents } from "./local-store.js";
import { readLibraryLocation, getLibraryRoot } from "./storage-roots.js";
import { readProjectRegistry, resolveContentProject, isMissing } from "./content-project.js";
import { activeClaim } from "./claims.js";
import { writeJsonAtomic } from "./json-atomic.js";
import { KEEP_PUBLISHED } from "./my-content-plan.js";
import { writeErrorSection } from "./my-content-errors.js";
import { VIEW_DIR } from "./my-content-view.js";
import { copyProject, walkProject, type ArchivedFile, type CopyImpl } from "./nas-archive-copy.js";
import { appendArchiveLog, formatBytes } from "./nas-archive-log.js";
import { latestBackupFiles } from "./nas-backup-state.js";
import { KEPT_DIR } from "./nas-kept.js";

export const DEFAULT_ARCHIVE_ROOT = "/Volumes/MacMiniData/01_Lawrence/Account";
export const MEDIA_DIRS = ["02-aroll", "03-broll", "04-edit", "05-audio", "05-cover", "07-delivery"] as const;
export const ARCHIVE_MIN_AGE_MS = 7 * 24 * 60 * 60_000;
export const ARCHIVE_MARGIN_BYTES = 1024 ** 3;
const RELOCATIONS = "00-project/autocrew/relocations.json";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface ArchiveOptions {
  archiveRoot?: string;
  now?: Date;
  copyImpl?: CopyImpl;
  /** 目标卷剩余字节；测试注入 */
  freeSpace?: (dir: string) => Promise<number>;
  marginBytes?: number;
}
export interface ArchivedItem { title: string; target: string; freedBytes: number }
export interface ArchiveReport { skipped?: string; archived: ArchivedItem[]; pending: number; errors: string[] }
interface Ctx { data: string; root: string; now: Date; copy: CopyImpl; free: (dir: string) => Promise<number>; margin: number }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function volumeFree(dir: string): Promise<number> {
  const s = await fs.statfs(dir);
  return s.bavail * s.bsize;
}

/** 发布满 7 天、不在最近 KEEP_PUBLISHED 条已发布里、没有活认领的稿件（「已归档」另行判断） */
export function archiveCandidates(contents: Content[], now: Date): Content[] {
  const published = contents.filter((c) => c.status === "published")
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return published.slice(KEEP_PUBLISHED).filter((c) => {
    const at = c.publishedAt ? Date.parse(c.publishedAt) : NaN;
    return !Number.isNaN(at) && now.getTime() - at >= ARCHIVE_MIN_AGE_MS && !activeClaim(c, now.getTime());
  });
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try { return (await fs.readdir(dir)).length === 0; } catch (e) { if (isMissing(e)) return true; throw e; }
}

/** 已归档 = 有归档记录，且素材目录都空了（有记录但没删干净 = 上次删到一半，要续跑） */
export async function isArchived(projectRoot: string): Promise<boolean> {
  let notes: string[] = [];
  try { notes = await fs.readdir(path.join(projectRoot, "00-project/notes")); } catch (e) { if (!isMissing(e)) throw e; }
  if (!notes.some((n) => /^archive-.+\.json$/.test(n))) return false;
  for (const d of MEDIA_DIRS) if (!(await isEmptyDir(path.join(projectRoot, d)))) return false;
  return true;
}

export function archiveTarget(archiveRoot: string, c: Content, projectRoot: string): string {
  const at = new Date(c.publishedAt!);
  return path.join(archiveRoot, String(at.getFullYear()), MONTHS[at.getMonth()], path.basename(projectRoot));
}

export async function isReachable(dir: string): Promise<boolean> {
  try { return (await fs.stat(dir)).isDirectory(); } catch { return false; }
}

const isMedia = (rel: string) => MEDIA_DIRS.some((d) => rel.startsWith(`${d}/`));

/** 归档记录 + 重定位，必须在删任何东西之前落盘 */
async function writeRecord(projectRoot: string, target: string, files: ArchivedFile[], now: Date): Promise<void> {
  const deleted = files.filter((f) => isMedia(f.rel));
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  await fs.mkdir(path.join(projectRoot, "00-project/notes"), { recursive: true });
  await writeJsonAtomic(path.join(projectRoot, `00-project/notes/archive-${stamp}.json`), {
    version: 1, archivedAt: now.toISOString(), target, deletedDirs: [...MEDIA_DIRS], files,
  });
  const relFile = path.join(projectRoot, RELOCATIONS);
  let relocations: Record<string, string> = {};
  try { relocations = JSON.parse(await fs.readFile(relFile, "utf8")); } catch (e) { if (!isMissing(e)) throw e; }
  for (const f of deleted) relocations[`@project/${f.rel}`] = path.join(target, f.rel);
  await fs.mkdir(path.dirname(relFile), { recursive: true });
  await writeJsonAtomic(relFile, relocations);
}

/** 封面（05-cover 下的图）和登记字幕：删本机素材前留一份小副本 */
async function keepSmallFiles(projectRoot: string, c: Content, files: ArchivedFile[]): Promise<void> {
  const srt = c.video?.final?.srt_path ? path.relative(projectRoot, c.video.final.srt_path).split(path.sep).join("/") : null;
  const keep = files.filter((f) => /^05-cover\/.+\.(png|jpe?g|webp)$/i.test(f.rel) || f.rel === srt);
  for (const f of keep) {
    const dest = path.join(projectRoot, KEPT_DIR, f.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(projectRoot, f.rel), dest);
  }
}

async function deleteMedia(projectRoot: string): Promise<void> {
  for (const d of MEDIA_DIRS) {
    const dir = path.join(projectRoot, d);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
  }
}

async function archiveOne(c: Content, archiveRoot: string, ctx: Ctx): Promise<ArchivedItem> {
  const projectRoot = resolveContentProject(c.id, ctx.data)!.project_root;
  const target = archiveTarget(archiveRoot, c, projectRoot);
  const { files: listed } = await walkProject(projectRoot);
  const size = listed.reduce((n, f) => n + f.size, 0), free = await ctx.free(archiveRoot);
  if (free < size + ctx.margin) {
    throw new Error(`NAS 空间不够（要 ${formatBytes(size)} + 预留 ${formatBytes(ctx.margin)}，剩 ${formatBytes(free)}），这次跳过`);
  }
  // 逐文件核对 NAS（发布时已备份的，这里只是核对；缺或不一致先补拷），全部对上才删本机
  const previous = await latestBackupFiles(projectRoot);
  const { files, errors } = await copyProject(projectRoot, target, ctx.copy, MEDIA_DIRS, { previous });
  if (errors.length) throw new Error(`复制或核对出错，本机一个文件都没删，下次重试：${errors.join("；")}`);
  await keepSmallFiles(projectRoot, c, files);
  await writeRecord(projectRoot, target, files, ctx.now);
  await deleteMedia(projectRoot);
  const freedBytes = files.filter((f) => isMedia(f.rel)).reduce((n, f) => n + f.size, 0);
  await appendArchiveLog(ctx.data, { contentId: c.id, title: c.title, target, freedBytes, archivedAt: ctx.now.toISOString() });
  return { title: c.title, target, freedBytes };
}

async function pendingItems(ctx: Ctx, report: ArchiveReport): Promise<Content[]> {
  const out: Content[] = [];
  for (const c of archiveCandidates(await listContents(ctx.data), ctx.now)) {
    try {
      const binding = resolveContentProject(c.id, ctx.data);
      if (binding && !(await isArchived(binding.project_root))) out.push(c);
    } catch (e) { report.errors.push(`${c.title}（${c.id}）：${errMsg(e)}`); }
  }
  return out;
}

async function runArchive(archiveRoot: string, ctx: Ctx, report: ArchiveReport): Promise<void> {
  const items = await pendingItems(ctx, report);
  if (!items.length) return;
  if (!(await isReachable(archiveRoot))) {
    report.pending = items.length;
    report.errors.push(`NAS 未连接，有 ${items.length} 条待归档（${archiveRoot}）`);
    return;
  }
  for (const c of items) {
    try { report.archived.push(await archiveOne(c, archiveRoot, ctx)); }
    catch (e) { report.pending++; report.errors.push(`${c.title}（${c.id}）：${errMsg(e)}`); }
  }
}

export async function archivePublished(dataDir?: string, opts: ArchiveOptions = {}): Promise<ArchiveReport> {
  const report: ArchiveReport = { archived: [], pending: 0, errors: [] };
  if (!readLibraryLocation()) return { ...report, skipped: "没有配置资料库（旧版 ~/.autocrew），不做 NAS 归档" };
  const libRoot = getLibraryRoot();
  const data = dataDir ?? path.join(libRoot, "workspaces", "default");
  if (!readProjectRegistry(data)) return { ...report, skipped: "工作区还没有项目目录结构，不做 NAS 归档" };
  const ctx: Ctx = {
    data, root: path.join(libRoot, VIEW_DIR), now: opts.now ?? new Date(), copy: opts.copyImpl ?? ((s, d) => fs.copyFile(s, d)),
    free: opts.freeSpace ?? volumeFree, margin: opts.marginBytes ?? ARCHIVE_MARGIN_BYTES,
  };
  try { await runArchive(opts.archiveRoot ?? DEFAULT_ARCHIVE_ROOT, ctx, report); }
  catch (e) { report.errors.push(`归档中断：${errMsg(e)}`); }
  await fs.mkdir(ctx.root, { recursive: true });
  await writeErrorSection(ctx.root, "archive", report.errors);
  return report;
}
