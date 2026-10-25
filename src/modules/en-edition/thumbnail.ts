/**
 * 英文版缩略图（Phase 3 第 5 条）：YouTube / X 都是 16:9（PLATFORM_CAPS），带创始人、英文字，由 Codex 按
 * cover-generator 的「英文版 16:9 缩略图」出图。这里只登记：按像素核 16:9、记 sha256，发布包按它核字节。
 * 落在英文版项目里的 `en-thumbnail.json`。
 */
import fs from "node:fs/promises";
import { resolveArchivedFile } from "../../storage/nas-kept.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { contentRoot, projectFile } from "../../storage/content-project.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { dimensionsOf } from "../research/fetch-image.js";

export interface EnThumbnail { path: string; sha256: string; width: number; height: number; at: string }

const file = (contentId: string, dataDir: string) => projectFile(contentRoot(contentId, dataDir), "en-thumbnail.json");

function formatOf(b: Buffer): "png" | "jpeg" | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return null;
}

export const is16x9 = (w: number, h: number) => h > 0 && Math.abs(w / h - 16 / 9) / (16 / 9) < 0.01;

export async function readEnThumbnail(contentId: string, dataDir: string): Promise<EnThumbnail | null> {
  try { return JSON.parse(await fs.readFile(file(contentId, dataDir), "utf8")) as EnThumbnail; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

export async function setEnThumbnail(contentId: string, source: string, dataDir: string): Promise<{ ok: true; thumbnail: EnThumbnail } | { ok: false; code: string; error: string }> {
  const abs = path.resolve(source);
  let bytes: Buffer;
  try { bytes = await fs.readFile(abs); } catch (e) { return { ok: false, code: "thumbnail_unreadable", error: `缩略图读不了（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）：${abs}` }; }
  const fmt = formatOf(bytes);
  const dims = fmt ? dimensionsOf(fmt, bytes) : null;
  if (!dims) return { ok: false, code: "thumbnail_invalid", error: `缩略图不是 PNG / JPEG：${abs}` };
  if (!is16x9(dims.width, dims.height)) return { ok: false, code: "thumbnail_not_16x9", error: `YouTube / X 缩略图要 16:9，这张是 ${dims.width}×${dims.height}：按 cover-generator 的英文版段重出` };
  const thumbnail = { path: abs, sha256: createHash("sha256").update(bytes).digest("hex"), width: dims.width, height: dims.height, at: new Date().toISOString() };
  await fs.mkdir(path.dirname(file(contentId, dataDir)), { recursive: true });
  await writeJsonAtomic(file(contentId, dataDir), thumbnail);
  return { ok: true, thumbnail };
}

/** 缩略图还是登记时那张：读不到或字节变了交原因 */
export async function thumbnailProblem(t: EnThumbnail | null): Promise<string | null> {
  if (!t) return "还没有 16:9 缩略图：派 Codex 按 cover-generator 的英文版段出图，再 op:\"set_thumbnail\" 登记";
  const found = await resolveArchivedFile(t.path);
  if (!found.ok) return `登记的缩略图${found.error}`;
  const bytes = await fs.readFile(found.path).catch(() => null);
  if (!bytes) return `登记的缩略图不见了：${t.path}`;
  return createHash("sha256").update(bytes).digest("hex") === t.sha256 ? null : `缩略图在登记之后被改过：${t.path}，重新登记`;
}
