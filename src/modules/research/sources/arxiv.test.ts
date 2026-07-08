import { describe, it, expect, vi } from "vitest";
import { fetchArxiv } from "./arxiv.js";

function mockFetchText(xml: string, ok = true) {
  return vi.fn().mockResolvedValue({ ok, text: async () => xml });
}

const SAMPLE = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>RevengeBench:
      Reverse Engineering Policies</title>
    <id>http://arxiv.org/abs/2606.26094v1</id>
    <summary>We study reverse engineering of code-space policies.</summary>
  </entry>
  <entry>
    <title>Second Paper</title>
    <id>http://arxiv.org/abs/2606.00001v1</id>
    <summary>Another abstract.</summary>
  </entry>
</feed>`;

describe("fetchArxiv", () => {
  it("parses Atom entries into SourceItems (title whitespace normalized, url from id)", async () => {
    const items = await fetchArxiv("AI agent", 5, { fetchImpl: mockFetchText(SAMPLE) });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "RevengeBench: Reverse Engineering Policies",
      url: "http://arxiv.org/abs/2606.26094v1",
      source: "arxiv",
    });
    // Papers have no engagement metric → heat undefined (scoring degrades to text)
    expect(items[0].heat).toBeUndefined();
  });

  it("queries the arXiv API with the encoded keyword and max_results", async () => {
    const fetchImpl = mockFetchText("<feed></feed>");
    await fetchArxiv("AI agent", 3, { fetchImpl });
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain("export.arxiv.org/api/query");
    expect(url).toContain("AI+agent");
    expect(url).toContain("max_results=3");
  });

  it("returns empty on a non-ok response", async () => {
    const items = await fetchArxiv("AI", 5, { fetchImpl: mockFetchText("", false) });
    expect(items).toEqual([]);
  });
});
