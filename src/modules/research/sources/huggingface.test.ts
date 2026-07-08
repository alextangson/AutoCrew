import { describe, it, expect, vi } from "vitest";
import { fetchHuggingFace } from "./huggingface.js";

function mockFetchJson(payload: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: async () => payload });
}

const SAMPLE = [
  { id: "agentica-org/DeepCoder-14B-Preview", likes: 681, downloads: 297 },
  { id: "x/y", likes: 0, downloads: 5 },
];

describe("fetchHuggingFace", () => {
  it("parses models into SourceItems with heat from likes", async () => {
    const items = await fetchHuggingFace("agent", 5, { fetchImpl: mockFetchJson(SAMPLE) });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "agentica-org/DeepCoder-14B-Preview",
      url: "https://huggingface.co/agentica-org/DeepCoder-14B-Preview",
      source: "huggingface",
      heat: 681,
    });
  });

  it("queries the models API sorted by likes with the encoded keyword", async () => {
    const fetchImpl = mockFetchJson([]);
    await fetchHuggingFace("AI agent", 3, { fetchImpl });
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain("huggingface.co/api/models");
    expect(url).toContain("sort=likes");
    expect(url).toContain("AI%20agent");
    expect(url).toContain("limit=3");
  });

  it("returns empty on a non-ok response", async () => {
    const items = await fetchHuggingFace("AI", 5, { fetchImpl: mockFetchJson({}, false) });
    expect(items).toEqual([]);
  });
});
