/**
 * Reddit 社区源 —— 清单型(非关键词搜索),理由同 x.ts:关键词搜 Reddit 捞的是全站噪声,
 * 选题价值在「这几个社区今天在吵什么」。keyword 参数忽略,相关性交给雷达排序的定位命中。
 *
 * 为什么必须带凭据:Reddit 的匿名 JSON/RSS(www/old/api)已被指纹级反爬全面挡死
 * (403 或 302 到登录墙),2026-08 实测唯一可靠路径是官方 OAuth app-only ——
 * POST /api/v1/access_token 拿 app token(Basic base64(id:secret) + 自定义 UA),
 * 再用 Bearer 打 oauth.reddit.com。凭据是 bring-your-own(reddit.com/prefs/apps 建
 * 一个 "script" 应用即可,免费),存 publish.json 的 wechatMp,与 X 源的 key 同级。
 *
 * token 有效期按小时算,模块级缓存复用——每轮扫榜重新取 token 是白费一次请求,
 * 也更容易撞限流。
 */
import type { SourceItem } from "./types.js";

export interface RedditDeps {
  /** OAuth app 的 client id(reddit.com/prefs/apps) */
  clientId?: string;
  /** OAuth app 的 secret */
  clientSecret?: string;
  /** 覆盖默认社区清单;缺省用内置。 */
  subreddits?: string[];
  /** 注入用于测试;默认 global fetch。 */
  fetchImpl?: typeof fetch;
}

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";
// Reddit 明确要求自报家门的 UA,用默认 UA 的请求会被直接掐掉
const USER_AGENT = "macos:autocrew:1.0 (topic radar)";
const REQ_TIMEOUT_MS = 10_000;
// 分数下限:滤掉沉底的自问自答,留当天有共识度的帖
const MIN_SCORE = 30;
// 提前 60s 让 token 过期,免得卡在边界上拿着刚失效的 token 发请求
const TOKEN_SKEW_MS = 60_000;

/** FDE + AI 前沿社区。改这里即改订阅对象。 */
export const DEFAULT_SUBREDDITS = ["LocalLLaMA", "ClaudeAI", "ChatGPTCoding", "OpenAI", "MachineLearning"];

interface RedditPost {
  title?: string;
  permalink?: string;
  subreddit?: string;
  score?: number;
  num_comments?: number;
  stickied?: boolean;
  selftext?: string;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

/** 统一的单请求超时:凭据错/被限流时不能挂在那儿等 */
async function withTimeout(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** app-only token:命中缓存直接用,否则换新的。失败照抛(凭据错要看得见,不静默降级)。 */
async function getToken(clientId: string, clientSecret: string, fetchFn: typeof fetch): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await withTimeout((signal) =>
    fetchFn(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: "grant_type=client_credentials",
      signal,
    }),
  );
  if (!res.ok) throw new Error(`Reddit 取 token 失败(HTTP ${res.status})——检查 Client ID/Secret`);
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!data?.access_token) throw new Error("Reddit 取 token 失败:响应里没有 access_token");
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max((data.expires_in ?? 3600) * 1000 - TOKEN_SKEW_MS, 0),
  };
  return tokenCache.token;
}

function toItem(post: RedditPost): SourceItem {
  const score = post.score ?? 0;
  const text = (post.selftext ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  return {
    title: (post.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    url: `https://www.reddit.com${post.permalink}`,
    source: "reddit",
    heat: score,
    summary: `r/${post.subreddit ?? "?"} · ⬆${score} · 💬${post.num_comments ?? 0}${text ? ` ${text}` : ""}`,
  };
}

/**
 * 拉合并 subreddit 的当日热帖(一次请求搞定:/r/a+b+c/top?t=day)。
 * 无凭据 → 抛错(由 radar 归入 failedSources,不静默);HTTP 非 2xx 也抛,
 * 带上 status —— 凭据失效/被限流必须在源清单上看得见。
 */
export async function fetchReddit(limit = 10, deps: RedditDeps = {}): Promise<SourceItem[]> {
  const clientId = deps.clientId ?? "";
  const clientSecret = deps.clientSecret ?? "";
  if (!clientId || !clientSecret) throw new Error("Reddit API 凭据未配置(设置→情报源填 Client ID/Secret)");
  const subs = deps.subreddits?.length ? deps.subreddits : DEFAULT_SUBREDDITS;
  const fetchFn = deps.fetchImpl ?? fetch;

  const token = await getToken(clientId, clientSecret, fetchFn);
  const url = `${API_BASE}/r/${subs.map(encodeURIComponent).join("+")}/top?t=day&limit=25&raw_json=1`;
  const res = await withTimeout((signal) =>
    fetchFn(url, { headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT }, signal }),
  );
  if (!res.ok) {
    if (res.status === 401) tokenCache = null; // 缓存的 token 被判死 → 丢掉,下轮重取
    throw new Error(`Reddit 拉取失败(HTTP ${res.status})`);
  }
  const payload = (await res.json().catch(() => null)) as { data?: { children?: Array<{ data?: RedditPost }> } } | null;
  return (payload?.data?.children ?? [])
    .map((c) => c.data)
    .filter((p): p is RedditPost => !!p?.title && !!p.permalink && !p.stickied && (p.score ?? 0) >= MIN_SCORE)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, Math.max(limit, 20))
    .map(toItem);
}
