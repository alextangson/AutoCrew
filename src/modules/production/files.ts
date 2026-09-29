/**
 * record 的文件核验与落位原语（spec §3-2/3/7）。核验全部只读；落位只在文件归属事务里调。
 *
 * - `resolveLocalFile` / `checkCover`：摘自 confident-raman 的 retro-files（路径逐段禁符号链接、
 *   iCloud 占位拒、封面按像素头判比例），错误改成本体的 `{code, error}`。
 * - 完整性：大小与修改时间 10 秒内没变（修改时间早于 10 秒前，且哈希前后两次 stat 一致）+ 视频 ffprobe 时长 > 0。
 * - 克隆用 APFS clonefile（`COPYFILE_FICLONE`，不占额外空间、与源互不影响），跨卷退化为普通复制；**不用硬链接**。
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { dimensionsOf } from "../research/fetch-image.js";
import { coverRole } from "../video/handoff/cover-scan.js";
import { COVER_ROLES } from "../video/handoff/execution-index.js";
import { sha256File } from "../video/handoff/manifest.js";
import { expandHome } from "../video/handoff/roots.js";
import { probeMedia } from "../video/ingest.js";
import type { CoverRatio } from "../../storage/production-types.js";

export type Checked<T> = { ok: true; value: T } | { ok: false; code: string; error: string };
const fail = <T>(code: string, error: string): Checked<T> => ({ ok: false, code, error });

/** 根下第一段的系统别名：它们落到的仍是同一台机器的真实目录 */
const SYSTEM_ALIASES = new Set(["/var", "/tmp", "/etc"]);
const HEADER_BYTES = 256 * 1024;
export const STABLE_MS = 10_000;

async function lstatOrNull(p: string) {
  return fs.lstat(p).catch(() => null);
}

/** 规范化 + 逐段禁链接 + 必须是本机的普通文件；返回真实绝对路径 */
/**
 * 相对路径只按给定的根（本条项目目录、资料库根）解析，从不按服务进程的工作目录（Codex / 验收：会解析错、还会把服务路径泄露给调用方）。
 * 没给根的相对路径直接拒。
 */
async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const c of candidates) if (await lstatOrNull(c)) return c;
  return null;
}

export async function resolveLocalFile(input: string, label: string, bases: string[] = []): Promise<Checked<string>> {
  const raw = expandHome(input.trim());
  let expanded = raw;
  if (!path.isAbsolute(raw)) {
    const hit = await firstExisting(bases.map((b) => path.resolve(b, raw)).filter((p) => bases.some((b) => p === path.resolve(b) || p.startsWith(path.resolve(b) + path.sep))));
    if (!hit) return fail("path_relative", `${label} 要写绝对路径，或相对本条项目目录 / 资料库根的路径：${input.trim()}`);
    expanded = hit;
  }
  const st = await lstatOrNull(expanded);
  if (!st) return fail("path_missing", `${label} 不存在或读不了：${expanded}`);
  const segments = expanded.split(path.sep);
  for (let i = 2; i <= segments.length; i++) {
    const seg = segments.slice(0, i).join(path.sep);
    if (i === 2 && SYSTEM_ALIASES.has(seg)) continue;
    if ((await lstatOrNull(seg))?.isSymbolicLink()) return fail("path_symlink", `${label} 的路径里有符号链接：${seg}`);
  }
  if (!st.isFile()) return fail("path_not_file", `${label} 不是普通文件：${expanded}`);
  if (st.size > 0 && st.blocks === 0) {
    return fail("file_not_local", `${label} 不在本机（云盘只剩占位）：先在访达里下载到本机再报：${expanded}`);
  }
  try { await fs.access(expanded, constants.R_OK); } catch { return fail("path_unreadable", `${label} 读不了（权限）：${expanded}`); }
  return { ok: true, value: await fs.realpath(expanded) };
}

async function readHeader(file: string): Promise<Buffer> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** 按魔数认图：PNG / JPEG；扩展名不作数 */
function imageFormat(head: Buffer): "png" | "jpeg" | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  return null;
}

/** 图片的真实比例（3:4 / 4:3，其余 null） */
export async function coverRatioOf(file: string): Promise<CoverRatio | null> {
  const head = await readHeader(file);
  const format = imageFormat(head);
  const dims = format ? dimensionsOf(format, head) : null;
  const role = dims ? coverRole(dims.width, dims.height) : null;
  if (role === COVER_ROLES["3:4"]) return "3:4";
  if (role === COVER_ROLES["4:3"]) return "4:3";
  return null;
}

/** 封面：PNG / JPEG，像素比例必须就是它声称的那个比例；没声称就按像素认 */
export async function checkCover(file: string, ratio: CoverRatio | undefined): Promise<Checked<CoverRatio>> {
  const head = await readHeader(file);
  if (!imageFormat(head)) return fail("cover_invalid", `封面不是 PNG / JPEG：${file}`);
  const actual = await coverRatioOf(file);
  if (!actual) return fail("cover_invalid", `封面比例既不是 3:4 也不是 4:3：${file}`);
  if (ratio && ratio !== actual) return fail("cover_invalid", `封面声称 ${ratio}，像素是 ${actual}：${file}`);
  return { ok: true, value: actual };
}

export interface FileIdentity { dev: number; ino: number; size: number; mtime_ms: number }

export async function identityOf(file: string): Promise<FileIdentity> {
  const st = await fs.stat(file);
  return { dev: st.dev, ino: st.ino, size: st.size, mtime_ms: Math.trunc(st.mtimeMs) };
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime_ms === b.mtime_ms;
}

export const STILL_WRITING = "还在导出 / 拷贝（最近 10 秒内还在变），等它写完再报；这次什么都没写";

/** 完整性：修改时间早于 10 秒前；返回哈希（前后两次 stat 一致才算数） */
export async function stableFingerprint(file: string, now: number): Promise<Checked<{ id: FileIdentity; sha256: string }>> {
  const before = await identityOf(file);
  if (now - before.mtime_ms < STABLE_MS) return fail("file_unstable", STILL_WRITING);
  const sha256 = await sha256File(file);
  const after = await identityOf(file);
  if (!sameIdentity(before, after)) return fail("file_unstable", STILL_WRITING);
  return { ok: true, value: { id: after, sha256 } };
}

export type Probe = (file: string) => Promise<{ durationMs: number } | { error: string }>;

export const ffprobeDuration: Probe = async (file) => {
  const r = await probeMedia(file);
  return r.ok ? { durationMs: r.probe.durationMs } : { error: r.reason };
};

/** 视频（aroll / cut）：ffprobe 读得出时长 > 0，否则当没导完 */
export async function checkDuration(file: string, probe: Probe): Promise<Checked<number>> {
  const r = await probe(file);
  if ("error" in r) return fail("file_unstable", `读不出时长（${r.error}）：多半还在导出 / 拷贝，等它写完再报；这次什么都没写`);
  if (!(r.durationMs > 0)) return fail("file_unstable", "读出的时长是 0：多半还在导出 / 拷贝，等它写完再报；这次什么都没写");
  return { ok: true, value: r.durationMs };
}

/** 独占占住一个名字：`<stem><ext>` → `<stem>-2<ext>` → …（返回绝对路径，占位文件已建好） */
export async function reserveTarget(dir: string, stem: string, ext: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, `${stem}${n === 1 ? "" : `-${n}`}${ext}`);
    try {
      await (await fs.open(candidate, "wx")).close();
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`同名文件太多，占不到名字：${stem}${ext}`);
}

/** 克隆进项目（目标已由 reserveTarget 占位）：先删占位再 clonefile，核哈希与源身份 */
export async function cloneInto(source: string, target: string, sha256: string, id: FileIdentity): Promise<void> {
  await fs.rm(target, { force: true });
  await fs.copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const changed = !sameIdentity(id, await identityOf(source)) || (await sha256File(target)) !== sha256;
  if (changed) {
    await fs.rm(target, { force: true });
    throw new Error("源文件在克隆途中变了（还在写入？），已放弃这次落位，原件没动");
  }
}

/** 文件名里不能出现的字符去掉，限长（落位改名用） */
export function safeStem(title: string, max = 40): string {
  // eslint-disable-next-line no-control-regex
  const clean = title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").replace(/^\.+/, "").trim();
  return Array.from(clean || "未命名").slice(0, max).join("");
}
