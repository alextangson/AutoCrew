/**
 * 常备素材池（lifecycle spec §1）——素材库里被显式标为 `reusable` 的那批素材。
 *
 * 为什么单独成文件：`reusable` 是**存储字段**，但「能不能开」是**业务判定**，
 * 两件事混在 library-store 里会让素材库这个通用抽屉长出视频线的规矩。
 * 这里就是那道判定：说明非空、文件还在、视频必须探得出时长。
 *
 * 三条纪律：
 * 1. **开启前置是 description 非空**。挂接逻辑拿素材名兜底，所以「无说明不可见」在稿件那侧
 *    形同虚设；常备池是全库共享的目录，必须是人写过说明的素材，否则剪辑师看到的是一串文件名。
 * 2. **入库即探测**：时长/画幅在入库或纳池那一刻 ffprobe 一次并持久化。构目录时同步探
 *    = 每次跑剪辑师都对着几十个文件跑 ffprobe，慢且随机失败。
 * 3. **探不出时长的视频不许进池**：让它进去只会把问题推到 assemble 才炸。
 */
import { access } from "node:fs/promises";
import { getAsset, listReusableAssets, updateAsset, type LibraryAsset } from "../../storage/library-store.js";
import { probeMedia } from "./ingest.js";
import type { VideoDeps } from "./proc.js";

export type PoolResult =
  | { ok: true; asset: LibraryAsset; warning?: string }
  | { ok: false; error: string };

/** 探一次并持久化；返回补探后的记录。`ok:false` = 这条素材不该进池 */
async function probeAndPersist(asset: LibraryAsset, dataDir?: string, deps?: VideoDeps): Promise<PoolResult> {
  const probed = await probeMedia(asset.path, deps);
  if (!probed.ok) {
    // 视频没时长就排不进目录（剪辑师要靠它定 inMs/outMs）；图片没画幅只是少两个数字
    if (asset.type === "video") {
      return { ok: false, error: `读不出 ${asset.name} 的时长（${probed.reason}）——探不出时长的视频进了常备池，只会在组装时才炸` };
    }
    return { ok: true, asset, warning: `已纳入常备池，但读不出 ${asset.name} 的画幅：${probed.reason}` };
  }
  const { durationMs, video } = probed.probe;
  const media = { durationMs, ...(video ? { width: video.width, height: video.height, fps: video.fps } : {}) };
  const next = await updateAsset(asset.id, { media }, dataDir);
  return next ? { ok: true, asset: next } : { ok: false, error: "探测结果没写回素材库记录" };
}

/**
 * 缺 media 就补探（存量素材纳入常备池时走这条，§1）。已有 media 原样返回，不重复探。
 * 视频探不出时长 = 拒绝；图片探不出画幅 = 带 warning 放行。
 */
export async function ensureLibraryMedia(
  asset: LibraryAsset,
  dataDir?: string,
  deps?: VideoDeps,
): Promise<PoolResult> {
  if (asset.type !== "video" && asset.type !== "image") return { ok: true, asset };
  if (asset.media?.durationMs) return { ok: true, asset };
  return probeAndPersist(asset, dataDir, deps);
}

/** 入库时的探测（§1）：探不出来不拦入库——素材本身是好的，纳池那一刻还会再探一次 */
export async function probeImportedAssets(
  assets: readonly LibraryAsset[],
  dataDir?: string,
  deps?: VideoDeps,
): Promise<void> {
  for (const asset of assets) {
    if (asset.type !== "video" && asset.type !== "image") continue;
    await probeAndPersist(asset, dataDir, deps).catch(() => undefined);
  }
}

/**
 * 开/关常备池。关闭无前置（随时可以退出池子）；开启要过三道：
 * 说明非空、类型是视频或图片、文件还在且视频探得出时长。
 */
export async function setLibraryReusable(
  id: string,
  reusable: boolean,
  dataDir?: string,
  deps?: VideoDeps,
): Promise<PoolResult> {
  const asset = await getAsset(id, dataDir);
  if (!asset) return { ok: false, error: "素材不存在" };
  if (!reusable) {
    const next = await updateAsset(id, { reusable: false }, dataDir);
    return next ? { ok: true, asset: next } : { ok: false, error: "素材不存在" };
  }
  if (!(asset.description ?? "").trim()) {
    return { ok: false, error: `先给「${asset.name}」写一行说明再纳入常备池——没说明的素材对剪辑师等于不存在` };
  }
  if (asset.type !== "video" && asset.type !== "image") {
    return { ok: false, error: `${asset.name} 是 ${asset.type} 素材，常备池只收视频与图片（覆盖轨用得上的那两种）` };
  }
  try {
    await access(asset.path);
  } catch {
    return { ok: false, error: "原文件已移动或删除，请先在素材库重新定位" };
  }
  const probed = await ensureLibraryMedia(asset, dataDir, deps);
  if (!probed.ok) return probed;
  const next = await updateAsset(id, { reusable: true }, dataDir);
  if (!next) return { ok: false, error: "素材不存在" };
  return { ok: true, asset: next, ...(probed.warning ? { warning: probed.warning } : {}) };
}

/**
 * 当前常备池（说明非空由 store 层一并判定）。**历史上恰好带「常备」字样标签的素材
 * 不在此列**——保留字标签的语义从来没被承诺过，自动升格等于替人做了他没做过的决定。
 */
export function listPool(dataDir?: string): Promise<LibraryAsset[]> {
  return listReusableAssets(dataDir);
}
