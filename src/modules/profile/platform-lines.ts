/**
 * 用户勾了哪些平台 → 哪些生产线开着（全媒体 spec Phase 1 增补，创始人 2026-10-23）：
 * 只有勾选的平台才出现它那条线——公众号文章线只在勾了公众号时开，英文版线只在勾了 YouTube 或 X 时开，
 * 英文发布包也只给勾了的那几个平台。改勾选只影响以后的派生，已派生的稿一条不删。
 *
 * 旧档案里的 `twitter` 只表示图文推（twitter-post 写作包），不再当成 `x` 打开英文视频线（创始人 2026-10-24，spec §9.3）：
 * 英文线要用户明确勾 `x` 或 `youtube`；只勾了 twitter 的档案在看板上出一次提示，让他自己选。
 */
import type { DerivationKind } from "../../storage/local-store.js";
import { kitPlatformsFor, languageOf, videoPlatformsFor, type PlatformId } from "../publish/platform-caps.js";

/** 档案里的平台列表归一：去空、去重保序；字符串化的数组也认（模型参数的老毛病）。不改名：twitter 就是 twitter */
export function normalizeProfilePlatforms(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { list = raw.split(/[,，、\s]+/); }
  }
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string" || !v.trim()) continue;
    const id = v.trim();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function enabledPlatforms(profile: { platforms?: unknown } | null | undefined): string[] {
  return normalizeProfilePlatforms(profile?.platforms);
}

/** 英文发布包要出的平台：勾了的英文视频平台 */
export function enKitPlatforms(profile: { platforms?: unknown } | null | undefined): PlatformId[] {
  const on = enabledPlatforms(profile);
  return videoPlatformsFor("en").filter((p) => on.includes(p));
}

/** 这条稿可以交哪些平台的发布包：中文稿 = 四个中文视频平台（不看勾选，行为不变）；英文版 = 只给勾了的英文平台 */
export function allowedKitPlatforms(contentPlatform: string | null | undefined, profile: { platforms?: unknown } | null | undefined): string[] {
  return languageOf(contentPlatform) === "en" ? enKitPlatforms(profile) : kitPlatformsFor(contentPlatform);
}

export function lineEnabled(profile: { platforms?: unknown } | null | undefined, line: DerivationKind): boolean {
  return lineRefusal(profile, line) === null;
}

/** 这条线没开的人话原因；开着 = null */
export function lineRefusal(profile: { platforms?: unknown } | null | undefined, line: DerivationKind): string | null {
  if (line === "wechat_article") {
    return enabledPlatforms(profile).includes("wechat_mp") ? null : "你还没勾「公众号」：公众号文章线没开。要做的话先到设置里把公众号勾上";
  }
  return enKitPlatforms(profile).length ? null : "你还没勾 YouTube 或 X：英文版线没开。要做的话先到设置里勾上要发的英文平台";
}

/** 勾了旧的 twitter、却没勾 X / YouTube：英文视频线没开，提示他明确选一次；不需要提示 = null */
export function legacyTwitterPrompt(profile: { platforms?: unknown } | null | undefined): string | null {
  const on = enabledPlatforms(profile);
  if (!on.includes("twitter") || on.includes("x") || on.includes("youtube")) return null;
  return "你勾的「推特」现在只管图文推。要把视频做成英文版发 X 或 YouTube，到「校准 → 席位」里明确勾上 X 或 YouTube；不需要就关掉这条。";
}
