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

/** A source fetcher pulls recent items for a keyword. */
export type SourceFetcher = (keyword: string, limit: number) => Promise<SourceItem[]>;
