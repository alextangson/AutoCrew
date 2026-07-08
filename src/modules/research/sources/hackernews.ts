/**
 * HackerNews source — pulls recent stories via the public Algolia API (no key).
 * Mirrors sentinel/fetch_news.py::fetch_hackernews structure.
 */
import type { SourceItem } from "./types.js";

export interface HackerNewsDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// 'search' sorts by popularity (points) — gives real heat; 'search_by_date'
// would return fresh-but-cold stories. Pair with a 7-day window for freshness.
const ALGOLIA_BASE = "https://hn.algolia.com/api/v1/search";

interface AlgoliaHit {
  objectID: string;
  title?: string;
  url?: string | null;
  points?: number;
  num_comments?: number;
}

export async function fetchHackerNews(
  keyword: string,
  limit = 5,
  deps: HackerNewsDeps = {},
): Promise<SourceItem[]> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const query = encodeURIComponent(keyword || "");
  const url =
    `${ALGOLIA_BASE}?tags=story&numericFilters=created_at_i>${since}` +
    `&hitsPerPage=${limit}&query=${query}`;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchFn(url);
  } catch {
    return [];
  }
  if (!res.ok) return [];

  const data = (await res.json()) as { hits?: AlgoliaHit[] };
  const hits = Array.isArray(data?.hits) ? data.hits : [];

  return hits
    .slice(0, limit)
    .map((h): SourceItem => {
      const points = typeof h.points === "number" ? h.points : undefined;
      return {
        title: (h.title ?? "").trim(),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        source: "hackernews",
        ...(points !== undefined ? { heat: points } : {}),
        summary: `${h.points ?? 0} points · ${h.num_comments ?? 0} comments`,
      };
    })
    .filter((it) => it.title !== "");
}
