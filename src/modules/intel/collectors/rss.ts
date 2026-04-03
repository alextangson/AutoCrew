import RssParser from "rss-parser";
import type { IntelItem } from "../../../storage/pipeline-store.js";
import type { Collector, CollectorOptions, CollectorResult } from "../collector.js";
import { loadSourceConfig } from "../source-config.js";

// ─── RSS Item Parser ────────────────────────────────────────────────────────

export interface RssItem {
  title?: string;
  link?: string;
  contentSnippet?: string;
  content?: string;
  isoDate?: string;
  categories?: string[];
  creator?: string;
}

export function parseRssItems(
  items: RssItem[],
  domain: string,
  tags?: string[],
): IntelItem[] {
  return items
    .filter((item) => item.title)
    .map((item) => ({
      title: item.title!,
      domain,
      source: "rss" as const,
      sourceUrl: item.link,
      collectedAt: item.isoDate ?? new Date().toISOString(),
      relevance: 40,
      tags: [...(tags ?? []), ...(item.categories ?? [])],
      expiresAfter: 14,
      summary: item.contentSnippet ?? item.content?.slice(0, 200) ?? "",
      keyPoints: [],
      topicPotential: "",
    }));
}

// ─── RSS Collector ──────────────────────────────────────────────────────────

export function createRssCollector(): Collector {
  const parser = new RssParser();

  return {
    id: "rss",
    async collect(opts: CollectorOptions): Promise<CollectorResult> {
      const config = await loadSourceConfig(opts.dataDir);
      const items: IntelItem[] = [];
      const errors: string[] = [];

      for (const feed of config.rss) {
        try {
          const parsed = await parser.parseURL(feed.url);
          const feedItems = parseRssItems(
            parsed.items as RssItem[],
            feed.domain,
            feed.tags,
          );
          items.push(...feedItems);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`RSS feed ${feed.url} failed: ${msg}`);
        }
      }

      return { items, source: "rss", errors };
    },
  };
}
