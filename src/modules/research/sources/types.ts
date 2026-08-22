/**
 * Overseas research sources — autocrew's own multi-source intel layer.
 *
 * Structure mirrors sentinel's fetch_news.py: a registry of per-source fetchers,
 * each pulling from a public API/RSS and returning a uniform SourceItem.
 * No openclaw/python dependency — pure TS, ships with autocrew.
 */

export interface SourceItem {
  /** Headline / story title */
  title: string;
  /** Canonical link */
  url: string;
  /** Source key, e.g. "hackernews" */
  source: string;
  /** Real engagement signal (e.g. HN points). Feeds viral scoring as true heat. */
  heat?: number;
  /** Short human-readable context, e.g. "512 points · 200 comments" */
  summary?: string;
}

/** 运行时传给 fetcher 的密钥等(如 x 源的 twitterapi.io key);不需要的源忽略。 */
export interface FetchOptions {
  /** twitterapi.io API key,仅 `x` 源使用(bring-your-own-key);其余源忽略。 */
  xApiKey?: string;
  /** Reddit OAuth app client id,仅 `reddit` 源使用(匿名接口被反爬挡死,必须走 OAuth)。 */
  redditClientId?: string;
  /** Reddit OAuth app secret,仅 `reddit` 源使用。 */
  redditClientSecret?: string;
}

/** A source fetcher pulls recent items for a keyword. */
export type SourceFetcher = (keyword: string, limit: number, opts?: FetchOptions) => Promise<SourceItem[]>;
