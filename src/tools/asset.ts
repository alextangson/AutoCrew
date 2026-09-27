import { Type } from "@sinclair/typebox";
import { addAsset, addAssetByPath, listAssets, removeAsset, listVersions, getVersion, revertToVersion } from "../storage/local-store.js";

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
    // 失败照旧向上抛（存储类错误由外层统一成 storage_unavailable），不在这里吞成泛化失败
    return source ? addAssetByPath(contentId, base, source, dataDir) : addAsset(contentId, base, dataDir);
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
