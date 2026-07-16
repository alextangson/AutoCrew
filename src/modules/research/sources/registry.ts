/**
 * Overseas source registry — maps source keys to fetchers and fans out across them.
 * Mirrors sentinel's source-list structure (DEFAULT_SOURCES), but self-contained.
 * Add a source = register one fetcher here.
 */
import type { FetchOptions, SourceFetcher, SourceItem } from "./types.js";
import { fetchHackerNews } from "./hackernews.js";
import { fetchProductHunt } from "./producthunt.js";
import { fetchGitHub } from "./github.js";
import { fetchArxiv } from "./arxiv.js";
import { fetchHuggingFace } from "./huggingface.js";
import { fetchX } from "./x.js";

export const SOURCE_REGISTRY: Record<string, SourceFetcher> = {
  hackernews: (kw, lim) => fetchHackerNews(kw, lim),
  producthunt: (kw, lim) => fetchProductHunt(kw, lim),
  github: (kw, lim) => fetchGitHub(kw, lim),
  arxiv: (kw, lim) => fetchArxiv(kw, lim),
  huggingface: (kw, lim) => fetchHuggingFace(kw, lim),
  x: (kw, lim, opts) => fetchX(kw, lim, { apiKey: opts?.xApiKey ?? "" }),
};

export const ALL_SOURCES = Object.keys(SOURCE_REGISTRY);

export interface FetchSourcesDeps {
  registry?: Record<string, SourceFetcher>;
  /** 运行时密钥,透传给需要的 fetcher(如 x → twitterapi.io key)。 */
  xApiKey?: string;
}

/**
 * Fetch from the named sources concurrently and merge results.
 * Unknown source keys are skipped; a failing source yields [] (isolated),
 * so one flaky source never sinks the whole discovery run.
 */
export async function fetchFromSources(
  sources: string[],
  keyword: string,
  limit: number,
  deps: FetchSourcesDeps = {},
): Promise<SourceItem[]> {
  const registry = deps.registry ?? SOURCE_REGISTRY;
  const opts: FetchOptions = { xApiKey: deps.xApiKey };
  const valid = sources.filter((s) => registry[s]);

  const results = await Promise.all(
    valid.map((s) => registry[s](keyword, limit, opts).catch(() => [] as SourceItem[])),
  );
  return results.flat();
}
