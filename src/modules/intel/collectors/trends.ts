import type { IntelItem } from "../../../storage/pipeline-store.js";
import type { Collector, CollectorOptions, CollectorResult } from "../collector.js";
import type { TrendSource } from "../source-config.js";
import { loadSourceConfig } from "../source-config.js";
import type { SearchFn, SearchResult } from "./web-search.js";

// ─── Platform Query Templates ───────────────────────────────────────────────

const PLATFORM_QUERY_MAP: Record<string, (src: TrendSource, keywords: string[]) => string> = {
  hackernews: (src, keywords) =>
    `Hacker News top stories today ${keywords.join(" ")}${src.min_score ? ` score>${src.min_score}` : ""}`,
  producthunt: (_src, keywords) =>
    `Product Hunt trending today ${keywords.join(" ")}`,
  github_trending: (_src, keywords) =>
    `GitHub trending repositories today ${keywords.join(" ")}`,
  weibo_hot: (_src, keywords) =>
    `微博热搜 今日 ${keywords.join(" ")}`,
  zhihu_hot: (_src, keywords) =>
    `知乎热榜 今日 ${keywords.join(" ")}`,
  douyin_hot: (_src, keywords) =>
    `抖音热榜 今日 ${keywords.join(" ")}`,
  bilibili_hot: (_src, keywords) =>
    `B站热搜 今日 ${keywords.join(" ")}`,
  toutiao_hot: (_src, keywords) =>
    `今日头条热榜 ${keywords.join(" ")}`,
  twitter_trending: (src, keywords) =>
    `Twitter trending${src.region ? ` ${src.region}` : ""} ${keywords.join(" ")}`,
  reddit: (src, keywords) => {
    const subs = src.subreddits?.length
      ? `r/${src.subreddits.join(" r/")}`
      : "";
    return `Reddit trending ${subs} ${keywords.join(" ")}`.trim();
  },
  google_trends: (_src, keywords) =>
    `Google Trends today ${keywords.join(" ")}`,
  arxiv: (src, keywords) => {
    const cats = src.categories?.length
      ? src.categories.join(" ")
      : "";
    return `arXiv latest papers ${cats} ${keywords.join(" ")}`.trim();
  },
  youtube_trending: (_src, keywords) =>
    `YouTube trending videos today ${keywords.join(" ")}`,
};

// ─── Query Builder ──────────────────────────────────────────────────────────

export function buildTrendQueries(
  sources: TrendSource[],
  keywords: string[],
): string[] {
  return sources
    .filter((src) => src.enabled !== false)
    .map((src) => {
      const buildQuery = PLATFORM_QUERY_MAP[src.source];
      if (!buildQuery) return `${src.source} trending ${keywords.join(" ")}`;
      return buildQuery(src, keywords);
    });
}

// ─── Trend Collector ────────────────────────────────────────────────────────

function trendResultToIntel(result: SearchResult, source: string): IntelItem {
  return {
    title: result.title,
    domain: source,
    source: "trend",
    sourceUrl: result.url,
    collectedAt: new Date().toISOString(),
    relevance: 50,
    tags: ["trend", source],
    expiresAfter: 7,
    summary: result.snippet,
    keyPoints: [],
    topicPotential: "",
  };
}

export function createTrendCollector(searchFn: SearchFn): Collector {
  return {
    id: "trend",
    async collect(opts: CollectorOptions): Promise<CollectorResult> {
      const config = await loadSourceConfig(opts.dataDir);
      const items: IntelItem[] = [];
      const errors: string[] = [];
      const seen = new Set<string>();

      const queries = buildTrendQueries(config.trends, opts.keywords);

      for (const query of queries) {
        try {
          const results = await searchFn(query);
          for (const result of results) {
            if (seen.has(result.url)) continue;
            seen.add(result.url);
            items.push(trendResultToIntel(result, "trend"));
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Trend query "${query}" failed: ${msg}`);
        }
      }

      return { items, source: "trend", errors };
    },
  };
}
