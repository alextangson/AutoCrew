import path from "node:path";
import { closedResult, oldEntryClosed } from "../modules/production/closed.js";
import { isWithin, readLibraryLocation } from "../storage/storage-roots.js";
import { Type } from "@sinclair/typebox";
import { isVideoPlatform } from "../storage/stage-guard.js";
import { COVER_ASSET_WARNING } from "../modules/video/unregistered-cut.js";
import { addAsset, addAssetByPath, getContent, getDataDir, listAssets, removeAsset, listVersions, getVersion, revertToVersion } from "../storage/local-store.js";

/**
 * autocrew_asset — manage media files (covers, B-Roll, images, videos, subtitles)
 * and version history for content projects.
 */

export const assetSchema = Type.Object({
  action: Type.Unsafe<"add" | "list" | "remove" | "versions" | "get_version" | "revert">({
    type: "string",
    enum: ["add", "list", "remove", "versions", "get_version", "revert"],
    description:
      "Action: 'add' asset to content, 'list' assets, 'remove' asset, 'versions' list version history, 'get_version' read a specific version, 'revert' to a previous version.",
  }),
  content_id: Type.String({ description: "Content project id (e.g. content-xxx)" }),
  filename: Type.Optional(Type.String({ description: "Asset filename (for add/remove)" })),
  asset_type: Type.Optional(
    Type.Unsafe<"cover" | "broll" | "image" | "video" | "audio" | "subtitle" | "other">({
      type: "string",
      enum: ["cover", "broll", "image", "video", "audio", "subtitle", "other"],
      description: "Asset type (for add)",
    }),
  ),
  description: Type.Optional(Type.String({ description: "Asset description (for add)" })),
  source_path: Type.Optional(
    Type.String({ description: "Absolute path of the file (for add). Inside the library it is recorded in place by relative path; outside the library it is MOVED into the content project folder (not copied), then recorded." }),
  ),
  version: Type.Optional(Type.Number({ description: "Version number (for get_version/revert)" })),
});

/** 视频稿没进剪辑台 / 封面台就回传封面：照存，但提醒它进不了封面审批 */
async function coverBypassesGate(contentId: string, dataDir?: string): Promise<boolean> {
  const c = await getContent(contentId, dataDir);
  return Boolean(c && isVideoPlatform(c.platform) && c.status !== "editing" && c.status !== "publish_ready");
}

/** 资料库根（没配资料库时退回工作区目录）：库内路径只登记不挪 */
function getLibraryRootOrData(dataDir?: string): string {
  return readLibraryLocation()?.root ?? getDataDir(dataDir);
}

export async function executeAsset(params: Record<string, unknown>) {
  const action = params.action as string;
  const contentId = params.content_id as string;
  const dataDir = (params._dataDir as string) || undefined;

  if (!contentId) {
    return { ok: false, error: "content_id is required" };
  }

  // --- Asset operations ---

  if (action === "add") {
    const filename = params.filename as string;
    const assetType = (params.asset_type as string) || "other";
    if (!filename) return { ok: false, error: "filename is required for add" };
    const base = { filename, type: assetType as any, description: (params.description as string) || undefined };
    const source = (params.source_path as string) || "";
    // 本体启用后（§8）：封面分支与「把库外文件挪进项目」关闭，改走 autocrew_content record；库内素材登记照旧
    if (await oldEntryClosed(getDataDir(dataDir), contentId)) {
      const external = Boolean(source) && !isWithin(getLibraryRootOrData(dataDir), path.resolve(source));
      if (assetType === "cover" || external) return closedResult(contentId);
    }
    // 失败照旧向上抛（存储类错误由外层统一成 storage_unavailable），不在这里吞成泛化失败
    const result = source ? await addAssetByPath(contentId, base, source, dataDir) : await addAsset(contentId, base, dataDir);
    return result.ok && assetType === "cover" && (await coverBypassesGate(contentId, dataDir))
      ? { ...result, warning: COVER_ASSET_WARNING }
      : result;
  }

  if (action === "list") {
    const assets = await listAssets(contentId, dataDir);
    return { ok: true, content_id: contentId, assets };
  }

  if (action === "remove") {
    const filename = params.filename as string;
    if (!filename) return { ok: false, error: "filename is required for remove" };
    const removed = await removeAsset(contentId, filename, dataDir);
    return { ok: removed, message: removed ? `Removed ${filename}` : "Asset not found" };
  }

  // --- Version operations ---

  if (action === "versions") {
    const versions = await listVersions(contentId, dataDir);
    return { ok: true, content_id: contentId, versions };
  }

  if (action === "get_version") {
    const ver = params.version as number;
    if (!ver) return { ok: false, error: "version number is required" };
    const body = await getVersion(contentId, ver, dataDir);
    if (!body) return { ok: false, error: `Version ${ver} not found` };
    return { ok: true, content_id: contentId, version: ver, body };
  }

  if (action === "revert") {
    const ver = params.version as number;
    if (!ver) return { ok: false, error: "version number is required" };
    const content = await revertToVersion(contentId, ver, dataDir);
    if (!content) return { ok: false, error: `Failed to revert to version ${ver}` };
    return { ok: true, content };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}
