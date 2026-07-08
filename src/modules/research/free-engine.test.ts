import { describe, it, expect } from "vitest";
import { scoreCandidate, processSearchResults } from "./free-engine.js";

describe("processSearchResults — overseas title readability", () => {
  it("keeps a repo-name title whole instead of cutting mid-word at 20 chars", async () => {
    const { candidates } = await processSearchResults(
      [{ title: "op7418/guizang-ppt-skill — AI slide generator", snippet: "x", url: "https://g" }],
      "AI",
      null,
      5,
    );
    expect(candidates[0].title).toBe("op7418/guizang-ppt-skill");
  });

  it("cuts a long latin headline at a word boundary, never mid-word", async () => {
    const long = "Why every single AI agent framework keeps reinventing the same wheel";
    const { candidates } = await processSearchResults(
      [{ title: long, snippet: "x", url: "https://g" }],
      "AI",
      null,
      5,
    );
    const t = candidates[0].title;
    expect(t.length).toBeLessThanOrEqual(40);
    expect(long.startsWith(t)).toBe(true);
    const nextChar = long[t.length];
    expect(nextChar === undefined || nextChar === " ").toBe(true);
  });
});

describe("processSearchResults — title cleanup", () => {
  it("strips ' - Publisher' suffixes but preserves hyphenated terms like GPT-5", async () => {
    const { candidates } = await processSearchResults(
      [
        { title: "Cool Tool - TechCrunch", snippet: "x", url: "https://a" },
        { title: "GPT-5 is here", snippet: "y", url: "https://b" },
      ],
      "AI",
      null,
      5,
    );
    const titles = candidates.map((c) => c.title);
    expect(titles).toContain("Cool Tool");
    expect(titles.some((t) => t.includes("GPT-5"))).toBe(true);
  });
});

describe("scoreCandidate — real heat signal", () => {
  const base = { title: "新工具发布", description: "一个新产品", tags: ["AI"] };

  it("boosts topicHeat when real heat is high vs low", () => {
    const hot = scoreCandidate({ ...base, heat: 500 }, null, "AI");
    const cold = scoreCandidate({ ...base, heat: 3 }, null, "AI");
    expect(hot.breakdown.topicHeat).toBeGreaterThan(cold.breakdown.topicHeat);
  });

  it("falls back to text rules when no heat is provided (graceful degradation)", () => {
    const noHeat = scoreCandidate(base, null, "AI");
    expect(noHeat.breakdown.topicHeat).toBeGreaterThanOrEqual(0);
    expect(noHeat.breakdown.topicHeat).toBeLessThanOrEqual(33);

    // A hot item should never score lower heat than the no-heat baseline
    const hot = scoreCandidate({ ...base, heat: 500 }, null, "AI");
    expect(hot.breakdown.topicHeat).toBeGreaterThanOrEqual(noHeat.breakdown.topicHeat);
  });

  it("keeps topicHeat within the 0-33 band even with huge heat", () => {
    const r = scoreCandidate({ ...base, heat: 99999 }, null, "AI");
    expect(r.breakdown.topicHeat).toBeLessThanOrEqual(33);
  });
});
