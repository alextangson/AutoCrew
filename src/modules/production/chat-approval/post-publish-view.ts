/**
 * 发布后的确认在对话里定（spec 2026-10-06 proactive-chat-review，Addendum 3）：
 * publish_claim「X 说已经发了」、published_ask「发了吗」。brief 服务端写；作品链接的域名要对得上平台。
 */
import { platformLabel } from "../../publish/review-gate/platforms.js";
import type { InboxItem } from "../inbox.js";

export const NO_URL = "没给作品链接，去平台上看一眼";

/** 平台 → 作品链接可能的域名（含短链，含子域）；视频号只认 channels 子域和 weixin.qq.com/sph/ 短链，公众号文章（mp.weixin.qq.com）不算 */
const HOSTS: Record<string, string[]> = {
  douyin: ["douyin.com", "iesdouyin.com"],
  xiaohongshu: ["xiaohongshu.com", "xhslink.com"],
  wechat_video: ["channels.weixin.qq.com"],
  bilibili: ["bilibili.com", "b23.tv"],
};
const hostOk = (platform: string, u: URL, h: string) =>
  HOSTS[platform].some((d) => h === d || h.endsWith(`.${d}`)) || (platform === "wechat_video" && h === "weixin.qq.com" && u.pathname.startsWith("/sph/"));

/**
 * 能指认一件作品的链接（AI 回执直接认用，2026-10-11）：主页 / 上传页 / 登录页 / 创作者中心都不算。
 * 视频号没有可靠的作品链接形状：不靠链接直接认（报定时那条路照走）
 */
const WORK: Record<string, Array<{ host: string; path: RegExp }>> = {
  douyin: [{ host: "douyin.com", path: /^\/(video|note)\/\d+/ }, { host: "iesdouyin.com", path: /^\/share\/(video|note)\/\d+/ }, { host: "v.douyin.com", path: /^\/[A-Za-z0-9_-]+\/?$/ }],
  xiaohongshu: [{ host: "xiaohongshu.com", path: /^\/(explore|discovery\/item)\/[0-9a-fA-F]{8,}/ }, { host: "xhslink.com", path: /^\/(a\/|m\/)?[A-Za-z0-9_-]+\/?$/ }],
  bilibili: [{ host: "bilibili.com", path: /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/ }, { host: "b23.tv", path: /^\/[A-Za-z0-9_-]+\/?$/ }],
};

export function isWorkUrl(platform: string, raw: string): boolean {
  if (urlMismatch(platform, raw) !== null) return false;
  const u = new URL(raw.trim());
  const h = u.hostname.toLowerCase();
  return (WORK[platform] ?? []).some((w) => (h === w.host || h.endsWith(`.${w.host}`)) && w.path.test(u.pathname));
}

/** 链接和平台对不上 → 原因（agent 拿去问创始人）；对得上 → null。不认识的平台核不了，链接不收（Codex 审 P2） */
export function urlMismatch(platform: string, raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return `「${raw}」不是一个链接：问一下创始人作品链接是哪个`; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "作品链接只接受 http / https 开头的地址：问一下创始人";
  if (!HOSTS[platform]) return `${platformLabel(platform)}的作品链接核不了是不是这个平台的：这次先不带链接记「发了」，或者问一下创始人`;
  const h = u.hostname.toLowerCase();
  if (hostOk(platform, u, h)) return null;
  return `这个链接（${h}）不是${platformLabel(platform)}的作品链接：问一下创始人是不是贴错了，这次什么都没记`;
}

export function postPublishBrief(item: InboxItem): string {
  const d = item.detail;
  const who = platformLabel(String(d.platform));
  if (item.type === "published_ask") {
    return [`《${item.title}》待发布一天了，还没收到${who}的发布回执`, "要你判断：这条在这个平台上已经发出去了吗？", "回我「发了」（有作品链接就一起贴上）"].join("\n");
  }
  if (d.scheduled_overdue) {
    return [`《${item.title}》${String(d.reporter ?? "AI")}报了${who}定时发布，定时时间已过一天，还没核到公开`, "要你判断：发出去了吗？", "回我「对，发了」/「没发」"].join("\n");
  }
  const link = d.url ? `作品链接：${String(d.url)}` : d.item ? `作品 id：${String(d.item)}（${NO_URL}）` : NO_URL;
  return [
    `《${item.title}》${String(d.reporter ?? "有人")}说已经发了（${who}）`,
    link,
    ...(d.evidence ? [`依据：${String(d.evidence)}`] : []),
    "要你判断：真的发了吗？",
    "回我「对，发了」/「没发」",
  ].join("\n");
}
