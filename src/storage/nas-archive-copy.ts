/**
 * 把项目目录逐文件复制到 NAS 并核对 sha256。SMB 上只用普通 copyFile，不用硬链接，不靠 rename 落位：
 * 目标已有的文件按哈希判断，对得上就跳过，对不上就重拷——中断后续跑安全。
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface ArchivedFile { rel: string; sha256: string; size: number }
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
export async function walkProject(root: string): Promise<{ files: { rel: string; size: number }[]; special: string[] }> {
  const files: { rel: string; size: number }[] = [], special: string[] = [];
  async function visit(rel: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push({ rel: child, size: (await fs.stat(path.join(root, child))).size });
      else special.push(child);
    }
  }
  await visit("");
  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), special };
}

/** 复制一个文件并核对；返回源文件哈希。目标已是同样内容就不再拷。 */
async function copyVerified(source: string, dest: string, copy: CopyImpl): Promise<string> {
  const want = await sha256File(source);
  if ((await hashOrNull(dest)) === want) return want;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { force: true });
  await copy(source, dest);
  const got = await hashOrNull(dest);
  if (got !== want) throw new Error(`校验不一致（本机 ${want.slice(0, 12)}…，NAS ${got?.slice(0, 12) ?? "缺失"}…）`);
  return want;
}

/** 整个项目复制 + 逐个核对。任何一个文件出错都记下来，调用方据此决定一律不删本机。 */
export async function copyProject(root: string, target: string, copy: CopyImpl, mediaDirs: readonly string[]): Promise<{ files: ArchivedFile[]; errors: string[] }> {
  const { files, special } = await walkProject(root);
  // 要删的目录里有链接就不删（复制不了）；其它目录里的链接留在本机，不影响
  const blocking = special.filter((rel) => mediaDirs.some((d) => rel.startsWith(`${d}/`)));
  const out: ArchivedFile[] = [], errors = blocking.map((rel) => `${rel}：不是普通文件（链接等），没法归档`);
  for (const f of files) {
    try { out.push({ rel: f.rel, size: f.size, sha256: await copyVerified(path.join(root, f.rel), path.join(target, f.rel), copy) }); }
    catch (e) { errors.push(`${f.rel}：${e instanceof Error ? e.message : String(e)}`); }
  }
  return { files: out, errors };
}
