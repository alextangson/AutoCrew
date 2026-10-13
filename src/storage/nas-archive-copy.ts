/**
 * 把项目目录逐文件复制到 NAS。SMB 上只用普通 copyFile，不用硬链接，不靠 rename 落位——中断后续跑安全。
 * 归档（随后删本机）逐文件核对 sha256；备份（sizeOnly）只是留一份副本，拷完只核大小，
 * 只有要顶掉 NAS 上已有的那份时才算哈希（决定跳过还是改名留底）。
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { safeNasPath, assertInside } from "./nas-safe-path.js";

export interface ArchivedFile {
  /** 归档记录必有；备份记录（只核大小）没有 */
  rel: string; sha256?: string; size: number; mtimeMs?: number;
  /** 核对通过时 NAS 上那份的修改时间：增量跳过前用它确认 NAS 副本没被动过 */
  destMtimeMs?: number;
}
export interface CopyProjectOptions {
  /** 上次备份到同一个 target 的记录（rel → 文件）；调用方保证 target 一致 */
  previous?: Map<string, ArchivedFile>;
  /** 本机和 NAS 副本的大小、修改时间都跟上次记录一样才跳过，否则重新哈希核对（增量备份用；归档删本机前不开） */
  skipUnchanged?: boolean;
  /** 备份用：项目里的符号链接不在 NAS 上建，只登记（路径+指向）交调用方写进记录；其它特殊条目记为出错 */
  recordSymlinks?: boolean;
  /** 不复制的文件 / 目录（备份自己的记录和状态文件、项目缓存）；命中的目录不进去 */
  exclude?: (rel: string) => boolean;
  /** 备份用：不算 sha256，拷完只核 NAS 副本大小；归档删本机前不开 */
  sizeOnly?: boolean;
}
export type CopyImpl = (source: string, dest: string) => Promise<void>;

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (d) => hash.update(d)).on("end", () => resolve(hash.digest("hex")));
  });
}

/** 内部哈希都走这里（测试据此确认备份常规路径一次都不算） */
export const nasHash = { file: sha256File };

async function hashOrNull(file: string): Promise<string | null> {
  try { return await nasHash.file(file); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** 项目缓存目录（渲染工程、node_modules、中间音频）：可重建，不上 NAS，备份 / 归档都不走进去 */
export const PROJECT_CACHE_DIR = "99-cache";
export const isProjectCache = (rel: string) => rel === PROJECT_CACHE_DIR || rel.startsWith(`${PROJECT_CACHE_DIR}/`);

/**
 * 列出项目里所有普通文件（相对路径）；符号链接等特殊条目单独返回，由调用方决定是否挡删除。
 * skip 命中的目录 / 文件整个不看（目录不进去，省掉几万次 stat）。
 */
export async function walkProject(root: string, skip?: (rel: string) => boolean): Promise<{ files: { rel: string; size: number; mtimeMs: number }[]; special: string[] }> {
  const files: { rel: string; size: number; mtimeMs: number }[] = [], special: string[] = [];
  async function visit(rel: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip?.(child)) continue;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const st = await fs.stat(path.join(root, child));
        files.push({ rel: child, size: st.size, mtimeMs: st.mtimeMs });
      }
      else special.push(child);
    }
  }
  await visit("");
  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), special };
}

/** NAS 上被新版本顶掉的旧备份改名留底：name.<旧sha前8位>.ext */
export function keptName(dest: string, sha: string): string {
  const ext = path.extname(dest);
  return `${dest.slice(0, dest.length - ext.length)}.${sha.slice(0, 8)}${ext}`;
}

/**
 * 复制一个文件并核对；返回源文件哈希。目标已是同样内容就不再拷。
 * 目标是另一个版本时一律改名留底（没法证明它只是残件，宁可多留）；同名留底已存在（同一内容）才删掉。
 * 这次自己拷坏的那份是确定的残件，核对失败时删掉，免得下一轮被当成旧版本留底。
 */
async function copyVerified(source: string, dest: string, copy: CopyImpl): Promise<string> {
  const want = await nasHash.file(source);
  const have = await hashOrNull(dest);
  if (have === want) return want;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (have !== null) await keepAside(dest, have);
  await copy(source, dest);
  const got = await hashOrNull(dest);
  if (got !== want) {
    await fs.rm(dest, { force: true });
    throw new Error(`校验不一致（本机 ${want.slice(0, 12)}…，NAS ${got?.slice(0, 12) ?? "缺失"}…）`);
  }
  return want;
}

/**
 * 把 NAS 上的旧版本挪开留底。只有留底位置已有一份且整份 sha256 等于它，才算重复可删；
 * 留底名被别的内容占了就加序号（name.<sha8>-2.ext …），绝不在没证据时删。
 */
async function keepAside(dest: string, have: string): Promise<void> {
  const first = keptName(dest, have), ext = path.extname(first);
  for (let i = 1; ; i++) {
    const name = i === 1 ? first : `${first.slice(0, first.length - ext.length)}-${i}${ext}`;
    const st = await lstatOrNull(name);
    if (st?.isSymbolicLink()) continue;
    const kept = st ? await nasHash.file(name) : null;
    if (kept === null) { await fs.rename(dest, name); return; }
    if (kept === have) { await fs.rm(dest, { force: true }); return; }
  }
}

async function lstatOrNull(file: string) {
  try { return await fs.lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/**
 * 备份用：不算哈希，拷完核大小。目标已有一份时才哈希：同大小且同内容就不拷，否则旧那份改名留底再拷。
 * 拷出来大小不对的是这次自己写的残件，当场删掉。
 */
async function copyBySize(source: string, dest: string, size: number, copy: CopyImpl): Promise<void> {
  const st = await lstatOrNull(dest);
  if (st) {
    const have = await nasHash.file(dest);
    if (st.size === size && have === (await nasHash.file(source))) return;
    await keepAside(dest, have);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await copy(source, dest);
  const got = (await lstatOrNull(dest))?.size;
  if (got !== size) {
    await fs.rm(dest, { force: true });
    throw new Error(`复制后校验不一致：大小不对（本机 ${size}，NAS ${got ?? "缺失"}）`);
  }
}

/** 本机没变，且 NAS 副本还在、大小和修改时间跟记录一致 */
async function unchangedBoth(f: { size: number; mtimeMs: number }, prev: ArchivedFile | undefined, dest: string): Promise<boolean> {
  if (!prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs || prev.destMtimeMs === undefined) return false;
  const st = await lstatOrNull(dest);
  return !!st && st.isFile() && st.size === prev.size && st.mtimeMs === prev.destMtimeMs;
}

export interface ProjectLink { rel: string; target: string }

/** 项目里的符号链接只登记（NAS 上不建链接）；链接以外的特殊条目报出来 */
async function recordSpecials(root: string, special: string[]): Promise<{ links: ProjectLink[]; errors: string[] }> {
  const links: ProjectLink[] = [], errors: string[] = [];
  for (const rel of special) {
    const src = path.join(root, rel);
    if ((await fs.lstat(src)).isSymbolicLink()) links.push({ rel, target: await fs.readlink(src) });
    else errors.push(`${rel}：不是普通文件也不是链接，没法备份`);
  }
  return { links, errors };
}

/** 整个项目复制 + 逐个核对。任何一个文件出错都记下来，调用方据此决定一律不删本机。 */
export async function copyProject(
  root: string, target: string, copy: CopyImpl, mediaDirs: readonly string[], opts: CopyProjectOptions = {},
): Promise<{ files: ArchivedFile[]; errors: string[]; links: ProjectLink[] }> {
  const { files, special } = await walkProject(root, opts.exclude);
  // 要删的目录里有链接就不删（复制不了）；其它目录里的链接留在本机，不影响
  const blocking = special.filter((rel) => mediaDirs.some((d) => rel.startsWith(`${d}/`)));
  const out: ArchivedFile[] = [], errors = blocking.map((rel) => `${rel}：不是普通文件（链接等），没法归档`);
  const recorded = opts.recordSymlinks ? await recordSpecials(root, special.filter((rel) => !opts.exclude?.(rel))) : { links: [], errors: [] };
  errors.push(...recorded.errors);
  for (const f of files) {
    if (opts.exclude?.(f.rel)) continue;
    const prev = opts.previous?.get(f.rel);
    try {
      const dest = await safeNasPath(target, f.rel);
      if (opts.skipUnchanged && (await unchangedBoth(f, prev, dest))) { out.push(prev!); continue; }
      const source = path.join(root, f.rel);
      const sha256 = opts.sizeOnly ? undefined : await copyVerified(source, dest, copy);
      if (opts.sizeOnly) await copyBySize(source, dest, f.size, copy);
      await assertInside(target, f.rel);
      out.push({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, ...(sha256 ? { sha256 } : {}), destMtimeMs: (await fs.lstat(dest)).mtimeMs });
    }
    catch (e) { errors.push(`${f.rel}：${e instanceof Error ? e.message : String(e)}`); }
  }
  return { files: out, errors, links: recorded.links };
}
