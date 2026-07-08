import { describe, it, expect, vi } from "vitest";
import { fetchFromSources, ALL_SOURCES } from "./registry.js";
import type { SourceFetcher } from "./types.js";

describe("fetchFromSources", () => {
  it("merges items from multiple sources", async () => {
    const registry: Record<string, SourceFetcher> = {
      a: vi.fn().mockResolvedValue([{ title: "A1", url: "ua", source: "a" }]),
      b: vi.fn().mockResolvedValue([{ title: "B1", url: "ub", source: "b" }]),
    };
    const items = await fetchFromSources(["a", "b"], "kw", 5, { registry });
    expect(items.map((i) => i.title).sort()).toEqual(["A1", "B1"]);
  });

  it("ignores unknown source keys", async () => {
    const registry: Record<string, SourceFetcher> = {
      a: vi.fn().mockResolvedValue([{ title: "A1", url: "ua", source: "a" }]),
    };
    const items = await fetchFromSources(["a", "nope"], "kw", 5, { registry });
    expect(items).toHaveLength(1);
  });

  it("isolates a failing source so others still return", async () => {
    const registry: Record<string, SourceFetcher> = {
      a: vi.fn().mockRejectedValue(new Error("boom")),
      b: vi.fn().mockResolvedValue([{ title: "B1", url: "ub", source: "b" }]),
    };
    const items = await fetchFromSources(["a", "b"], "kw", 5, { registry });
    expect(items.map((i) => i.title)).toEqual(["B1"]);
  });

  it("exposes the built-in source keys", () => {
    expect(ALL_SOURCES).toEqual(expect.arrayContaining(["hackernews", "producthunt", "github"]));
  });
});
