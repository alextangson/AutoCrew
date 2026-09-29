/**
 * 平台名词表（发布前把关 spec §4）：原话 / 指令里点名的平台按这张表认（含中英文别名），代码匹配，不问模型。
 */
export const GATE_PLATFORMS = ["douyin", "xiaohongshu", "wechat_video", "bilibili"] as const;
export type GatePlatform = (typeof GATE_PLATFORMS)[number];

export const PLATFORM_LABEL: Record<GatePlatform, string> = {
  douyin: "抖音", xiaohongshu: "小红书", wechat_video: "视频号", bilibili: "B站",
};

/** 别名（小写比较）；长的在前，免得「小红书」先被别的短词吃掉 */
const ALIASES: Array<[string, GatePlatform]> = [
  ["xiaohongshu", "xiaohongshu"], ["小红书", "xiaohongshu"], ["rednote", "xiaohongshu"], ["xhs", "xiaohongshu"], ["红书", "xiaohongshu"],
  ["wechat_video", "wechat_video"], ["shipinhao", "wechat_video"], ["channels", "wechat_video"], ["视频号", "wechat_video"],
  ["bilibili", "bilibili"], ["哔哩哔哩", "bilibili"], ["b站", "bilibili"], ["b 站", "bilibili"],
  ["douyin", "douyin"], ["tiktok", "douyin"], ["抖音", "douyin"],
];

/** 计划里的平台值 → 规范名；认不出返回 null */
export function normalizePlatform(raw: unknown): GatePlatform | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return ALIASES.find(([alias]) => alias === v)?.[1] ?? null;
}

/** 一段文字里点名的平台（去重、按首次出现排序） */
export function platformsNamedIn(text: string): GatePlatform[] {
  const lower = text.toLowerCase();
  const hits: Array<[number, GatePlatform]> = [];
  for (const [alias, p] of ALIASES) {
    const at = lower.indexOf(alias);
    if (at >= 0 && !hits.some(([, q]) => q === p)) hits.push([at, p]);
  }
  return hits.sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

export function platformLabel(p: string): string {
  return PLATFORM_LABEL[p as GatePlatform] ?? p;
}
