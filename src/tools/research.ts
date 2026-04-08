import path from "node:path";
import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { saveTopic } from "../storage/local-store.js";
import { browserCdpAdapter } from "../adapters/browser/browser-cdp.js";
import { researchWithTikHub } from "../adapters/research/tikhub.js";
import { runFreeResearch, type SearchResult } from "../modules/research/free-engine.js";
import type { BrowserPlatform, ResearchItem } from "../adapters/browser/types.js";

type ResearchMode = "auto" | "browser_first" | "api_fallback" | "free" | "manual";

export const researchSchema = Type.Object({
  action: Type.Unsafe<"discover" | "session_status">({
    type: "string",
    enum: ["discover", "session_status"],
    description: "Research action: discover new topics or inspect browser session status.",
  }),
  industry: Type.Optional(Type.String({ description: "Industry or niche. Falls back to MEMORY.md if omitted." })),
  keyword: Type.Optional(Type.String({ description: "Research keyword or angle." })),
  platform: Type.Optional(
    Type.Unsafe<BrowserPlatform>({
      type: "string",
      enum: ["xiaohongshu", "douyin", "wechat_mp", "wechat_video", "bilibili"],
      description: "Target platform.",
    }),
  ),
  topic_count: Type.Optional(Type.Number({ description: "How many topics to create. Default: 3." })),
  save_topics: Type.Optional(Type.Boolean({ description: "Save generated topics into ~/.autocrew/topics. Default: true." })),
  mode: Type.Optional(
    Type.Unsafe<ResearchMode>({
      type: "string",
      enum: ["auto", "browser_first", "api_fallback", "free", "manual"],
      description: "Execution mode. 'free' uses web search + viral scoring (no browser/API needed). Default: auto.",
    }),
  ),
  search_results: Type.Optional(
    Type.Array(
      Type.Object({
        title: Type.String(),
        snippet: Type.String(),
        url: Type.String(),
      }),
      { description: "Pre-fetched search results for 'free' mode. Caller provides these from web_search." },
    ),
  ),
});

interface MemoryContext {
  industry?: string;
  competitors: string[];
}

function resolveDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

function normalizePlatform(platform?: string): BrowserPlatform {
  return (platform as BrowserPlatform) || "xiaohongshu";
}

async function readMemoryContext(dataDir?: string): Promise<MemoryContext> {
  const target = path.join(resolveDataDir(dataDir), "MEMORY.md");
  try {
    const raw = await fs.readFile(target, "utf-8");
    const competitors = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.replace(/^- /, ""))
      .filter((line) => /xhs|小红书|douyin|抖音|bilibili|b站|wechat/i.test(line));

    const industryMatch =
      raw.match(/industry[:：]\s*(.+)/i) ||
      raw.match(/定位[:：]\s*(.+)/) ||
      raw.match(/行业[:：]\s*(.+)/);

    return {
      industry: industryMatch?.[1]?.trim(),
      competitors,
    };
  } catch {
    return { competitors: [] };
  }
}

function truncateTitle(text: string, max = 20): string {
  const compact = text.replace(/\s+/g, "").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function buildTopicTitle(item: ResearchItem, platform: BrowserPlatform): string {
  const base = item.title || `${platform}选题`;
  return truncateTitle(base);
}

function buildTopicDescription(
  item: ResearchItem,
  industry: string,
  platform: BrowserPlatform,
): string {
  const summary = item.summary?.trim() || "来自浏览器登录态下的近期内容观察";
  const sourceLabel =
    item.source === "browser_cdp" ? "浏览器登录态" : item.source === "api_provider" ? "API fallback" : "人工降级";
  return `${summary}。适合 ${industry || "当前账号"} 在 ${platform} 上继续延展，来源：${sourceLabel}${item.author ? `，参考账号：${item.author}` : ""}。`;
}

function buildTopicTags(industry: string, platform: BrowserPlatform): string[] {
  const tags = [platform];
  if (industry) {
    tags.push(industry);
  }
  if (platform === "xiaohongshu") {
    tags.push("选题");
  }
  if (platform === "douyin") {
    tags.push("短视频");
  }
  return Array.from(new Set(tags));
}

async function runDiscovery(params: Record<string, unknown>) {
  const dataDir = (params._dataDir as string) || undefined;
  const memory = await readMemoryContext(dataDir);
  const industry = ((params.industry as string) || memory.industry || "").trim();
  const platform = normalizePlatform(params.platform as string | undefined);
  const keyword = ((params.keyword as string) || industry || "内容选题").trim();
  const topicCount = Number(params.topic_count || 3);
  const saveTopics = params.save_topics !== false;
  const mode = (params.mode as ResearchMode) || "auto";

  let items: ResearchItem[] = [];
  const sourcesUsed: string[] = [];

  // --- Free mode: web search + viral scoring engine ---
  if (mode === "free") {
    const searchResults = (params.search_results as SearchResult[] | undefined) || [];
    const freeResult = await runFreeResearch({
      keyword,
      searchResults,
      topicCount,
      dataDir,
    });

    const topics = freeResult.candidates.map((c) => ({
      title: c.title,
      description: c.description,
      tags: c.tags,
      source: c.source,
    }));

    const saved = [];
    if (saveTopics) {
      for (const topic of topics) {
        saved.push(await saveTopic(topic, dataDir));
      }
    }

    return {
      ok: true,
      mode: "free",
      platform,
      keyword,
      industry: freeResult.industry,
      competitors: memory.competitors,
      sourcesUsed: ["free_engine"],
      topics: saveTopics ? saved : topics,
      savedCount: saveTopics ? saved.length : 0,
      searchQueries: freeResult.searchQueries,
      filtersApplied: freeResult.filtersApplied,
      summary: freeResult.summary,
      candidates: freeResult.candidates,
    };
  }

  // --- Browser-first mode (Pro path) ---
  if (mode === "auto" || mode === "browser_first") {
    items = await browserCdpAdapter.research({ platform, keyword, limit: topicCount });
    if (items.length > 0) {
      sourcesUsed.push(browserCdpAdapter.id);
    }
  }

  if (items.length === 0 && (mode === "auto" || mode === "api_fallback")) {
    items = await researchWithTikHub({ platform, keyword, limit: topicCount });
    if (items.length > 0) {
      sourcesUsed.push("tikhub_fallback");
    }
  }

  // --- Auto fallback to free engine when browser + API both empty ---
  if (items.length === 0 && mode === "auto") {
    const searchResults = (params.search_results as SearchResult[] | undefined) || [];
    if (searchResults.length > 0) {
      const freeResult = await runFreeResearch({
        keyword,
        searchResults,
        topicCount,
        dataDir,
      });
      if (freeResult.candidates.length > 0) {
        const topics = freeResult.candidates.map((c) => ({
          title: c.title,
          description: c.description,
          tags: c.tags,
          source: c.source,
        }));

        const saved = [];
        if (saveTopics) {
          for (const topic of topics) {
            saved.push(await saveTopic(topic, dataDir));
          }
        }

        return {
          ok: true,
          mode: "free",
          platform,
          keyword,
          industry: freeResult.industry,
          competitors: memory.competitors,
          sourcesUsed: ["free_engine_auto_fallback"],
          topics: saveTopics ? saved : topics,
          savedCount: saveTopics ? saved.length : 0,
          searchQueries: freeResult.searchQueries,
          filtersApplied: freeResult.filtersApplied,
          summary: freeResult.summary,
          candidates: freeResult.candidates,
        };
      }
    }
  }

  if (items.length === 0) {
    // All sources failed. Instead of returning useless placeholders,
    // tell the caller to use the intel pipeline which has working
    // web search + RSS + trends collectors.
    return {
      ok: false,
      mode: "failed",
      platform,
      keyword,
      industry: industry || null,
      sourcesUsed,
      error:
        "所有调研源都未返回结果（browser/API/free engine）。" +
        "建议使用 autocrew_intel action='pull' 进行内容调研，" +
        "它支持 web search + RSS + 趋势热榜，不依赖浏览器登录态。",
      suggestion: {
        tool: "autocrew_intel",
        action: "pull",
        keywords: [keyword],
      },
    };
  }

  const topics = items.slice(0, topicCount).map((item) => ({
    title: buildTopicTitle(item, platform),
    description: buildTopicDescription(item, industry, platform),
    tags: buildTopicTags(industry, platform),
    source: `${item.source}:${platform}`,
  }));

  const saved = [];
  if (saveTopics) {
    for (const topic of topics) {
      saved.push(await saveTopic(topic, dataDir));
    }
  }

  return {
    ok: true,
    mode: mode === "auto" ? "browser_first" : mode,
    platform,
    keyword,
    industry: industry || null,
    competitors: memory.competitors,
    sourcesUsed,
    topics: saveTopics ? saved : topics,
    savedCount: saveTopics ? saved.length : 0,
    note:
      "Current browser-first adapter is a structural runtime entry. Replace its placeholder implementation with host-specific CDP/web-access execution next.",
  };
}

async function getSessionStatuses(params: Record<string, unknown>) {
  const requestedPlatform = params.platform as BrowserPlatform | undefined;
  const platforms: BrowserPlatform[] = requestedPlatform
    ? [requestedPlatform]
    : ["xiaohongshu", "douyin", "wechat_mp", "wechat_video", "bilibili"];

  const items = [];
  for (const platform of platforms) {
    if (browserCdpAdapter.getSessionStatus) {
      items.push(await browserCdpAdapter.getSessionStatus(platform));
    }
  }

  return {
    ok: true,
    sessions: items,
  };
}

export async function executeResearch(params: Record<string, unknown>) {
  const action = (params.action as string) || "discover";
  if (action === "discover") {
    return runDiscovery(params);
  }
  if (action === "session_status") {
    return getSessionStatuses(params);
  }
  return { ok: false, error: `Unknown action: ${action}` };
}
