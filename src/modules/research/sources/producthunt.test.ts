import { describe, it, expect, vi } from "vitest";
import { fetchProductHunt } from "./producthunt.js";

function mockFetchText(xml: string, ok = true) {
  return vi.fn().mockResolvedValue({ ok, text: async () => xml });
}

const SAMPLE_RSS = `<?xml version="1.0"?><rss><channel>
  <item><title><![CDATA[Cursor — AI code editor]]></title><link>https://www.producthunt.com/posts/cursor</link><description>The AI editor</description></item>
  <item><title>Plain Title</title><link>https://www.producthunt.com/posts/plain</link><description>desc2</description></item>
</channel></rss>`;

describe("fetchProductHunt", () => {
  it("parses RSS items (incl. CDATA titles) into SourceItems", async () => {
    const fetchImpl = mockFetchText(SAMPLE_RSS);
    const items = await fetchProductHunt("AI", 5, { fetchImpl });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Cursor — AI code editor",
      url: "https://www.producthunt.com/posts/cursor",
      source: "producthunt",
    });
    expect(items[1].title).toBe("Plain Title");
  });

  it("parses Atom entries with href-attribute links (ProductHunt's real format)", async () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>Agent 37 Cloud</title><link rel="alternate" type="text/html" href="https://www.producthunt.com/products/agent-37"/><content>An AI agent</content></entry>
    </feed>`;
    const items = await fetchProductHunt("AI", 5, { fetchImpl: mockFetchText(atom) });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Agent 37 Cloud",
      url: "https://www.producthunt.com/products/agent-37",
      source: "producthunt",
    });
  });

  it("respects the limit", async () => {
    const items = await fetchProductHunt("AI", 1, { fetchImpl: mockFetchText(SAMPLE_RSS) });
    expect(items).toHaveLength(1);
  });

  it("returns empty on a non-ok response", async () => {
    const items = await fetchProductHunt("AI", 5, { fetchImpl: mockFetchText("", false) });
    expect(items).toEqual([]);
  });
});
