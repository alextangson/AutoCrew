import { describe, it, expect, vi } from "vitest";
import { fetchGitHub } from "./github.js";

function mockFetchJson(payload: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: async () => payload });
}

const SAMPLE = {
  items: [
    { full_name: "openai/gpt", html_url: "https://github.com/openai/gpt", description: "GPT models", stargazers_count: 5000 },
    { full_name: "x/y", html_url: "https://github.com/x/y", description: null, stargazers_count: 12 },
  ],
};

describe("fetchGitHub", () => {
  it("parses search results into SourceItems with heat from stars", async () => {
    const fetchImpl = mockFetchJson(SAMPLE);
    const items = await fetchGitHub("AI agent", 5, { fetchImpl });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      url: "https://github.com/openai/gpt",
      source: "github",
      heat: 5000,
    });
    expect(items[0].title).toContain("openai/gpt");
  });

  it("queries the search API sorted by stars with the encoded keyword", async () => {
    const fetchImpl = mockFetchJson({ items: [] });
    await fetchGitHub("AI agent", 3, { fetchImpl });

    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toContain("api.github.com/search/repositories");
    expect(calledUrl).toContain("sort=stars");
    expect(calledUrl).toContain("AI%20agent");
    expect(calledUrl).toContain("per_page=3");
  });

  it("returns empty on a non-ok response", async () => {
    const items = await fetchGitHub("AI", 5, { fetchImpl: mockFetchJson({}, false) });
    expect(items).toEqual([]);
  });
});
