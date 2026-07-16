/**
 * X (Twitter) source via twitterapi.io —— 第三方付费 X API(官方 API 太贵且限制多)。
 * queryType=Top 直接要人气帖;likeCount 当 heat(与 GitHub stars / HN points 同性质:
 * 真实互动信号,喂给雷达的源内热度归一)。key 是 bring-your-own-key,存在 publish.json
 * 的 wechatMp.xApiKey,同 image-gen 的自带 key 模式。
 *
 * 失败(无 key / HTTP 错)抛错 → 由 radar 归入 failedSources 上报,不静默返回空(§6 红线)。
 */
import type { SourceItem } from "./types.js";

export interface XDeps {
  /** twitterapi.io key;缺省从调用侧透传。 */
  apiKey?: string;
  /** 注入用于测试;默认 global fetch。 */
  fetchImpl?: typeof fetch;
}

const ENDPOINT = "https://api.twitterapi.io/twitter/tweet/advanced_search";
// 赞数下限:低于此的多是碎碎念/自言自语,雷达要的是有共识度的高信号帖。
// 既推进查询(min_faves),又在下面兜底过滤(操作符被忽略时仍生效)。
const MIN_LIKES = 50;

interface XTweet {
  text?: string;
  url?: string;
  id?: string;
  author?: { userName?: string };
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
}

export async function fetchX(keyword: string, limit = 10, deps: XDeps = {}): Promise<SourceItem[]> {
  const apiKey = deps.apiKey ?? "";
  if (!apiKey) throw new Error("twitterapi.io key 未配置(设置→发布填 x_api_key)");
  if (!keyword) return [];
  const fetchFn = deps.fetchImpl ?? fetch;

  // Latest + min_faves:N → 近期且有共识度的帖。实测 queryType=Top 对多数关键词返回空/不稳,
  // Latest 配 min_faves 才稳定拿到"新鲜且高赞";-filter 去回复与转推噪声。
  const query = `${keyword} min_faves:${MIN_LIKES} -filter:replies -filter:retweets`;
  const url = `${ENDPOINT}?queryType=Latest&query=${encodeURIComponent(query)}`;

  const res = await fetchFn(url, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`twitterapi.io HTTP ${res.status}`);

  const data = (await res.json()) as { tweets?: XTweet[] };
  const tweets = Array.isArray(data.tweets) ? data.tweets : [];
  return tweets
    .filter((t) => (t.likeCount ?? 0) >= MIN_LIKES && !!t.text && !!t.url)
    .slice(0, limit)
    .map((t): SourceItem => {
      const likes = t.likeCount ?? 0;
      const rts = t.retweetCount ?? 0;
      return {
        title: t.text!.replace(/\s+/g, " ").trim().slice(0, 120),
        url: t.url!,
        source: "x",
        heat: likes,
        summary: `@${t.author?.userName ?? "?"} · ❤${likes} · 🔁${rts}`,
      };
    });
}
