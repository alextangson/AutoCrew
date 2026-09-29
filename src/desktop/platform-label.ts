/** 平台 id → 中文名（与前端 lib.ts PLATFORM_CATALOG 同表）；认不出原样返回 */
const LABELS: Record<string, string> = {
  wechat_mp: "公众号", douyin: "抖音", xiaohongshu: "小红书", wechat_video: "视频号",
  bilibili: "B站", toutiao: "头条", twitter: "X (Twitter)", reddit: "Reddit", instagram: "Instagram",
};

export function platformLabel(p: string): string {
  return LABELS[p] ?? (p || "—");
}
