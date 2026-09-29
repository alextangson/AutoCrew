/**
 * 平台 → 封面上传槽（后端单一事实源；frontend/src/lib.ts 的 COVER_RATIOS_BY_PLATFORM 与此同源同值，改动两边同步）。
 * 语义是「这个平台发布时要上传哪几个比例的封面」，首项 = 默认主比例。
 *
 * 创始人 2026-09-29（发布前把关 spec §3）：小红书 3:4；抖音、视频号 3:4+4:3；
 * B站只传 4:3，16:9「个人空间封面」框由平台从 4:3 裁出——另列一项「16:9 裁切核对」（见 COVER_CROP_CHECKS），
 * 取代 07-12 的 ["16:9","4:3"]。公众号只 2.35:1。封面生成仍只出 3:4+4:3。
 * 账号资料 `creator-profile.coverRatios` 可覆盖（发布前把关读 effectiveCoverRatios）。
 */
export const COVER_RATIOS_BY_PLATFORM: Record<string, string[]> = {
  wechat_mp: ["2.35:1"],
  xiaohongshu: ["3:4"],
  wechat_video: ["3:4", "4:3"],
  douyin: ["3:4", "4:3"],
  bilibili: ["4:3"],
};

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
