import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeResearch } from "./research.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-research-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("executeResearch overseas mode", () => {
  it("fetches via the source registry (all sources by default) and saves scored topics", async () => {
    const overseasFetch = vi.fn().mockResolvedValue([
      { title: "GPT-5 changes everything", url: "https://hn/1", source: "hackernews", heat: 800, summary: "800 points" },
      { title: "A small tool nobody noticed", url: "https://hn/2", source: "hackernews", heat: 4, summary: "4 points" },
    ]);

    const res = await executeResearch(
      { action: "discover", mode: "overseas", keyword: "AI", topic_count: 2, _dataDir: testDir },
      { overseasFetch },
    );

    expect(res.ok).toBe(true);
    expect(res.mode).toBe("overseas");

    const [sources, kw, limit] = overseasFetch.mock.calls[0];
    expect(sources).toEqual(expect.arrayContaining(["hackernews", "producthunt", "github"]));
    expect(kw).toBe("AI");
    expect(typeof limit).toBe("number");

    expect(res.savedCount).toBeGreaterThan(0);
    expect(res.candidates[0].title).toContain("GPT-5");
  });

  it("selects only the requested sources", async () => {
    const overseasFetch = vi.fn().mockResolvedValue([]);
    await executeResearch(
      { action: "discover", mode: "overseas", keyword: "AI", sources: ["github"], _dataDir: testDir },
      { overseasFetch },
    );
    expect(overseasFetch.mock.calls[0][0]).toEqual(["github"]);
  });

  it("falls back to all sources when requested sources are invalid", async () => {
    const overseasFetch = vi.fn().mockResolvedValue([]);
    await executeResearch(
      { action: "discover", mode: "overseas", keyword: "AI", sources: ["nonsense"], _dataDir: testDir },
      { overseasFetch },
    );
    expect(overseasFetch.mock.calls[0][0]).toEqual(
      expect.arrayContaining(["hackernews", "producthunt", "github"]),
    );
  });

  it("does not call the overseas fetch for free mode", async () => {
    const overseasFetch = vi.fn();
    await executeResearch(
      { action: "discover", mode: "free", keyword: "AI", search_results: [], _dataDir: testDir },
      { overseasFetch },
    );
    expect(overseasFetch).not.toHaveBeenCalled();
  });
});
