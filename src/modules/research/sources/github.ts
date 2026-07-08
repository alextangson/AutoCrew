/**
 * GitHub source — pulls hot repos via the official Search API (no key, 60 req/h).
 * Learns sentinel/fetch_news.py::fetch_github's intent (surface trending repos for
 * a keyword) but uses the JSON Search API instead of scraping HTML — more robust,
 * and stargazers_count gives a real heat signal.
 */
import type { SourceItem } from "./types.js";

export interface GitHubDeps {
  fetchImpl?: typeof fetch;
}

const SEARCH_BASE = "https://api.github.com/search/repositories";

interface GitHubRepo {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
}

export async function fetchGitHub(
  keyword: string,
  limit = 5,
  deps: GitHubDeps = {},
): Promise<SourceItem[]> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const sinceDate = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`${keyword} created:>${sinceDate}`);
  const url = `${SEARCH_BASE}?q=${q}&sort=stars&order=desc&per_page=${limit}`;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchFn(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "autocrew" },
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];

  const data = (await res.json()) as { items?: GitHubRepo[] };
  const repos = Array.isArray(data?.items) ? data.items : [];

  return repos
    .slice(0, limit)
    .map((r): SourceItem => {
      const name = r.full_name ?? "";
      const desc = r.description ?? "";
      const stars = typeof r.stargazers_count === "number" ? r.stargazers_count : undefined;
      return {
        title: desc ? `${name} — ${desc}` : name,
        url: r.html_url ?? (name ? `https://github.com/${name}` : ""),
        source: "github",
        ...(stars !== undefined ? { heat: stars } : {}),
        summary: desc || name,
      };
    })
    .filter((it) => it.title !== "" && it.url !== "");
}
