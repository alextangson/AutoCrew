/**
 * 平台 → 封面上传槽（frontend/src/lib.ts 的 PLATFORM_CAPS 镜像同值，platform-caps.test 核对）。
 * 语义是「这个平台发布时要上传哪几个比例的封面」，首项 = 默认主比例。
 *
 * 创始人 2026-09-29（发布前把关 spec §3）：小红书 3:4；抖音、视频号 3:4+4:3；
 * B站只传 4:3，16:9「个人空间封面」框由平台从 4:3 裁出——另列一项「16:9 裁切核对」（见 COVER_CROP_CHECKS），
 * 取代 07-12 的 ["16:9","4:3"]。公众号只 2.35:1。封面生成仍只出 3:4+4:3。
 * 账号资料 `creator-profile.coverRatios` 可覆盖（发布前把关读 effectiveCoverRatios）。
 * 数字住在平台能力表（modules/publish/platform-caps）；YouTube / X 只传 16:9。
 */
import { PLATFORM_CAPS, PLATFORM_IDS } from "../publish/platform-caps.js";
export const COVER_RATIOS_BY_PLATFORM: Record<string, string[]> = Object.fromEntries(PLATFORM_IDS.map((p) => [p, [...PLATFORM_CAPS[p].coverRatios]]));

/**
 * 平台上传界面能收的封面比例（设置页 / 偏好提议只能在这里面选；默认表是其中的子集）。
 * 小红书 3:4 / 4:3 / 1:1；抖音、视频号 3:4 / 4:3；B站 4:3 / 16:9；公众号 2.35:1；YouTube / X 16:9。
 */
export const ALLOWED_COVER_SLOTS: Record<string, string[]> = Object.fromEntries(PLATFORM_IDS.map((p) => [p, [...PLATFORM_CAPS[p].coverSlots]]));

/** 不在这个平台上传槽里的比例（空 = 都合法） */
export function invalidSlotRatios(platform: string, ratios: string[]): string[] {
  const allowed = ALLOWED_COVER_SLOTS[platform];
  return allowed ? ratios.filter((r) => !allowed.includes(r)) : [];
}

/** 平台自己从上传封面裁出的框：不上传，但发布时要在平台弹窗里核对标题没被切掉并截图 */
export const COVER_CROP_CHECKS: Record<string, string[]> = {
  bilibili: ["16:9 裁切核对：B站封面设置里的 16:9「个人空间封面」框由平台从 4:3 裁出，在该弹窗里确认标题没被切掉并截图留证"],
};

export function coverRatiosForPlatform(platform?: string | null): string[] {
  return COVER_RATIOS_BY_PLATFORM[platform ?? ""] ?? ["3:4", "16:9", "4:3"];
}

/** 账号资料的覆盖优先；没有覆盖就用默认表 */
export function effectiveCoverRatios(platform: string, overrides?: Record<string, string[]> | null): string[] {
  const own = overrides?.[platform];
  return Array.isArray(own) && own.length > 0 ? own : coverRatiosForPlatform(platform);
}

/** "3:4" → 0.75；认不出返回 null */
export function ratioValue(ratio: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio.trim());
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}
