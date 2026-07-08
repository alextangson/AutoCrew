/**
 * arXiv source — recent papers via the public Atom API (no key, very stable).
 * Papers carry no engagement metric, so heat is left undefined → viral scoring
 * falls back to text signals.
 */
import type { SourceItem } from "./types.js";

export interface ArxivDeps {
  fetchImpl?: typeof fetch;
}

const ARXIV_BASE = "http://export.arxiv.org/api/query";

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

export async function fetchArxiv(
  keyword: string,
  limit = 5,
  deps: ArxivDeps = {},
): Promise<SourceItem[]> {
  const fetchFn = deps.fetchImpl ?? fetch;
  // arXiv expects '+' for spaces inside search_query
  const query = encodeURIComponent(keyword || "").replace(/%20/g, "+");
  const url =
    `${ARXIV_BASE}?search_query=all:${query}` +
    `&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchFn(url);
  } catch {
    return [];
  }
  if (!res.ok) return [];

  const xml = await res.text();
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];

  return entries
    .slice(0, limit)
    .map((e): SourceItem => {
      const summary = tag(e, "summary");
      return {
        title: tag(e, "title"),
        url: tag(e, "id"),
        source: "arxiv",
        summary: summary || tag(e, "title"),
      };
    })
    .filter((it) => it.title !== "");
}
