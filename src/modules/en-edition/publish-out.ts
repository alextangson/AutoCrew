/**
 * 英文版的发布出口（方案 (b)）：只按批过的英文发布包出东西，而且每个出口只现算一次包（approvedEnPackage），
 * 用交出来的那一份读文件和文案——不在核完之后再读第二次。
 * - `prepareEnPublish`：ego_lite_prepare 给英文版的浏览器上传件；
 * - `enFinalCheck`：点「安排」/「发帖」前最后一次核，回包指纹；
 * - `enClipboard`：复制粘贴件，只给包里有的平台，文案取包里的那份；X / YouTube 各有自己的排版和发布页，不借别的平台的。
 * 中文视频不走这里（照旧登记出口）。
 */
import { approvedEnPackage, type EnPackageState } from "./package.js";
import { lineStoppedReason } from "../profile/platform-lines.js";
import { EN_PUBLISH_WINDOW } from "../publish/en-kit.js";
import { PLATFORM_CAPS, type PlatformId } from "../publish/platform-caps.js";

type Result = Record<string, unknown>;

function platformPackage(s: EnPackageState, p: string): Result {
  const k = s.kits[p];
  return {
    platform: p, publish_url: PLATFORM_CAPS[p as PlatformId].publishUrl, video_path: s.cut!.path, video_sha256: s.cut!.sha256,
    thumbnail_path: s.thumbnail!.path, thumbnail_sha256: s.thumbnail!.sha256,
    ...(p === "x" ? { post_text: k.caption } : { title: k.postTitle, description: k.caption, tags: k.tags ?? [], chapters: k.chapters ?? [] }),
  };
}

export async function prepareEnPublish(id: string, dataDir: string): Promise<Result> {
  const a = await approvedEnPackage(id, dataDir);
  if ("no" in a) return { ok: false, ...a.no };
  const s = a.s;
  return { ok: true, data: { content_id: id, package_hash: s.hash, packages: s.platforms.map((p) => platformPackage(s, p)), publish_window: EN_PUBLISH_WINDOW,
    note: "按 publish-content 的 YouTube / X 手册填表；点「安排」/「发帖」之前调 autocrew_content en_edition {op:\"final_check\", platform}，回的 package_hash 和这里的一致才点" } };
}

/** 平台必须在批过的包里（取消勾选后留下的旧包不算） */
function inPackage(s: EnPackageState, platform: string): Result | null {
  if (s.platforms.includes(platform) && s.kits[platform]) return null;
  if (platform === "youtube" || platform === "x") return { ok: false, code: "line_unpicked", error: lineStoppedReason({ platforms: s.platforms }, "en_edition", platform) ?? `批过的英文发布包里没有 ${platform}` };
  return { ok: false, code: "platform_not_in_package", error: `批过的英文发布包里没有 ${platform || "(空)"}：只能是 ${s.platforms.join(" / ") || "（空）"}` };
}

export async function enFinalCheck(id: string, platform: string, dataDir: string): Promise<Result> {
  const a = await approvedEnPackage(id, dataDir);
  if ("no" in a) return { ok: false, ...a.no };
  const bad = inPackage(a.s, platform);
  if (bad) return bad;
  return { ok: true, platform, package_hash: a.s.hash, video_sha256: a.s.cut!.sha256, thumbnail_sha256: a.s.thumbnail!.sha256, note: "可以点了：只点一次，点完记回执" };
}

/** X：帖子正文原样（标签交包时已并进去，不再加第二遍） */
function formatX(caption: string): Result {
  return { platform: "x", formattedTitle: "", formattedBody: caption, copyText: caption, publishUrl: PLATFORM_CAPS.x.publishUrl, tips: ["X 视频帖没有独立标题：整段粘进正文框", "视频按 X 手册上传，定时用「安排」"] };
}

/** YouTube：标题、描述（已含章节行和标签）、tags 各自一格 */
function formatYoutube(k: EnPackageState["kits"][string]): Result {
  const tags = (k.tags ?? []).join(", ");
  const chapters = (k.chapters ?? []).map((c) => `${c.at} ${c.title}`).join("\n");
  return {
    platform: "youtube", formattedTitle: k.postTitle, formattedBody: k.caption, tags, chapters,
    copyText: `${k.postTitle}\n\n${k.caption}${tags ? `\n\nTags: ${tags}` : ""}`, publishUrl: PLATFORM_CAPS.youtube.publishUrl,
    tips: ["标题、说明分别粘进 YouTube Studio 的两个框；章节行已在说明里", "tags 粘进「更多选项 → 标签」"],
  };
}

export async function enClipboard(id: string, platform: string, dataDir: string): Promise<Result> {
  const a = await approvedEnPackage(id, dataDir);
  if ("no" in a) return { ok: false, ...a.no };
  const bad = inPackage(a.s, platform);
  if (bad) return bad;
  const k = a.s.kits[platform];
  return { ok: true, data: { ...(platform === "x" ? formatX(k.caption) : formatYoutube(k)), fromVideoKit: true, package_hash: a.s.hash } };
}
