/**
 * YouTube 关键词源 —— 「本周全站爆款」模式，与 youtube.ts 的频道订阅模式并存、互补。
 *
 * 为什么两个都要:频道清单答的是「我关注的这几个人这周讲了什么」,答不了「这周全站
 * 最火的 agent 视频是哪条」——本周前几名(IBM Technology、Tech With Tim)根本不在清单里,
 * 订阅模式永远看不到。洗稿选材要的正是后者。
 *
 * youtube.ts 头注释担心的 firehose(标题党、搬运号、几年前的老片挤进第一页)靠三道闸拦:
 * ① URL 带 sp=EgIIAw%3D%3D(YouTube 的 This week 过滤器)——老片进不来;
 * ② MIN_VIEWS 播放量下限——本周内没跑起来的小号噪音进不来;
 * ③ 跳过 Shorts 和直播——不是选题材料。
 * 剩下的相关性判断交给雷达排序的定位命中,和其余海外源一致。
 *
 * 走搜索结果页内嵌的 ytInitialData:公开只读、无 key、无配额(§6 不碰登录态),
 * 与 Atom feed 路径一样是 fetch + 正则,零依赖。前提同样是本机能直连 youtube.com。
 */
import type { SourceItem } from "./types.js";

/** YouTube「本周上传」过滤器的 protobuf 编码;换成别的窗口这串就得跟着换 */
const THIS_WEEK = "EgIIAw%3D%3D";
const SEARCH_BASE = "https://www.youtube.com/results";
const REQ_TIMEOUT_MS = 10_000;
// 同 youtube.ts:YouTube 对连续请求会零星回非 200,退避重试兜住,否则每轮随机空手而归
const RETRY = 2;
const RETRY_DELAY_MS = 300;
/** 本周播放量下限。低于这个的不算「爆款」,是噪音——洗稿选材的核心闸门。 */
const MIN_VIEWS = 20_000;
/** 短于这个的当 Shorts 跳过:竖屏切片不是选题材料 */
const MIN_DURATION_SEC = 60;

export interface YouTubeSearchDeps {
  /** 覆盖播放量下限;缺省 MIN_VIEWS。 */
  minViews?: number;
  /** 注入用于测试;默认 global fetch。 */
  fetchImpl?: typeof fetch;
}

interface RawVideo {
  title: string;
  channel: string;
  views: number;
  durationSec: number;
  published: string;
  videoId: string;
}

/** 只声明我们真正读的字段——写出来就是这个源对 YouTube 页面结构的全部依赖面。 */
interface VideoRenderer {
  videoId?: string;
  title?: { runs?: Array<{ text?: string }>; simpleText?: string };
  ownerText?: { runs?: Array<{ text?: string }> };
  longBylineText?: { runs?: Array<{ text?: string }> };
  viewCountText?: { simpleText?: string };
  lengthText?: { simpleText?: string };
  publishedTimeText?: { simpleText?: string };
}

/** SOCS=CAI 跳过同意页;UA 缺失时 YouTube 会回不带 ytInitialData 的精简页 */
const HEADERS: Record<string, string> = {
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  cookie: "SOCS=CAI;",
};

/** "9:11" → 551;"1:02:33" → 3753;空/异常 → 0(调用方据此跳过直播和 upcoming) */
function parseDuration(text: string): number {
  if (!text) return 0;
  const parts = text.split(":").map((p) => Number(p.trim()));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** "91,832 views" → 91832;没有数字 → 0 */
function parseViews(text: string): number {
  const m = text.match(/[\d,]+/);
  return m ? Number(m[0].replace(/,/g, "")) || 0 : 0;
}

/**
 * 递归捞出响应里所有 videoRenderer。搜索结果分散在 sectionList/shelf 等多层容器里,
 * 层级结构 YouTube 常改,按 key 名深搜比按固定路径取稳。
 */
function collectVideos(node: unknown, out: RawVideo[]): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const vr = obj.videoRenderer as VideoRenderer | undefined;
  if (vr) {
    const title = vr.title?.runs?.[0]?.text ?? vr.title?.simpleText ?? "";
    const videoId = vr.videoId ?? "";
    if (title && videoId) {
      out.push({
        title,
        channel: vr.ownerText?.runs?.[0]?.text ?? vr.longBylineText?.runs?.[0]?.text ?? "",
        views: parseViews(vr.viewCountText?.simpleText ?? ""),
        durationSec: parseDuration(vr.lengthText?.simpleText ?? ""),
        published: vr.publishedTimeText?.simpleText ?? "",
        videoId,
      });
    }
    return;
  }
  for (const v of Object.values(obj)) collectVideos(v, out);
}

/** 从搜索页 HTML 抠出 ytInitialData;抠不到返回 null(调用方抛错,不静默空跑) */
function extractInitialData(html: string): unknown | null {
  const patterns = [
    /var ytInitialData\s*=\s*(\{[\s\S]*?\});<\/script>/,
    /window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});<\/script>/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    try {
      return JSON.parse(m[1]);
    } catch {
      /* 下一个变体 */
    }
  }
  return null;
}

/** 拉搜索页原文;非 2xx/网络错退避重试,仍失败回 null。 */
async function fetchSearchPage(keyword: string, fetchFn: typeof fetch): Promise<string | null> {
  const url = `${SEARCH_BASE}?search_query=${encodeURIComponent(keyword)}&sp=${THIS_WEEK}`;
  for (let attempt = 0; attempt <= RETRY; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * RETRY_DELAY_MS));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    try {
      const res = await fetchFn(url, { headers: HEADERS, signal: ctrl.signal });
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
 * 按关键词搜本周视频,按播放量降序返回。
 * 关键词为空 → 抛错:没有词就等于抓全站首页,拿回来的是噪音不是选题材料。
 * 页面拉不到或结构变了(抠不出 ytInitialData) → 抛错,让上层记进 failedSources,
 * 不静默降级成「本周没爆款」。
 */
export async function fetchYouTubeSearch(
  keyword: string,
  limit = 10,
  deps: YouTubeSearchDeps = {},
): Promise<SourceItem[]> {
  const kw = keyword.trim();
  if (!kw) throw new Error("YouTube 关键词源需要检索词(配 config.keyword 或档案 focusKeywords)");

  const fetchFn = deps.fetchImpl ?? fetch;
  const minViews = deps.minViews ?? MIN_VIEWS;

  const html = await fetchSearchPage(kw, fetchFn);
  if (html === null) throw new Error(`YouTube 搜索页没拉到:${kw}(本机到 youtube.com 不通?检查系统代理)`);

  const data = extractInitialData(html);
  if (data === null) throw new Error(`YouTube 搜索页解析失败:${kw}(页面结构可能变了)`);

  const raw: RawVideo[] = [];
  collectVideos(data, raw);

  return raw
    .filter((v) => v.views >= minViews)
    // 时长 0 = 直播/预告(没有 lengthText);短于 MIN_DURATION_SEC = Shorts
    .filter((v) => v.durationSec >= MIN_DURATION_SEC)
    // sp 过滤器兜住了时间窗,这里只拦明显漏网的(YouTube 偶尔在 shelf 里塞旧片)
    .filter((v) => !/year|month/i.test(v.published))
    .sort((a, b) => b.views - a.views)
    .slice(0, Math.max(limit, 20))
    .map((v): SourceItem => ({
      title: v.title.slice(0, 120),
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
      source: "youtube",
      heat: v.views,
      summary: `${v.channel} · ▶${v.views} · ${v.published} · 搜「${kw}」`,
    }));
}
