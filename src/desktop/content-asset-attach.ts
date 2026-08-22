/**
 * 素材库 → 稿件的挂接（横屏 spec §2.6）。
 *
 * 挂接不是「拷个文件过去」，它要一次钉住三样东西：
 * 1. **元数据快照**：`sourceLibraryId` + 素材库当刻的 name/tags/description。存快照不存引用——
 *    素材库事后改名改标签，不该回头改变一篇已定稿稿件里的素材说明（那是同一版稿件两种事实）。
 *    在此之前这里只拷了 filename/type，tags 与 description 全丢。
 * 2. **role**：A-roll 发现与 BGM 选取的唯一依据。按类型给默认值，但仍由挂接 UI 让人确认一次。
 * 3. **ffprobe 事实**：时长/分辨率/帧率。剪辑师 agent 要靠它排时长，指纹给不了这些。
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { probeMedia } from "../modules/video/ingest.js";
import { ASSET_ROLES, guessAssetRole } from "../modules/video/ingest.js";
import { getAsset as getLibraryAsset, type LibraryAsset } from "../storage/library-store.js";
import {
  addAsset as addContentAsset,
  getContent,
  type Asset,
  type AssetMedia,
  type AssetRole,
} from "../storage/local-store.js";

export interface AttachAssetInput {
  contentId: string;
  libraryId: string;
  dataDir?: string;
  /** 挂接 UI 的必选项；非法或缺省时按类型猜 */
  role?: unknown;
  /** 一行内容说明；缺省时用素材库元数据预填 */
  description?: unknown;
}

export type AttachAssetResult =
  | { ok: true; asset: Asset; warning?: string }
  | { ok: false; error: string };

/** 说明的兜底次序：人写的 > 素材库 description > 「素材库名 · 标签」。三层都空才算真没说明 */
function describeFrom(asset: LibraryAsset, provided: unknown): string | undefined {
  const explicit = typeof provided === "string" ? provided.trim() : "";
  if (explicit) return explicit;
  const fromLibrary = asset.description?.trim();
  if (fromLibrary) return fromLibrary;
  const tags = asset.tags.map((t) => t.trim()).filter(Boolean).join("、");
  const parts = [asset.name.trim(), tags].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function roleFrom(provided: unknown, type: Asset["type"], existing: readonly Asset[]): AssetRole {
  return ASSET_ROLES.includes(provided as AssetRole) ? (provided as AssetRole) : guessAssetRole(type, existing);
}

/**
 * 视频/音频登记客观事实。读不出来不拦挂接（素材本身是好的，只是这台机器没 ffprobe），
 * 但要带 warning 冒出去——剪辑师看不见这条素材的时长，人得知道为什么。
 */
async function probeAttached(type: Asset["type"], file: string): Promise<{ media?: AssetMedia; warning?: string }> {
  if (type !== "video" && type !== "audio") return {};
  const probed = await probeMedia(file);
  if (!probed.ok) {
    return { warning: `已挂接，但读不出时长/分辨率：${probed.reason}` };
  }
  const { durationMs, video } = probed.probe;
  return {
    media: {
      durationMs,
      ...(video ? { width: video.width, height: video.height, fps: video.fps } : {}),
    },
  };
}

export async function attachLibraryAsset(input: AttachAssetInput): Promise<AttachAssetResult> {
  const { contentId, libraryId, dataDir } = input;
  const source = await getLibraryAsset(libraryId, dataDir);
  if (!source) return { ok: false, error: "素材不存在" };
  try {
    await access(source.path);
  } catch {
    return { ok: false, error: "原文件已移动或删除，请先在素材库重新定位" };
  }
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: "稿件不存在" };

  const filename = path.basename(source.path);
  // 同名拒绝：addContentAsset 复制无排他且 meta 不去重——同名二次挂接会覆盖字节
  // 并双登记，detach 时一次删两条（评审 fix 2026-06-11）
  if (content.assets.some((a) => a.filename === filename)) {
    return { ok: false, error: "同名素材已挂接：" + filename };
  }

  const probed = await probeAttached(source.type, source.path);
  const description = describeFrom(source, input.description);
  const result = await addContentAsset(
    contentId,
    {
      filename,
      type: source.type,
      role: roleFrom(input.role, source.type, content.assets),
      sourceLibraryId: source.id,
      sourceName: source.name,
      tags: source.tags,
      sourcePath: source.path,
      ...(description ? { description } : {}),
      ...(probed.media ? { media: probed.media } : {}),
    },
    dataDir,
  );
  if (!result.ok || !result.asset) return { ok: false, error: result.error || "挂接失败" };
  return { ok: true, asset: result.asset, ...(probed.warning ? { warning: probed.warning } : {}) };
}
