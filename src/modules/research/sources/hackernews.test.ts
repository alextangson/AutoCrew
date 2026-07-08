import { describe, it, expect, vi } from "vitest";
import { fetchHackerNews } from "./hackernews.js";

function mockFetch(payload: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => payload,
  });
}

describe("fetchHackerNews", () => {
  it("parses HN Algolia hits into SourceItems with heat from points", async () => {
    const fetchImpl = mockFetch({
      hits: [
        { objectID: "1", title: "GPT-5 released", url: "https://openai.com/gpt5", points: 512, num_comments: 200 },
        { objectID: "2", title: "Ask HN: best AI tools", url: null, points: 88, num_comments: 45 },
      ],
    });

    const items = await fetchHackerNews("AI", 5, { fetchImpl });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "GPT-5 released",
      url: "https://openai.com/gpt5",
      source: "hackernews",
      heat: 512,
    });
    // A url-less story (Ask HN) falls back to its HN item link
    expect(items[1].url).toBe("https://news.ycombinator.com/item?id=2");
    expect(items[1].heat).toBe(88);
  });

  it("queries the story tag with the encoded keyword and limit", async () => {
    const fetchImpl = mockFetch({ hits: [] });

    await fetchHackerNews("excel tips", 3, { fetchImpl });

    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toContain("tags=story");
    expect(calledUrl).toContain("query=excel%20tips");
    expect(calledUrl).toContain("hitsPerPage=3");
  });

  it("returns empty on a non-ok response", async () => {
    const fetchImpl = mockFetch({}, false);
    const items = await fetchHackerNews("AI", 5, { fetchImpl });
    expect(items).toEqual([]);
  });

  it("skips hits without a title", async () => {
    const fetchImpl = mockFetch({
      hits: [
        { objectID: "3", title: "", points: 10 },
        { objectID: "4", title: "Real story", points: 20 },
      ],
    });

    const items = await fetchHackerNews("AI", 5, { fetchImpl });

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Real story");
  });
});
