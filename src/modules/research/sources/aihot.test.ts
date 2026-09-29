import { describe, it, expect } from "vitest";
import { fetchAihotHot } from "./aihot.js";

const json = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("fetchAihotHot", () => {
  it("maps topics: original link first, heat = sourceCount, Chinese summary line", async () => {
    const items = await fetchAihotHot(10, {
      fetchImpl: json({
        items: [
          {
            title: "AMD 收购 World Labs",
            links: { aihot: "https://aihot.news/items/a", original: "https://x.com/w/status/1" },
            sourceCount: 8,
            participantCount: 63,
            sourceNames: ["IT之家", "The Verge", "TechCrunch", "HN"],
          },
          { title: "只有站内链接", links: { aihot: "https://aihot.news/items/b" } },
          { title: "", links: { original: "https://e.com" } },
        ],
      }),
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "AMD 收购 World Labs", url: "https://x.com/w/status/1", heat: 8, source: "aihot_hot" });
    expect(items[0].summary).toContain("8 家来源在报道");
    expect(items[0].summary).not.toContain("HN"); // 来源名只列前 3 个
    expect(items[1]).toMatchObject({ url: "https://aihot.news/items/b" });
    expect(items[1].heat).toBeUndefined();
  });

  it("respects limit", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, links: { original: `https://e.com/${i}` } }));
    expect(await fetchAihotHot(3, { fetchImpl: json({ items: many }) })).toHaveLength(3);
  });

  it("throws on HTTP error so the radar lists it as a failed source", async () => {
    await expect(fetchAihotHot(10, { fetchImpl: json({}, 503) })).rejects.toThrow("503");
  });

  it("throws on an empty or reshaped payload instead of reporting 'no hot topics'", async () => {
    await expect(fetchAihotHot(10, { fetchImpl: json({ data: [] }) })).rejects.toThrow("0 条");
  });
});
