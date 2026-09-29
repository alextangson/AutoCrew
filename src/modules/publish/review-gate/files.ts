/**
 * 计划里文件的实况：在不在、字节指纹、图片像素。每次 check 都重读（确定性检查便宜），
 * 哈希按（路径, 大小, 修改时间）缓存——成片是 GB 级，同一份字节不必每次重算；
 * 原路径被覆盖 → 大小或修改时间变 → 重新算，指纹随之变（spec §15「原路径文件被覆盖 → 指纹变、重检」）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { dimensionsOf, type ImageFormat } from "../../research/fetch-image.js";
import { sha256File } from "../../video/handoff/manifest.js";

export interface FileFact { abs: string; ok: boolean; error?: string; sha256?: string; width?: number; height?: number }

const FORMATS: Record<string, ImageFormat> = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" };
const HEADER_BYTES = 256 * 1024;
const shaCache = new Map<string, { key: string; sha256: string }>();

async function cachedSha(abs: string, size: number, mtimeMs: number): Promise<string> {
  const key = `${size}:${Math.trunc(mtimeMs)}`;
  const hit = shaCache.get(abs);
  if (hit?.key === key) return hit.sha256;
  const sha256 = await sha256File(abs);
  shaCache.set(abs, { key, sha256 });
  return sha256;
}

async function header(abs: string): Promise<Buffer> {
  const h = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await h.read(buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally { await h.close(); }
}

export async function fileFact(abs: string, image: boolean): Promise<FileFact> {
  let st;
  try { st = await fs.stat(abs); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { abs, ok: false, error: code === "ENOENT" ? "文件不存在" : `读不了（${code ?? "未知错误"}）` };
  }
  if (!st.isFile()) return { abs, ok: false, error: "不是文件" };
  try {
    const sha256 = await cachedSha(abs, st.size, st.mtimeMs);
    if (!image) return { abs, ok: true, sha256 };
    const format = FORMATS[path.extname(abs).toLowerCase()];
    const dims = format ? dimensionsOf(format, await header(abs)) : null;
    if (!dims) return { abs, ok: false, sha256, error: "读不出图片像素（只认 png / jpg / webp）" };
    return { abs, ok: true, sha256, width: dims.width, height: dims.height };
  } catch (e) {
    return { abs, ok: false, error: `读不了：${e instanceof Error ? e.message : String(e)}` };
  }
}
