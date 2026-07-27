/**
 * 研究素材的只读文件端点（深调研 spec §7）——与 `/api/asset`（封面/正文配图）同一套纪律：
 * invoke 走 JSON，图片字节走独立 GET；先鉴权，再校验 id 形状，路径由存储层解析。
 *
 * 为什么单独成模块而不是内联在 server.ts：`/api/asset` 那段没有测试面（server.ts 一 import
 * 就 listen）。素材文件的**鉴权顺序**与**越界拒绝**是安全语义，必须能被断言，
 * 所以决策部分抽成纯函数，server.ts 只剩「调它 + 流文件」。
 *
 * 两条与 `/api/asset` 不同的地方，都是刻意的：
 * 1. 路径**不在这里拼**。素材的相对路径存在 index.jsonl 里（普通文本，可被篡改），
 *    所以一律经 `getResearchAssetFile` → `resolveAssetPath` 的越界闸；这里只负责把
 *    「越界」翻译成 403，不自己算路径。
 * 2. 缓存可以 immutable：文件名是内容 hash，一个 assetId 的字节永不改写。
 */
import fs from "node:fs/promises";
import { getResearchAsset, resolveAssetPath } from "../modules/research/research-asset-store.js";
import type { ImageFormat } from "../modules/research/fetch-image.js";

/** saveResearchAsset 生成的 id 形状；对不上的一律不进存储层 */
const ASSET_ID_RE = /^rasset-\d+-[a-z0-9]+$/;

const CONTENT_TYPE: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export type ResearchAssetServeResult =
  | { ok: true; file: string; contentType: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

export interface ResearchAssetServeRequest {
  assetId: string;
  /** 调用方（server.ts）鉴权的结论。false → 403，且**一个字节都不读** */
  authorized: boolean;
  dataDir: string;
}

/**
 * 解析一次取图请求。**不读文件内容**，只定位并体检——字节由调用方流式吐出。
 * 顺序不可换：鉴权 → id 形状 → 存储层解析（含越界闸）→ 文件在不在。
 */
export async function serveResearchAsset(
  req: ResearchAssetServeRequest,
): Promise<ResearchAssetServeResult> {
  if (!req.authorized) return { ok: false, status: 403, error: "not authenticated" };
  if (!ASSET_ID_RE.test(req.assetId)) return { ok: false, status: 400, error: "bad asset_id" };

  const asset = await getResearchAsset(req.assetId, req.dataDir);
  if (!asset) return { ok: false, status: 404, error: "asset not found" };

  let file: string;
  try {
    file = resolveAssetPath(asset.file, req.dataDir);
  } catch {
    // 索引被污染成越界路径：拒绝而不是 404——这不是「没有这张图」，是有东西不对劲
    return { ok: false, status: 403, error: "asset path out of bounds" };
  }
  try {
    await fs.access(file);
  } catch {
    return { ok: false, status: 404, error: "asset file missing" };
  }
  return { ok: true, file, contentType: CONTENT_TYPE[asset.format] ?? "application/octet-stream" };
}
