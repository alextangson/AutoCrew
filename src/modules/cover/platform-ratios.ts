/**
 * 平台 → 封面比例(后端单一事实源;frontend/src/lib.ts 的 COVER_RATIOS_BY_PLATFORM 与此同源同值,改动两边同步)。
 * 首项 = 默认主比例。创始人裁决 2026-07-12:短视频(抖音)封面同时要 3:4 与 4:3;公众号只 2.35:1。
 */
export const COVER_RATIOS_BY_PLATFORM: Record<string, string[]> = {
  wechat_mp: ["2.35:1"],
  xiaohongshu: ["3:4"],
  wechat_video: ["3:4"],
  douyin: ["3:4", "4:3"],
  bilibili: ["16:9", "4:3"],
};

export function coverRatiosForPlatform(platform?: string | null): string[] {
  return COVER_RATIOS_BY_PLATFORM[platform ?? ""] ?? ["3:4", "16:9", "4:3"];
}
