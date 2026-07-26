/**
 * search-provider.test.ts — 搜索 provider 抽象（IA v5 V5.3）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSearchConfig, saveSearchConfig, searchWeb, searchAvailable } from "./search-provider.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-search-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("search config", () => {
  it("往返:save → load;key 文件收 600 权限", async () => {
    await saveSearchConfig({ provider: "bocha", apiKey: "sk-live" }, dir);
    const cfg = await loadSearchConfig(dir);
    expect(cfg).toEqual({ provider: "bocha", apiKey: "sk-live" });
    const stat = await fs.stat(path.join(dir, "search.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await searchAvailable(dir)).toBe(true);
  });

  it("缺失/坏形状 → null;未配置 searchWeb 报人话错误", async () => {
    expect(await loadSearchConfig(dir)).toBeNull();
    await fs.writeFile(path.join(dir, "search.json"), JSON.stringify({ provider: "google", apiKey: "x" }), "utf-8");
    expect(await loadSearchConfig(dir)).toBeNull();
    await expect(searchWeb("AI", { dataDir: dir })).rejects.toThrow(/未配置/);
  });
});

describe("searchWeb 响应解析", () => {
  it("bocha:data.webPages.value 形状 → 归一化结果;Authorization 带 key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 200,
      data: { webPages: { value: [
        { name: "标题A", url: "https://a.com/1", summary: "摘要A", datePublished: "2026-07-01" },
        { name: "", url: "https://drop.com" }, // 无标题丢弃
      ] } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchWeb("AI 代码", { config: { provider: "bocha", apiKey: "sk-b" } });
    expect(results).toEqual([{ title: "标题A", url: "https://a.com/1", snippet: "摘要A", publishedAt: "2026-07-01" }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.bochaai.com/v1/web-search");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-b");
  });

  it("tavily:results 形状 → 归一化;HTTP 错误透出状态码", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: "T1", url: "https://t.com/1", content: "内容1" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const results = await searchWeb("agents", { config: { provider: "tavily", apiKey: "tv-k" } });
    expect(results[0]).toEqual({ title: "T1", url: "https://t.com/1", snippet: "内容1" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 429 })));
    await expect(searchWeb("x", { config: { provider: "tavily", apiKey: "tv-k" } }))
      .rejects.toThrow(/HTTP 429/);
  });
});
