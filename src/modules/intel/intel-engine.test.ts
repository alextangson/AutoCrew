import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runIntelPull } from "./intel-engine.js";
import type { SearchResult } from "./collectors/web-search.js";

describe("runIntelPull", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "intel-engine-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("collects and saves intel from web_search source", async () => {
    const mockResults: SearchResult[] = [
      { title: "AI Breakthrough", url: "https://example.com/1", snippet: "Big news in AI" },
      { title: "LLM Update", url: "https://example.com/2", snippet: "New model released" },
    ];
    const searchFn = vi.fn().mockResolvedValue(mockResults);

    const result = await runIntelPull({
      keywords: ["AI"],
      industry: "科技",
      platforms: ["小红书"],
      dataDir: tmpDir,
      searchFn,
      skipBrowser: true,
      sources: ["web_search"],
    });

    expect(result.totalCollected).toBeGreaterThan(0);
    expect(result.totalSaved).toBeGreaterThan(0);
    expect(result.bySource.web_search).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);

    // Verify files were saved
    const intelDir = path.join(tmpDir, "pipeline", "intel", "AI");
    const files = await fs.readdir(intelDir);
    expect(files.length).toBeGreaterThan(0);
  });

  it("handles collector errors gracefully", async () => {
    const searchFn = vi.fn().mockRejectedValue(new Error("Network down"));

    const result = await runIntelPull({
      keywords: ["fail"],
      industry: "科技",
      platforms: [],
      dataDir: tmpDir,
      searchFn,
      skipBrowser: true,
      sources: ["web_search"],
    });

    expect(result.totalCollected).toBe(0);
    expect(result.totalSaved).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("filters to specific sources", async () => {
    const searchFn = vi.fn().mockResolvedValue([
      { title: "Test", url: "https://example.com/x", snippet: "test" },
    ]);

    const result = await runIntelPull({
      keywords: ["test"],
      industry: "科技",
      platforms: [],
      dataDir: tmpDir,
      searchFn,
      skipBrowser: true,
      sources: ["web_search"],
    });

    // Only web_search source should be present
    expect(Object.keys(result.bySource)).toEqual(["web_search"]);
  });

  it("runs multiple collectors in parallel", async () => {
    const searchFn = vi.fn().mockResolvedValue([
      { title: "Multi", url: "https://example.com/m", snippet: "multi" },
    ]);

    const result = await runIntelPull({
      keywords: ["test"],
      industry: "科技",
      platforms: [],
      dataDir: tmpDir,
      searchFn,
      skipBrowser: true,
      // No sources filter — runs web_search, rss, trend (skips competitor due to skipBrowser)
    });

    // web_search and trend both use searchFn, rss may return 0 (no config)
    expect(result.totalCollected).toBeGreaterThan(0);
    expect(result.totalSaved).toBeGreaterThan(0);
  });
});
