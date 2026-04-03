import type { IntelItem } from "../../../storage/pipeline-store.js";
import type { Collector, CollectorOptions, CollectorResult } from "../collector.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchFn = (query: string) => Promise<SearchResult[]>;

// ─── Query Builder ──────────────────────────────────────────────────────────

export function buildMultiDimensionQueries(
  keyword: string,
  industry: string,
  platforms: string[],
): string[] {
  const queries: string[] = [
    `${keyword} ${industry} 行业动态 最新`,
    `${keyword} 争议 观点 讨论`,
    `${keyword} 数据报告 研究 ${new Date().getFullYear()}`,
    `${keyword} 实操教程 方法论`,
    `${keyword} 最新趋势 ${industry}`,
  ];

  // Platform-specific queries
  for (const platform of platforms) {
    queries.push(`${keyword} ${platform} 热门内容`);
  }

  return queries;
}

// ─── Web Search Collector ───────────────────────────────────────────────────

function searchResultToIntel(result: SearchResult, keyword: string): IntelItem {
  return {
    title: result.title,
    domain: keyword,
    source: "web_search",
    sourceUrl: result.url,
    collectedAt: new Date().toISOString(),
    relevance: 50,
    tags: [keyword],
    expiresAfter: 14,
    summary: result.snippet,
    keyPoints: [],
    topicPotential: "",
  };
}

export function createWebSearchCollector(searchFn: SearchFn): Collector {
  return {
    id: "web_search",
    async collect(opts: CollectorOptions): Promise<CollectorResult> {
      const items: IntelItem[] = [];
      const errors: string[] = [];
      const seen = new Set<string>();

      for (const keyword of opts.keywords) {
        const queries = buildMultiDimensionQueries(keyword, opts.industry, opts.platforms);
        for (const query of queries) {
          try {
            const results = await searchFn(query);
            for (const result of results) {
              if (seen.has(result.url)) continue;
              seen.add(result.url);
              items.push(searchResultToIntel(result, keyword));
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Query "${query}" failed: ${msg}`);
          }
        }
      }

      return { items, source: "web_search", errors };
    },
  };
}
