/**
 * X (Twitter) source via twitterapi.io —— 关注清单模式(非关键词搜索)。
 * 关键词搜 X 是全球 firehose、噪声高(股票 spam 蹭热词也能进);X 的选题价值在"特定的人
 * 说了什么"。所以从一批高信号账号拉最新原创帖:likeCount 当 heat,转推/回复剔除,单账号
 * 失败隔离(接口抖动是常态)。key 是 bring-your-own-key,存 publish.json 的 wechatMp.xApiKey。
 *
 * 关注清单 = FDE + AI 前沿(2026-07 用 twitterapi.io 逐个验证真实活跃)。keyword 参数忽略——
 * 相关性交给雷达排序的定位命中,账号本身就是质量过滤。
 */
import type { SourceItem } from "./types.js";

export interface XDeps {
  /** twitterapi.io key。 */
  apiKey?: string;
  /** 覆盖默认关注清单(handle 数组,不含 @);缺省用内置清单。 */
  accounts?: string[];
  /** 注入用于测试;默认 global fetch。 */
  fetchImpl?: typeof fetch;
}

const ENDPOINT = "https://api.twitterapi.io/twitter/user/last_tweets";
// 赞数下限:滤掉这些人的随手一句/闲聊,留有共识度的观点。账号已是质量过滤,门槛可低。
const MIN_LIKES = 30;
// 每账号最多取几条,防大号(如 karpathy 动辄两万赞)刷屏、保证账号多样性。
const PER_ACCOUNT = 2;
// twitterapi.io 只吃顺序请求——实测并发 2/3 全被限流返空,顺序才拿得到。故顺序拉 + 单请求
// 超时(防单账号挂死拖垮预算) + 总预算封顶(扫榜不能卡);单账号空/错重试一次。
const RETRY = 1;
const REQ_TIMEOUT_MS = 8_000;
const BUDGET_MS = 22_000;

/**
 * FDE + AI 前沿关注清单(handle 不含 @)。改这里即改关注对象。
 * 精简到 10 个:provider 只吃顺序请求,账号越多单轮越慢;漏掉的账号下一轮扫榜补上。
 */
export const DEFAULT_X_ACCOUNTS = [
  // AI 前沿:研究者 / 一线构建者
  "karpathy", "simonw", "emollick", "sama", "gdb", "alexalbert__",
  // FDE 话题活跃
  "swyx", "garrytan", "AndrewYNg", "saranormous",
];

interface XTweet {
  text?: string;
  url?: string;
  likeCount?: number;
  retweetCount?: number;
}

/**
 * 拉单个账号的近期原创帖 → 取高赞前 N 条。
 * 单请求超时(防挂死);限流/错/空重试一次(空多为限流);仍失败吞成 []，不拖垮整体。
 */
async function fetchAccount(handle: string, apiKey: string, fetchFn: typeof fetch): Promise<SourceItem[]> {
  const url = `${ENDPOINT}?userName=${encodeURIComponent(handle)}`;
  for (let attempt = 0; attempt <= RETRY; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    try {
      const res = await fetchFn(url, { headers: { "X-API-Key": apiKey }, signal: ctrl.signal });
      if (!res.ok) continue; // 限流(429)/错 → 重试
      const payload = (await res.json().catch(() => null)) as { data?: { tweets?: XTweet[] } } | null;
      const tweets = payload?.data?.tweets;
      // 拿到非空帖列表才算成功;空/缺多为限流 → 落到重试
      if (Array.isArray(tweets) && tweets.length > 0) {
        return tweets
          .filter((t) => !!t.text && !!t.url && !t.text.startsWith("RT @") && (t.likeCount ?? 0) >= MIN_LIKES)
          .sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
          .slice(0, PER_ACCOUNT)
          .map((t): SourceItem => {
            const likes = t.likeCount ?? 0;
            return {
              title: t.text!.replace(/\s+/g, " ").trim().slice(0, 120),
              url: t.url!,
              source: "x",
              heat: likes,
              summary: `@${handle} · ❤${likes} · 🔁${t.retweetCount ?? 0}`,
            };
          });
      }
    } catch {
      /* abort/网络错 → 重试 */
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

/**
 * 从关注清单顺序拉高信号原创帖,按赞数汇总返回。
 * 无 key → 抛错(由 radar 归入 failedSources,不静默);单账号失败隔离。
 * 顺序拉(provider 限并发) + 总预算封顶——预算到就停,已收集的照常返回,漏的下轮补。
 */
export async function fetchX(limit = 10, deps: XDeps = {}): Promise<SourceItem[]> {
  const apiKey = deps.apiKey ?? "";
  if (!apiKey) throw new Error("twitterapi.io key 未配置(设置→情报源填 X 源 Key)");
  const accounts = deps.accounts?.length ? deps.accounts : DEFAULT_X_ACCOUNTS;
  const fetchFn = deps.fetchImpl ?? fetch;

  const deadline = Date.now() + BUDGET_MS;
  const collected: SourceItem[] = [];
  for (const handle of accounts) {
    collected.push(...(await fetchAccount(handle, apiKey, fetchFn)));
    if (Date.now() > deadline) break;
  }
  return collected.sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0)).slice(0, Math.max(limit, 20));
}
