/**
 * 「我的内容」：资料库根下给创始人看的视图，按清单对账。
 * 只删清单里且仍是原样的条目；创始人自己放的、改过的一律不删。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readLibraryLocation, getLibraryRoot } from "./storage-roots.js";
import { readProjectRegistry, isMissing } from "./content-project.js";
import { buildPlan, KEEP_PUBLISHED, type Desired, type Plan } from "./my-content-plan.js";
import { writeErrorSection, ERROR_FILE } from "./my-content-errors.js";
import { syncBackFounderEdits, isEditable } from "./my-content-sync-back.js";

export const VIEW_DIR = "我的内容";
export const VIEW_MANIFEST = ".autocrew-view.json";
export { ERROR_FILE };
const KEEP_VISIBLE = new Set([VIEW_DIR, "AutoCrew资料库说明.md"]);
const LINK_FALLBACK = new Set(["EXDEV", "ENOTSUP", "EPERM"]);

type ManifestEntry =
  | { owner: string; kind: "copy"; hash: string }
  | { owner: string; kind: "hardlink"; source: string; ino: number }
  | { owner: string; kind: "symlink"; target: string };
interface Manifest { version: 1; entries: Record<string, ManifestEntry>; dirs: Record<string, string> }

export interface SyncReport { skipped?: string; created: number; updated: number; removed: number; preservedEdits: number; errors: string[] }
export interface SyncOptions {
  keepPublished?: number;
  now?: Date;
  linkImpl?: (source: string, dest: string) => Promise<void>;
}
interface Ctx { root: string; now: Date; link: (s: string, d: string) => Promise<void>; report: SyncReport }

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pad2 = (n: number) => String(n).padStart(2, "0");

async function lstatOrNull(file: string) {
  try { return await fs.lstat(file); } catch (e) { if (isMissing(e)) return null; throw e; }
}

async function readManifest(root: string): Promise<Manifest> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(root, VIEW_MANIFEST), "utf8")) as Manifest;
    return { version: 1, entries: m.entries ?? {}, dirs: m.dirs ?? {} };
  } catch (e) {
    if (isMissing(e)) return { version: 1, entries: {}, dirs: {} };
    throw e;
  }
}

/** 写稿中 / 待录制的口播稿可写（改了会回流），其余副本只读 */
async function writeCopy(file: string, text: string, rel: string): Promise<void> {
  if (await lstatOrNull(file)) await fs.chmod(file, 0o644);
  await fs.writeFile(file, text);
  await fs.chmod(file, isEditable(rel) ? 0o644 : 0o444);
}

/** 把创始人改过/放进来的同名条目挪开：口播稿.md → 口播稿（我改过的 20260927-1430）.md */
async function displace(file: string, now: Date): Promise<void> {
  const ext = path.extname(file), base = file.slice(0, file.length - ext.length);
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  let target = `${base}（我改过的 ${stamp}）${ext}`;
  for (let i = 2; await lstatOrNull(target); i++) target = `${base}（我改过的 ${stamp}-${i}）${ext}`;
  await fs.rename(file, target);
}

async function isPristine(file: string, entry: ManifestEntry): Promise<boolean> {
  const st = await lstatOrNull(file);
  if (!st) return false;
  if (entry.kind === "copy") return st.isFile() && sha(await fs.readFile(file)) === entry.hash;
  if (entry.kind === "hardlink") return st.isFile() && !st.isSymbolicLink() && st.ino === entry.ino;
  return st.isSymbolicLink() && (await fs.readlink(file)) === entry.target;
}

/** 目标位置已有东西：原样的就换掉，不是原样的挪到一边保留 */
async function clearSlot(file: string, old: ManifestEntry | undefined, ctx: Ctx): Promise<boolean> {
  if (!(await lstatOrNull(file))) return false;
  if (old && (await isPristine(file, old))) await fs.rm(file, { force: true });
  else { await displace(file, ctx.now); ctx.report.preservedEdits++; }
  return true;
}

async function applyCopy(file: string, d: Extract<Desired, { kind: "copy" }>, old: ManifestEntry | undefined, ctx: Ctx): Promise<ManifestEntry> {
  const hash = sha(d.text), entry: ManifestEntry = { owner: d.owner, kind: "copy", hash };
  const st = await lstatOrNull(file);
  if (st && old?.kind === "copy" && st.isFile() && sha(await fs.readFile(file)) === old.hash) {
    if (old.hash === hash) return entry;
    await writeCopy(file, d.text, d.rel);
    ctx.report.updated++;
    return entry;
  }
  // 已经是目标内容（创始人的改稿刚写回稿件）：收下，恢复应有权限
  if (st?.isFile() && !st.isSymbolicLink() && sha(await fs.readFile(file)) === hash) {
    await writeCopy(file, d.text, d.rel);
    ctx.report.updated++;
    return entry;
  }
  const existed = await clearSlot(file, undefined, ctx);
  await writeCopy(file, d.text, d.rel);
  ctx.report[existed ? "updated" : "created"]++;
  return entry;
}

async function applyLink(file: string, d: Extract<Desired, { kind: "link" }>, old: ManifestEntry | undefined, ctx: Ctx): Promise<ManifestEntry> {
  const src = await fs.stat(d.source), st = await lstatOrNull(file);
  if (st && old?.kind === "hardlink" && old.source === d.source && !st.isSymbolicLink() && st.ino === src.ino) return old;
  if (st && old?.kind === "symlink" && old.target === d.source && (await isPristine(file, old))) return old;
  const existed = await clearSlot(file, old, ctx);
  ctx.report[existed ? "updated" : "created"]++;
  try {
    await ctx.link(d.source, file);
    return { owner: d.owner, kind: "hardlink", source: d.source, ino: src.ino };
  } catch (e) {
    if (!LINK_FALLBACK.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
    await fs.symlink(d.source, file);
    return { owner: d.owner, kind: "symlink", target: d.source };
  }
}

async function applySymlink(file: string, d: Extract<Desired, { kind: "symlink" }>, old: ManifestEntry | undefined, ctx: Ctx): Promise<ManifestEntry> {
  const entry: ManifestEntry = { owner: d.owner, kind: "symlink", target: d.target };
  if (await isPristine(file, entry)) return entry;
  const existed = await clearSlot(file, old, ctx);
  await fs.symlink(d.target, file);
  ctx.report[existed ? "updated" : "created"]++;
  return entry;
}

function applyEntry(d: Desired, old: ManifestEntry | undefined, ctx: Ctx): Promise<ManifestEntry> {
  const file = path.join(ctx.root, d.rel);
  if (d.kind === "copy") return applyCopy(file, d, old, ctx);
  if (d.kind === "link") return applyLink(file, d, old, ctx);
  return applySymlink(file, d, old, ctx);
}

async function applyPlan(plan: Plan, prev: Manifest, ctx: Ctx): Promise<Manifest> {
  const next: Manifest = { version: 1, entries: {}, dirs: { ...plan.dirs } };
  for (const dir of Object.keys(plan.dirs)) await fs.mkdir(path.join(ctx.root, dir), { recursive: true });
  for (const d of plan.entries) {
    try { next.entries[d.rel] = await applyEntry(d, prev.entries[d.rel], ctx); }
    catch (e) {
      plan.failed.add(d.owner);
      ctx.report.errors.push(`${d.rel}：${errMsg(e)}`);
      if (prev.entries[d.rel]) next.entries[d.rel] = prev.entries[d.rel];
    }
  }
  await removeStale(plan, prev, next, ctx);
  return next;
}

async function removeStale(plan: Plan, prev: Manifest, next: Manifest, ctx: Ctx): Promise<void> {
  for (const [rel, old] of Object.entries(prev.entries)) {
    if (next.entries[rel]) continue;
    if (plan.failed.has(old.owner)) { next.entries[rel] = old; continue; }
    const file = path.join(ctx.root, rel);
    try {
      if (!(await isPristine(file, old))) continue; // 改过或已不在：不删，交还给创始人
      await fs.rm(file, { force: true });
      ctx.report.removed++;
    } catch (e) { ctx.report.errors.push(`${rel}：${errMsg(e)}`); next.entries[rel] = old; }
  }
  const stale = Object.entries(prev.dirs).filter(([rel]) => !next.dirs[rel]).sort(([a], [b]) => b.length - a.length);
  for (const [rel, owner] of stale) {
    if (plan.failed.has(owner)) { next.dirs[rel] = owner; continue; }
    try { await fs.rmdir(path.join(ctx.root, rel)); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") next.dirs[rel] = owner; // 里面有创始人的东西：原样保留，继续跟踪
      else if (!isMissing(e)) ctx.report.errors.push(`${rel}：${errMsg(e)}`);
    }
  }
}

const execFileAsync = promisify(execFile);
async function hideLibraryEntries(libRoot: string, report: SyncReport): Promise<void> {
  if (process.platform !== "darwin") return;
  for (const name of await fs.readdir(libRoot)) {
    if (KEEP_VISIBLE.has(name)) continue;
    try { await execFileAsync("chflags", ["hidden", path.join(libRoot, name)]); }
    catch (e) { report.errors.push(`隐藏 ${name} 失败：${errMsg(e)}`); }
  }
}

export async function syncMyContentView(dataDir?: string, opts: SyncOptions = {}): Promise<SyncReport> {
  const report: SyncReport = { created: 0, updated: 0, removed: 0, preservedEdits: 0, errors: [] };
  if (!readLibraryLocation()) return { ...report, skipped: "没有配置资料库（旧版 ~/.autocrew），不生成「我的内容」" };
  const libRoot = getLibraryRoot();
  const data = dataDir ?? path.join(libRoot, "workspaces", "default");
  if (!readProjectRegistry(data)) return { ...report, skipped: "工作区还没有项目目录结构，不生成「我的内容」" };
  const root = path.join(libRoot, VIEW_DIR);
  await fs.mkdir(root, { recursive: true });
  const ctx: Ctx = { root, now: opts.now ?? new Date(), link: opts.linkImpl ?? fs.link, report };
  try {
    const prev = await readManifest(root);
    const keepAside = async (file: string) => { await displace(file, ctx.now); report.preservedEdits++; };
    report.errors.push(...(await syncBackFounderEdits(root, prev.entries, data, keepAside)));
    const plan = await buildPlan(data, opts.keepPublished ?? KEEP_PUBLISHED);
    report.errors.push(...plan.errors);
    const next = await applyPlan(plan, prev, ctx);
    await fs.writeFile(path.join(root, VIEW_MANIFEST), JSON.stringify(next, null, 2));
  } catch (e) {
    report.errors.push(`对账中断：${errMsg(e)}`);
  }
  await hideLibraryEntries(libRoot, report).catch((e) => report.errors.push(`隐藏资料库条目失败：${errMsg(e)}`));
  await writeErrorSection(root, "sync", report.errors);
  return report;
}
