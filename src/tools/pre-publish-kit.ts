/**
 * 发布前检查里与视频发布包有关的部分（P6 §3.6）：按「这条稿 + 目标平台」读包、判过期、指路。
 * 一条视频发多平台 = 一条稿多份包（videoKits），不再要求 content.platform === 平台（spec 2026-10-12 A）。
 */
import type { Content } from "../storage/local-store.js";
import { isVideoPlatform, VIDEO_PLATFORMS } from "../storage/stage-guard.js";
import { videoKitFor } from "../storage/video-kits.js";
import { editorialDraftHash } from "./editorial.js";
import { COVER_TEXT_MAX, videoTitleLimit } from "../modules/publish/video-kit.js";
import { KIT_BEHIND_REGISTER, kitBehindRegister } from "../modules/publish/kit-stale.js";
import { captionTags, KIT_CAPTION_MIN, PLATFORM_MAX_BODY } from "../modules/publish/publish-limits.js";

export type KitFailure = { ok: false; error: string; code?: string; next_action?: Record<string, unknown> };

/** 各视频平台的上限直接从常量拼进工具说明，数字只有一份，不会说明写 20、代码判 22 */
export function kitLimitsText(): string {
  const platforms = [...VIDEO_PLATFORMS];
  const titles = platforms.map((p) => `${p} ${videoTitleLimit(p)}`).join(" / ");
  const captions = platforms.map((p) => `${p} ${PLATFORM_MAX_BODY[p] ?? "不设"}`).join(" / ");
  return `post_title 上限：${titles}（中文 1 字、英文数字半字、空格不计）；caption ≥${KIT_CAPTION_MIN} 字，上限：${captions}；cover_text ≤${COVER_TEXT_MAX} 字`;
}

export interface PublishSurface {
  /** true = 视频平台且有本平台发布包，标题/简介/标签都从发布包取 */
  fromKit: boolean;
  title: string;
  text: string;
  hashtags: string[];
}

/** 与剪贴板 / ego-lite 同口径：有发布包发的是发布包（没填发布标题才退回稿件标题），标签只算简介里的 */
export function publishSurface(content: Content, platform: string): PublishSurface {
  const kit = isVideoPlatform(platform) ? videoKitFor(content, platform) : undefined;
  if (kit?.caption?.trim()) {
    return { fromKit: true, title: kit.postTitle?.trim() || content.title || "", text: kit.caption, hashtags: captionTags(kit.caption) };
  }
  return { fromKit: false, title: content.title || "", text: content.body || "", hashtags: content.hashtags || [] };
}

export function videoKitNextAction(content: Content, platform: string): Record<string, unknown> {
  return {
    tool: "autocrew_pre_publish",
    params: { action: "video_kit", content_id: content.id, platform },
    required_input: "kit",
    message: `读当前稿，先用 action=title_methods 读标题方法库，出 3 个通用候选给创始人挑，再按平台重拟 kit{post_title, caption, cover_text, hashtags?, title_candidates, title_method}。${kitLimitsText()}。`,
  };
}

/** 发布包带指纹且与当前稿对不上 = 按旧稿做的；旧发布包没有指纹，不判过期 */
export function staleKit(content: Content, platform: string): KitFailure | null {
  const kit = isVideoPlatform(platform) ? videoKitFor(content, platform) : undefined;
  if (!kit) return null;
  if (kitBehindRegister(content, kit)) return { ok: false, code: "kit_stale", error: KIT_BEHIND_REGISTER, next_action: videoKitNextAction(content, platform) };
  if (!kit.draftHash || kit.draftHash === editorialDraftHash(content)) return null;
  return {
    ok: false,
    code: "kit_stale",
    error: "视频发布包是按旧稿做的（稿件后来改过），标题和简介可能对不上新稿：按当前稿重做发布包，再跑发布前检查",
    next_action: videoKitNextAction(content, platform),
  };
}

/**
 * 这次检查 / 交包针对哪个平台：视频稿可以是任一视频平台（四平台共用一条稿）；文字稿只能是稿件平台。
 * 返回 string = 平台；返回对象 = 拒绝。
 */
export function targetPlatform(content: Content, requested: unknown): string | (KitFailure & { expected_platform?: string }) {
  const own = content.platform || "";
  const asked = typeof requested === "string" ? requested.trim() : "";
  if (!asked || asked === own) return own;
  if (isVideoPlatform(own) && isVideoPlatform(asked)) return asked;
  return { ok: false, code: "platform_mismatch", error: `这篇是 ${own || "未知平台"} 的稿，不能按 ${asked} 检查或交包（视频稿可以换成别的视频平台，文字稿只认自己的平台）`, expected_platform: own };
}
