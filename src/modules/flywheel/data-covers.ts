/**
 * 数据页的作品封面（数据页规格 §I.56–58）：工作区自己的目录 `<dataDir>/data-covers/`，不碰 outcomes.jsonl。
 *
 * 两种来源分文件存：manual-<hash>（人手动补的，按数据页的行 / 作品记）、auto-<hash>（自动回流顺手抓的，按作品记）。
 * 手动的永远优先——读的时候先找 manual，自动抓的写入前也先看有没有 manual，有就不下。
 * 文件名只由 key 的哈希 + 嗅探出来的格式决定，外部传不进路径。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const COVER_DIR = "data-covers";
export const MAX_COVER_BYTES = 10 * 1024 * 1024;
export type CoverKind = "manual" | "auto";
export type CoverExt = "png" | "jpg" | "webp";
const EXTS: CoverExt[] = ["png", "jpg", "webp"];
export const COVER_MIME: Record<CoverExt, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
/** 服务端只认这个形状的文件名（/api/data/cover-file 的白名单） */
export const COVER_FILE_RE = /^(manual|auto)-[a-f0-9]{24}\.(png|jpg|webp)$/;

export function coverDir(dataDir: string): string {
  return path.join(dataDir, COVER_DIR);
}

const hashOf = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 24);

/** 看文件头认格式，不信扩展名和 Content-Type */
export function sniffImage(bytes: Uint8Array): CoverExt | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

/** 校验一张要存的图：给人看的错误一句话 */
export function checkCoverBytes(bytes: Uint8Array): { ok: true; ext: CoverExt } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "图片是空的" };
  if (bytes.length > MAX_COVER_BYTES) return { ok: false, error: "图片超过 10MB，换一张小一点的" };
  const ext = sniffImage(bytes);
  if (!ext) return { ok: false, error: "只收 png / jpg / webp 图片" };
  return { ok: true, ext };
}

/** 这个 key 现有的封面文件名（没有 = null） */
export async function findCover(dataDir: string, kind: CoverKind, key: string): Promise<string | null> {
  const base = `${kind}-${hashOf(key)}`;
  for (const ext of EXTS) {
    const name = `${base}.${ext}`;
    try { await fs.access(path.join(coverDir(dataDir), name)); return name; } catch { /* 试下一个格式 */ }
  }
  return null;
}

async function removeKind(dataDir: string, kind: CoverKind, key: string): Promise<boolean> {
  let removed = false;
  for (const ext of EXTS) {
    try { await fs.unlink(path.join(coverDir(dataDir), `${kind}-${hashOf(key)}.${ext}`)); removed = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return removed;
}

async function write(dataDir: string, kind: CoverKind, key: string, bytes: Uint8Array, ext: CoverExt): Promise<string> {
  await fs.mkdir(coverDir(dataDir), { recursive: true });
  await removeKind(dataDir, kind, key); // 换格式时别留旧文件
  const name = `${kind}-${hashOf(key)}.${ext}`;
  const tmp = path.join(coverDir(dataDir), `.${name}.${process.pid}.tmp`);
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, path.join(coverDir(dataDir), name));
  return name;
}

/** 手动补 / 替换：校验不过抛给人看的错误 */
export async function saveManualCover(dataDir: string, key: string, bytes: Uint8Array): Promise<string> {
  if (!key.trim()) throw new Error("缺少作品标识");
  const checked = checkCoverBytes(bytes);
  if (!checked.ok) throw new Error(checked.error);
  return write(dataDir, "manual", key, bytes, checked.ext);
}

export async function removeManualCover(dataDir: string, key: string): Promise<boolean> {
  return removeKind(dataDir, "manual", key);
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * 自动回流抓到的封面地址 → 下载存下。手动补过的不下；已经抓过的不重下。
 * 返回 "saved" / "skipped"；下载或校验失败抛错（调用方记进回流状态）。
 */
export async function saveAutoCover(dataDir: string, key: string, url: string, fetchImpl: FetchLike): Promise<"saved" | "skipped"> {
  if (await findCover(dataDir, "manual", key)) return "skipped";
  if (await findCover(dataDir, "auto", key)) return "skipped";
  if (!/^https:\/\//.test(url)) throw new Error("not_https");
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`http_${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const checked = checkCoverBytes(bytes);
  if (!checked.ok) throw new Error("not_image");
  await write(dataDir, "auto", key, bytes, checked.ext);
  return "saved";
}
