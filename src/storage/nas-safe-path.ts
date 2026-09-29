/**
 * NAS 侧写入/核对的路径安全：绝不顺着 NAS 上的符号链接写或读。
 * 旧版曾在 NAS 上建过符号链接（比如 03-broll → 本机 02-aroll），顺着它写会把文件写回本机，
 * 核对还能通过，归档随后删本机——内容就没了。所以落盘前逐级 lstat，遇到链接改名挪开（不删），换成真目录。
 */
import fs from "node:fs/promises";
import path from "node:path";

async function lstatOrNull(file: string) {
  try { return await fs.lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** 链接改名挪开：<名>.link-moved-<n> */
async function moveLinkAside(p: string): Promise<void> {
  for (let i = 1; ; i++) {
    const aside = `${p}.link-moved-${i}`;
    if (!(await lstatOrNull(aside))) { await fs.rename(p, aside); return; }
  }
}

/**
 * 返回 target/rel 的真实落点：target 本身和其下每一级目录都确认不是链接（是就挪开再建真目录），
 * 最后一级若是链接也挪开。之后核对这个路径的 realpath 没逃出 NAS 项目目录。
 */
export async function safeNasPath(target: string, rel: string): Promise<string> {
  const dirs = rel.split("/").slice(0, -1);
  let dir = target;
  for (let i = 0; i <= dirs.length; i++) {
    if (i > 0) dir = path.join(dir, dirs[i - 1]);
    const st = await lstatOrNull(dir);
    if (st?.isSymbolicLink()) await moveLinkAside(dir);
    if (!st || st.isSymbolicLink()) await fs.mkdir(dir, { recursive: i === 0 });
    else if (!st.isDirectory()) throw new Error(`NAS 上 ${path.relative(target, dir) || "项目目录"} 不是目录`);
  }
  const dest = path.join(target, rel);
  if ((await lstatOrNull(dest))?.isSymbolicLink()) await moveLinkAside(dest);
  await assertInside(target, rel);
  return dest;
}

/** 目标所在目录的真实路径必须正好是 NAS 项目目录下的同一相对位置（没有经过任何链接） */
export async function assertInside(target: string, rel: string): Promise<void> {
  const want = path.join(await fs.realpath(target), path.dirname(rel));
  const got = await fs.realpath(path.join(target, path.dirname(rel)));
  if (got !== want) throw new Error(`NAS 路径经过了链接（${rel} 实际落在 ${got}），不写也不核对`);
  const st = await lstatOrNull(path.join(target, rel));
  if (st?.isSymbolicLink()) throw new Error(`NAS 上 ${rel} 是链接，不写也不核对`);
}
