/**
 * YouTube 频道源 —— 关注清单模式(非关键词搜索),理由同 x.ts。
 * 关键词搜 YouTube 是全站 firehose:标题党、搬运号、几年前的老片都能挤进第一页;
 * 我们要的选题材料是「这几个人这周讲了什么」,频道本身就是质量过滤。keyword 参数忽略——
 * 相关性交给雷达排序的定位命中。
 *
 * 走频道 Atom feed(youtube.com/feeds/videos.xml?channel_id=UC...):公开只读、无 key、
 * 无配额,合规上等同订阅 RSS(§6 不碰登录态)。**前提:本机能直连 youtube.com**——
 * App 自己不配代理,大陆网络下靠系统级代理接管路由;个别频道拉不到(网络抖动/频道关了
 * feed 会 404)隔离成空,全线不通则整源抛错 → failedSources 里看得见,不静默变"今天没视频"。
 *
 * 清单里的 channel_id 都是 2026-08 用真实 feed 逐个验证过的(feed <title> 与频道名对得上)。
 */
import type { SourceItem } from "./types.js";

export interface YouTubeChannel {
  /** UC 开头的频道 ID(feed 只认它,@handle 不行) */
  id: string;
  /** 显示名,进 summary 让人一眼知道是谁 */
  name: string;
}

export interface YouTubeDeps {
  /** 覆盖默认频道清单;缺省用内置。 */
  channels?: YouTubeChannel[];
  /** 注入用于测试;默认 global fetch。 */
  fetchImpl?: typeof fetch;
}

const FEED_BASE = "https://www.youtube.com/feeds/videos.xml?channel_id=";
// 单请求超时:一个频道拉不动不能拖垮整轮扫榜
const REQ_TIMEOUT_MS = 8_000;
// 实测同一个频道 ID 会零星回 404/500,隔几百毫秒再打就 200——是 YouTube 对连续请求的
// 节流/边缘节点抖动,不是频道没了(换 UA 无效,验证过)。不重试就会每轮随机丢几个频道,
// 看起来像"这周没人更新"。重试三次退避着打;真被节流狠了就少收几个频道,下轮 TTL 到期再补。
const RETRY = 2;
const RETRY_DELAY_MS = 300;
// 每频道最多取几条,防大频道(Fireship 一周好几条百万播放)刷屏——对齐 x.ts 的 PER_ACCOUNT
const PER_CHANNEL = 2;
// 只要近 7 天的:更早的视频不是选题时效材料
const MAX_AGE_MS = 7 * 24 * 3600_000;

/** FDE + AI 前沿频道清单(feed 已实测可达)。改这里即改订阅对象。 */
export const DEFAULT_YOUTUBE_CHANNELS: YouTubeChannel[] = [
  { id: "UCsBjURrPoezykLs9EqgamOA", name: "Fireship" },
  { id: "UCNJ1Ymd5yFuUPtn21xtRbbw", name: "AI Explained" },
  { id: "UCawZsQWqfGSbCI5yjkdVkTA", name: "Matthew Berman" },
  { id: "UCbRP3c757lWg9M-U7TyEkXA", name: "Theo - t3.gg" },
  { id: "UCrDwWp7EBBv4NwvScIpBDOA", name: "Anthropic" },
];

interface AtomEntry {
  title: string;
  url: string;
  views: number;
  publishedAt: number;
  description: string;
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (m) => ENTITY_MAP[m] ?? m);
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : "";
}

/** entry 的正片链接在 <link rel="alternate" href="..."/> 的属性里(Atom 与 RSS 的关键差别) */
function entryLink(entry: string): string {
  for (const m of entry.matchAll(/<link\b[^>]*>/gi)) {
    if (/rel="[^"]*"/i.test(m[0]) && !/rel="alternate"/i.test(m[0])) continue;
    const href = m[0].match(/href="([^"]+)"/i);
    if (href) return decodeEntities(href[1]);
  }
  return "";
}

/** Atom 子集解析(零依赖正则;源不规范/返回 HTML 时安全降级为空数组) */
function parseAtomEntries(xml: string): AtomEntry[] {
  const entries: AtomEntry[] = [];
  for (const m of xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? []) {
    const title = tag(m, "title");
    const url = entryLink(m);
    if (!title || !url) continue;
    const published = new Date(tag(m, "published"));
    const views = Number(m.match(/<media:statistics\b[^>]*views="(\d+)"/i)?.[1] ?? 0);
    entries.push({
      title,
      url,
      views,
      publishedAt: isNaN(published.getTime()) ? 0 : published.getTime(),
      description: tag(m, "media:description").slice(0, 140),
    });
  }
  return entries;
}

/** 拉一份 feed 原文;非 2xx/网络错退避重试(见 RETRY 注释),仍失败回 null。 */
async function fetchFeed(channelId: string, fetchFn: typeof fetch): Promise<string | null> {
  for (let attempt = 0; attempt <= RETRY; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * RETRY_DELAY_MS));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${FEED_BASE}${encodeURIComponent(channelId)}`, { signal: ctrl.signal });
      if (res.ok) return await res.text();
    } catch {
      /* abort/网络错 → 重试 */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * 拉单频道 feed → 近 7 天视频按播放量取前 N。
 * 返回 null = 这个频道没拉到(网络/超时/重试后仍非 200);[] = 拉到了但本周没新片——
 * 两者必须分开,否则"全线不通"和"这周大家都没更"看起来一模一样。
 */
async function fetchChannel(ch: YouTubeChannel, fetchFn: typeof fetch): Promise<SourceItem[] | null> {
  const xml = await fetchFeed(ch.id, fetchFn);
  if (xml === null) return null;
  const now = Date.now();
  return parseAtomEntries(xml)
    .filter((e) => now - e.publishedAt <= MAX_AGE_MS)
    .sort((a, b) => b.views - a.views)
    .slice(0, PER_CHANNEL)
    .map((e): SourceItem => ({
      title: e.title.slice(0, 120),
      url: e.url,
      source: "youtube",
      heat: e.views,
      summary: `${ch.name} · ▶${e.views}${e.description ? ` ${e.description}` : ""}`,
    }));
}

/**
 * 并发拉全部频道,按播放量汇总。feed 是静态 XML,一轮就 5 个请求,不像 twitterapi.io 那样
 * 必须顺序排队;YouTube 对连续请求的节流由 fetchFeed 的退避重试兜着。
 * 全部频道都没拉到 → 抛错(多半是本机到 YouTube 不通),让上层记进 failedSources。
 */
export async function fetchYouTube(limit = 10, deps: YouTubeDeps = {}): Promise<SourceItem[]> {
  const channels = deps.channels?.length ? deps.channels : DEFAULT_YOUTUBE_CHANNELS;
  const fetchFn = deps.fetchImpl ?? fetch;

  const results = await Promise.all(channels.map((ch) => fetchChannel(ch, fetchFn)));
  if (results.every((r) => r === null)) {
    throw new Error("YouTube 全部频道都没拉到(本机到 youtube.com 不通?检查系统代理)");
  }
  return results
    .flatMap((r) => r ?? [])
    .sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0))
    .slice(0, Math.max(limit, 20));
}
