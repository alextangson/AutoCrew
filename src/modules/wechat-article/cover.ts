/**
 * 公众号文章封面 = 一张主图 + 两个裁切区域（Phase 2b 修正 2a 的「一对封面」）。
 * 公众号草稿只收一张封面（thumb_media_id）加两个裁切（pic_crop_235_1 消息列表、pic_crop_1_1 分享卡 / 主页），
 * 坐标是相对主图的归一化 X1_Y1_X2_Y2。两张独立封面发不出去，所以包里只存一张主图和两个裁切。
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { detectFormat, dimensionsOf } from "../research/fetch-image.js";

export const ARTICLE_COVER_RATIOS = ["2.35:1", "1:1"] as const;
export type ArticleCoverRatio = (typeof ARTICLE_COVER_RATIOS)[number];
const RATIO_VALUE: Record<ArticleCoverRatio, number> = { "2.35:1": 2.35, "1:1": 1 };

/** 归一化裁切框，0–1，左上 (x1,y1) 到右下 (x2,y2) */
export interface CropBox { x1: number; y1: number; x2: number; y2: number }

export interface ArticleMasterCover {
  path: string;
  sha256: string;
  width: number;
  height: number;
  crops: Record<ArticleCoverRatio, CropBox>;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** 默认裁切：在主图里取居中、尽量大的目标比例框（1:1 = 居中正方形；2.35:1 = 整宽居中横条，或整高居中） */
export function centeredCrop(width: number, height: number, ratio: ArticleCoverRatio): CropBox {
  const r = RATIO_VALUE[ratio];
  if (width / height >= r) {
    const w = (height * r) / width;
    return { x1: round((1 - w) / 2), y1: 0, x2: round((1 + w) / 2), y2: 1 };
  }
  const h = width / r / height;
  return { x1: 0, y1: round((1 - h) / 2), x2: 1, y2: round((1 + h) / 2) };
}

/** 公众号 API 的写法：X1_Y1_X2_Y2 */
export function cropParam(c: CropBox): string {
  return [c.x1, c.y1, c.x2, c.y2].map((n) => String(round(n))).join("_");
}

/** 宿主自定裁切（"X1_Y1_X2_Y2" 字符串或四个数的数组）：范围 0–1、有面积、像素比例与目标比例相差不超过 3% */
export function parseCrop(raw: unknown, ratio: ArticleCoverRatio, width: number, height: number): CropBox | string {
  const parts = Array.isArray(raw) ? raw.map(Number) : String(raw).trim().split(/[_,\s]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) return `${ratio} 裁切要四个 0–1 的数（X1_Y1_X2_Y2）`;
  const [x1, y1, x2, y2] = parts;
  if (x2 <= x1 || y2 <= y1) return `${ratio} 裁切框左上要在右下之前`;
  const actual = ((x2 - x1) * width) / ((y2 - y1) * height);
  if (Math.abs(actual / RATIO_VALUE[ratio] - 1) > 0.03) return `${ratio} 裁切框的像素比例是 ${actual.toFixed(2)}:1，对不上 ${ratio}`;
  return { x1, y1, x2, y2 };
}

export type MasterRead = { ok: true; sha256: string; width: number; height: number } | { ok: false; error: string };

/** 读主图：只收 PNG / JPEG（公众号永久素材不收 WebP），要读得出像素尺寸 */
export async function readMaster(file: string): Promise<MasterRead> {
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); } catch (e) {
    return { ok: false, error: `封面主图读不了（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）：${file}` };
  }
  const format = detectFormat(bytes);
  if (format !== "png" && format !== "jpeg") return { ok: false, error: `封面主图要 PNG 或 JPEG（公众号封面不收${format ? ` ${format}` : "这种格式"}）：${file}` };
  const size = dimensionsOf(format, bytes);
  if (!size) return { ok: false, error: `封面主图读不出像素尺寸：${file}` };
  return { ok: true, sha256: createHash("sha256").update(bytes).digest("hex"), ...size };
}
