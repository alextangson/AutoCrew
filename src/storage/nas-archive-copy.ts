/**
 * 把项目目录逐文件复制到 NAS 并核对 sha256。SMB 上只用普通 copyFile，不用硬链接，不靠 rename 落位：
 * 目标已有的文件按哈希判断，对得上就跳过，对不上就重拷——中断后续跑安全。
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface ArchivedFile {
  rel: string; sha256: string; size: number; mtimeMs?: number;
  /** 核对通过时 NAS 上那份的修改时间：增量跳过前用它确认 NAS 副本没被动过 */
  destMtimeMs?: number;
}
export interface CopyProjectOptions {
  /** 上次备份到同一个 target 的记录（rel → 文件）；调用方保证 target 一致 */
  previous?: Map<string, ArchivedFile>;
  /** 本机和 NAS 副本的大小、修改时间都跟上次记录一样才跳过，否则重新哈希核对（增量备份用；归档删本机前不开） */
  skipUnchanged?: boolean;
  /** 符号链接照原样在 NAS 上建成符号链接（备份用）；其它特殊条目记为出错 */
  copySymlinks?: boolean;
  /** 不复制的文件（备份自己的记录和状态文件） */
  exclude?: (rel: string) => boolean;
}
export type CopyImpl = (source: string, dest: string) => Promise<void>;

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (d) => hash.update(d)).on("end", () => resolve(hash.digest("hex")));
  });
}

async function hashOrNull(file: string): Promise<string | null> {
  try { return await sha256File(file); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** 列出项目里所有普通文件（相对路径）；符号链接等特殊条目单独返回，由调用方决定是否挡删除 */
export async function walkProject(root: string): Promise<{ files: { rel: string; size: number; mtimeMs: number }[]; special: string[] }> {
  const files: { rel: string; size: number; mtimeMs: number }[] = [], special: string[] = [];
  async function visit(rel: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
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
  const want = await sha256File(source);
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
    const kept = await hashOrNull(name);
    if (kept === null) { await fs.rename(dest, name); return; }
    if (kept === have) { await fs.rm(dest, { force: true }); return; }
  }
}

async function statOrNull(file: string) {
  try { return await fs.stat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** 本机没变，且 NAS 副本还在、大小和修改时间跟记录一致 */
async function unchangedBoth(f: { size: number; mtimeMs: number }, prev: ArchivedFile | undefined, dest: string): Promise<boolean> {
  if (!prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs || prev.destMtimeMs === undefined) return false;
  const st = await statOrNull(dest);
  return !!st && st.size === prev.size && st.mtimeMs === prev.destMtimeMs;
}

async function lstatOrNull(file: string) {
  try { return await fs.lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** 符号链接在 NAS 上照建（目标一样就不动；原位是别的东西先挪开留底）；非链接的特殊条目报出来 */
async function copySpecials(root: string, target: string, special: string[]): Promise<string[]> {
  const errors: string[] = [];
  for (const rel of special) {
    try {
      const src = path.join(root, rel), dest = path.join(target, rel);
      if (!(await fs.lstat(src)).isSymbolicLink()) { errors.push(`${rel}：不是普通文件也不是链接，没法备份`); continue; }
      const link = await fs.readlink(src), st = await lstatOrNull(dest);
      if (st?.isSymbolicLink() && (await fs.readlink(dest)) === link) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (st?.isSymbolicLink()) await fs.rm(dest);
      else if (st) await fs.rename(dest, `${dest}.replaced-${Date.now()}`);
      await fs.symlink(link, dest);
    } catch (e) { errors.push(`${rel}：链接没建成（${e instanceof Error ? e.message : String(e)}）`); }
  }
  return errors;
}

/** 整个项目复制 + 逐个核对。任何一个文件出错都记下来，调用方据此决定一律不删本机。 */
export async function copyProject(
  root: string, target: string, copy: CopyImpl, mediaDirs: readonly string[], opts: CopyProjectOptions = {},
): Promise<{ files: ArchivedFile[]; errors: string[] }> {
  const { files, special } = await walkProject(root);
  // 要删的目录里有链接就不删（复制不了）；其它目录里的链接留在本机，不影响
  const blocking = special.filter((rel) => mediaDirs.some((d) => rel.startsWith(`${d}/`)));
  const out: ArchivedFile[] = [], errors = blocking.map((rel) => `${rel}：不是普通文件（链接等），没法归档`);
  if (opts.copySymlinks) errors.push(...(await copySpecials(root, target, special.filter((rel) => !opts.exclude?.(rel)))));
  for (const f of files) {
    if (opts.exclude?.(f.rel)) continue;
    const prev = opts.previous?.get(f.rel), dest = path.join(target, f.rel);
    try {
      if (opts.skipUnchanged && (await unchangedBoth(f, prev, dest))) { out.push(prev!); continue; }
      const sha256 = await copyVerified(path.join(root, f.rel), dest, copy);
      out.push({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, sha256, destMtimeMs: (await fs.stat(dest)).mtimeMs });
    }
    catch (e) { errors.push(`${f.rel}：${e instanceof Error ? e.message : String(e)}`); }
  }
  return { files: out, errors };
}
