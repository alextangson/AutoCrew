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
    return [`《${item.title}》发了吗（${who}）`, "要你判断：这条在这个平台上已经发出去了吗？", "回我「发了」（有作品链接就一起贴上）"].join("\n");
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
