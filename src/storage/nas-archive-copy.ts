/**
 * 把项目目录逐文件复制到 NAS 并核对 sha256。SMB 上只用普通 copyFile，不用硬链接，不靠 rename 落位：
 * 目标已有的文件按哈希判断，对得上就跳过，对不上就重拷——中断后续跑安全。
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface ArchivedFile { rel: string; sha256: string; size: number; mtimeMs?: number }
export interface CopyProjectOptions {
  /** 上次备份记录（rel → 文件）：NAS 上的旧文件是这份记录里的版本，就改名留底而不是覆盖 */
  previous?: Map<string, ArchivedFile>;
  /** 本机大小和修改时间都跟上次备份一样的文件，不再读 NAS 核对（增量备份用；归档删本机前不开） */
  skipUnchanged?: boolean;
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
 * 目标是另一个版本时：是上次备份过的版本（keepSha）就改名留底，否则（拷到一半的残件）直接换掉。
 */
async function copyVerified(source: string, dest: string, copy: CopyImpl, keepSha?: string): Promise<string> {
  const want = await sha256File(source);
  const have = await hashOrNull(dest);
  if (have === want) return want;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (have !== null && have === keepSha && (await hashOrNull(keptName(dest, have))) === null) await fs.rename(dest, keptName(dest, have));
  else await fs.rm(dest, { force: true });
  await copy(source, dest);
  const got = await hashOrNull(dest);
  if (got !== want) throw new Error(`校验不一致（本机 ${want.slice(0, 12)}…，NAS ${got?.slice(0, 12) ?? "缺失"}…）`);
  return want;
}

/** 整个项目复制 + 逐个核对。任何一个文件出错都记下来，调用方据此决定一律不删本机。 */
export async function copyProject(
  root: string, target: string, copy: CopyImpl, mediaDirs: readonly string[], opts: CopyProjectOptions = {},
): Promise<{ files: ArchivedFile[]; errors: string[] }> {
  const { files, special } = await walkProject(root);
  // 要删的目录里有链接就不删（复制不了）；其它目录里的链接留在本机，不影响
  const blocking = special.filter((rel) => mediaDirs.some((d) => rel.startsWith(`${d}/`)));
  const out: ArchivedFile[] = [], errors = blocking.map((rel) => `${rel}：不是普通文件（链接等），没法归档`);
  for (const f of files) {
    if (opts.exclude?.(f.rel)) continue;
    const prev = opts.previous?.get(f.rel);
    if (opts.skipUnchanged && prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs) { out.push(prev); continue; }
    try {
      const sha256 = await copyVerified(path.join(root, f.rel), path.join(target, f.rel), copy, prev?.sha256);
      out.push({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, sha256 });
    }
    catch (e) { errors.push(`${f.rel}：${e instanceof Error ? e.message : String(e)}`); }
  }
  return { files: out, errors };
}
