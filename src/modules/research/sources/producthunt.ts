/**
 * ProductHunt source — pulls top products via the public RSS feed (no key).
 * Mirrors sentinel/fetch_news.py::fetch_producthunt, but parses RSS with a small
 * regex instead of pulling in an XML dependency. RSS has no vote counts, so heat
 * is left undefined → viral scoring falls back to text signals.
 */
import type { SourceItem } from "./types.js";

export interface ProductHuntDeps {
  fetchImpl?: typeof fetch;
}

const PH_FEED = "https://www.producthunt.com/feed";

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** Atom uses <link href="…"/>; RSS uses <link>…</link>. Try both. */
function extractLink(block: string): string {
  const href = block.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i);
  if (href) return href[1].trim();
  return extractTag(block, "link");
}

export async function fetchProductHunt(
  keyword: string,
  limit = 5,
  deps: ProductHuntDeps = {},
): Promise<SourceItem[]> {
  const fetchFn = deps.fetchImpl ?? fetch;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchFn(PH_FEED);
  } catch {
    return [];
  }
  if (!res.ok) return [];

  const xml = await res.text();
  // ProductHunt serves Atom (<entry>); generic RSS uses <item>. Handle both.
  const blocks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];

  return blocks
    .slice(0, limit)
    .map((block): SourceItem => {
      const title = extractTag(block, "title");
      const description =
        extractTag(block, "description") || extractTag(block, "content") || extractTag(block, "summary");
      return {
        title,
        url: extractLink(block),
        source: "producthunt",
        summary: description || title,
      };
    })
    .filter((it) => it.title !== "");
}
