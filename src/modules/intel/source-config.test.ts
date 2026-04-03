import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { loadSourceConfig, getRecommendedSources } from "./source-config.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "autocrew-source-config-test-"),
  );
  // Create pipeline/intel/_sources directory
  await fs.mkdir(
    path.join(testDir, "pipeline", "intel", "_sources"),
    { recursive: true },
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("loadSourceConfig", () => {
  it("loads RSS config from _sources/*.yaml", async () => {
    const configData = {
      rss: [
        { url: "https://example.com/feed", domain: "科技" },
        { url: "https://other.com/rss", domain: "AI", tags: ["ml"] },
      ],
      keywords: ["AI", "LLM"],
    };
    await fs.writeFile(
      path.join(testDir, "pipeline", "intel", "_sources", "feeds.yaml"),
      yaml.dump(configData),
    );

    const config = await loadSourceConfig(testDir);
    expect(config.rss).toHaveLength(2);
    expect(config.rss[0].url).toBe("https://example.com/feed");
    expect(config.rss[1].tags).toEqual(["ml"]);
    expect(config.keywords).toEqual(["AI", "LLM"]);
  });

  it("returns empty arrays when no config files exist", async () => {
    const config = await loadSourceConfig(testDir);
    expect(config.rss).toEqual([]);
    expect(config.trends).toEqual([]);
    expect(config.accounts).toEqual([]);
    expect(config.keywords).toEqual([]);
  });

  it("returns empty arrays when _sources dir does not exist", async () => {
    const emptyDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "autocrew-empty-test-"),
    );
    const config = await loadSourceConfig(emptyDir);
    expect(config.rss).toEqual([]);
    expect(config.trends).toEqual([]);
    await fs.rm(emptyDir, { recursive: true, force: true });
  });

  it("merges multiple yaml files", async () => {
    const sourcesDir = path.join(testDir, "pipeline", "intel", "_sources");
    await fs.writeFile(
      path.join(sourcesDir, "rss.yaml"),
      yaml.dump({ rss: [{ url: "https://a.com/feed", domain: "A" }] }),
    );
    await fs.writeFile(
      path.join(sourcesDir, "trends.yaml"),
      yaml.dump({ trends: [{ source: "hackernews", min_score: 100 }] }),
    );

    const config = await loadSourceConfig(testDir);
    expect(config.rss).toHaveLength(1);
    expect(config.trends).toHaveLength(1);
    expect(config.trends[0].source).toBe("hackernews");
  });
});

describe("getRecommendedSources", () => {
  it("recommends sources by exact industry match", async () => {
    const result = await getRecommendedSources("科技");
    expect(result.trends.length).toBeGreaterThan(0);
    expect(result.trends.some((t) => t.source === "hackernews")).toBe(true);
    expect(result.rssSuggestions.length).toBeGreaterThan(0);
  });

  it("different industries get different sources", async () => {
    const tech = await getRecommendedSources("科技");
    const beauty = await getRecommendedSources("美妆");

    // 科技 has hackernews, 美妆 does not
    expect(tech.trends.some((t) => t.source === "hackernews")).toBe(true);
    expect(beauty.trends.some((t) => t.source === "hackernews")).toBe(false);

    // 美妆 has douyin_hot, 科技 does not
    expect(beauty.trends.some((t) => t.source === "douyin_hot")).toBe(true);
  });

  it("falls back to _default for unknown industry", async () => {
    const result = await getRecommendedSources("未知行业");
    expect(result.trends.length).toBeGreaterThan(0);
    expect(result.trends.some((t) => t.source === "weibo_hot")).toBe(true);
  });

  it("AI industry includes arxiv and reddit sources", async () => {
    const result = await getRecommendedSources("AI");
    expect(result.trends.some((t) => t.source === "arxiv")).toBe(true);
    expect(result.trends.some((t) => t.source === "reddit")).toBe(true);
  });
});
