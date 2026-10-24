/**
 * 英文版的发布出口（方案 (b)）：只按批过的英文发布包出东西。
 * - `prepareEnPublish`：ego_lite_prepare 给英文版的浏览器上传件——每个平台的成片、缩略图、标题 / 描述 / 帖子正文、tags、章节、包指纹。
 * - `enFinalCheck`：点「安排」/「发帖」前最后一次核：批准仍有效、文件字节仍是批过的那份；回包指纹，和出包时的对上才点。
 * 中文视频不走这里（照旧登记出口）。
 */
import { enPackageState, enPublishRefusal } from "./package.js";
import { EN_PUBLISH_WINDOW } from "../publish/en-kit.js";
import { PLATFORM_CAPS, type PlatformId } from "../publish/platform-caps.js";

type Result = Record<string, unknown>;

export async function prepareEnPublish(id: string, dataDir: string): Promise<Result> {
  const refused = await enPublishRefusal(id, dataDir);
  if (refused) return { ok: false, ...refused };
  const s = await enPackageState(id, dataDir);
  if ("error" in s) return { ok: false, code: s.code, error: s.error };
  const packages = s.platforms.map((p) => {
    const k = s.kits[p];
    return {
      platform: p, publish_url: PLATFORM_CAPS[p as PlatformId].publishUrl, video_path: s.cut!.path, video_sha256: s.cut!.sha256,
      thumbnail_path: s.thumbnail!.path, thumbnail_sha256: s.thumbnail!.sha256,
      ...(p === "x" ? { post_text: k.caption } : { title: k.postTitle, description: k.caption, tags: k.tags ?? [], chapters: k.chapters ?? [] }),
    };
  });
  return { ok: true, data: { content_id: id, package_hash: s.hash, packages, publish_window: EN_PUBLISH_WINDOW,
    note: "按 publish-content 的 YouTube / X 手册填表；点「安排」/「发帖」之前调 autocrew_content en_edition {op:\"final_check\", platform}，回的 package_hash 和这里的一致才点" } };
}

export async function enFinalCheck(id: string, platform: string, dataDir: string): Promise<Result> {
  const refused = await enPublishRefusal(id, dataDir);
  if (refused) return { ok: false, ...refused };
  const s = await enPackageState(id, dataDir);
  if ("error" in s) return { ok: false, code: s.code, error: s.error };
  if (!s.platforms.includes(platform)) return { ok: false, code: "platform_not_in_package", error: `英文发布包里没有 ${platform || "(空)"}：只能是 ${s.platforms.join(" / ")}` };
  return { ok: true, platform, package_hash: s.hash, video_sha256: s.cut!.sha256, thumbnail_sha256: s.thumbnail!.sha256, note: "可以点了：只点一次，点完记回执" };
}
