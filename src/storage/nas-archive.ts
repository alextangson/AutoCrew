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
import { productionServiceDir, readProductionDoc } from "./production-store.js";
import { writeJsonAtomic } from "./json-atomic.js";
import { KEEP_PUBLISHED } from "./my-content-plan.js";
import { writeErrorSection } from "./my-content-errors.js";
import { VIEW_DIR } from "./my-content-view.js";
import { withFileOwnership } from "./file-ownership.js";
import { copyProject, sha256File as nasSha, walkProject, type ArchivedFile, type CopyImpl } from "./nas-archive-copy.js";
import { appendArchiveLog, formatBytes } from "./nas-archive-log.js";

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

/**
 * 发布满 7 天、不在最近 KEEP_PUBLISHED 条已发布里的稿件（「已归档」「还在动」另行判断）。
 * 本体 §7：排除条件从「活认领」改成「本条有未完成的文件归属事务，或 30 分钟内有 record」（见 busyInProduction）。
 */
export function archiveCandidates(contents: Content[], now: Date): Content[] {
  const published = contents.filter((c) => c.status === "published")
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return published.slice(KEEP_PUBLISHED).filter((c) => {
    const at = c.publishedAt ? Date.parse(c.publishedAt) : NaN;
    return !Number.isNaN(at) && now.getTime() - at >= ARCHIVE_MIN_AGE_MS;
  });
}

export const RECENT_RECORD_MS = 30 * 60_000;

/** 这条还在动：有未完成的文件归属事务日志，或 30 分钟内有 agent record 的事实 */
export async function busyInProduction(contentId: string, dataDir: string, now: Date): Promise<string | null> {
  const dir = productionServiceDir(dataDir, "txns");
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const txn = JSON.parse(await fs.readFile(path.join(dir, name), "utf8").catch(() => "{}")) as { content_id?: string };
    if (txn.content_id === contentId) return "有没完成的文件事务";
  }
  const doc = await readProductionDoc(contentId, dataDir).catch(() => null);
  const recent = doc?.facts.some((f) => f.source === "record" && now.getTime() - Date.parse(f.at) < RECENT_RECORD_MS);
  return recent ? "30 分钟内有新报的产物" : null;
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

async function isReachable(dir: string): Promise<boolean> {
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

/**
 * 只删逐文件核对过、且此刻字节仍是核对时那份的文件（本体 §7，E36）；核对之后新出现 / 被改过的文件留着，
 * 下一轮归档再带走。删完清掉空目录，素材目录本身保留。
 */
async function deleteMedia(projectRoot: string, files: ArchivedFile[]): Promise<number> {
  let kept = 0;
  const verified = new Map(files.filter((f) => isMedia(f.rel)).map((f) => [f.rel, f]));
  const { files: now } = await walkProject(projectRoot);
  for (const f of now.filter((x) => isMedia(x.rel))) {
    const v = verified.get(f.rel);
    if (v && v.size === f.size && (await nasSha(path.join(projectRoot, f.rel)).catch(() => null)) === v.sha256) await fs.rm(path.join(projectRoot, f.rel), { force: true });
    else kept++;
  }
  for (const d of MEDIA_DIRS) await pruneEmpty(path.join(projectRoot, d), true);
  return kept;
}

async function pruneEmpty(dir: string, keepSelf: boolean): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) { if (keepSelf) await fs.mkdir(dir, { recursive: true }); return; }
  for (const e of entries) if (e.isDirectory()) await pruneEmpty(path.join(dir, e.name), false);
  if (!keepSelf && (await fs.readdir(dir)).length === 0) await fs.rmdir(dir).catch(() => undefined);
}

async function archiveOne(c: Content, archiveRoot: string, ctx: Ctx): Promise<ArchivedItem> {
  const projectRoot = resolveContentProject(c.id, ctx.data)!.project_root;
  const target = archiveTarget(archiveRoot, c, projectRoot);
  const { files: listed } = await walkProject(projectRoot);
  const size = listed.reduce((n, f) => n + f.size, 0), free = await ctx.free(archiveRoot);
  if (free < size + ctx.margin) {
    throw new Error(`NAS 空间不够（要 ${formatBytes(size)} + 预留 ${formatBytes(ctx.margin)}，剩 ${formatBytes(free)}），这次跳过`);
  }
  const { files, errors } = await copyProject(projectRoot, target, ctx.copy, MEDIA_DIRS);
  if (errors.length) throw new Error(`复制或核对出错，本机一个文件都没删，下次重试：${errors.join("；")}`);
  await writeRecord(projectRoot, target, files, ctx.now);
  const kept = await deleteMedia(projectRoot, files);
  const freedBytes = files.filter((f) => isMedia(f.rel)).reduce((n, f) => n + f.size, 0);
  if (kept) console.warn(`[nas-archive] ${c.title}：${kept} 个文件是核对之后才出现 / 被改过的，留在本机，下一轮再归档`);
  await appendArchiveLog(ctx.data, { contentId: c.id, title: c.title, target, freedBytes, archivedAt: ctx.now.toISOString() });
  return { title: c.title, target, freedBytes };
}

async function pendingItems(ctx: Ctx, report: ArchiveReport): Promise<Content[]> {
  const out: Content[] = [];
  for (const c of archiveCandidates(await listContents(ctx.data), ctx.now)) {
    try {
      const binding = resolveContentProject(c.id, ctx.data);
      const busy = binding ? await busyInProduction(c.id, ctx.data, ctx.now) : null;
      if (busy) { report.errors.push(`${c.title}（${c.id}）：这次不归档，${busy}`); continue; }
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
  // 与 record 落位、重开文稿同排文件归属事务（本体 §7）：归档核验到删除之间不许有新文件搬进来
  try { await withFileOwnership(() => runArchive(opts.archiveRoot ?? DEFAULT_ARCHIVE_ROOT, ctx, report)); }
  catch (e) { report.errors.push(`归档中断：${errMsg(e)}`); }
  await fs.mkdir(ctx.root, { recursive: true });
  await writeErrorSection(ctx.root, "archive", report.errors);
  return report;
}
