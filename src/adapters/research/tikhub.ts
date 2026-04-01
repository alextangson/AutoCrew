import type { BrowserPlatform, ResearchItem } from "../browser/types.js";

export interface TikHubResearchQuery {
  platform: BrowserPlatform;
  keyword: string;
  limit?: number;
}

export async function researchWithTikHub(
  query: TikHubResearchQuery,
): Promise<ResearchItem[]> {
  const limit = query.limit || 5;
  return Array.from({ length: limit }).map((_, index) => ({
    title: `${query.keyword} API 候选 ${index + 1}`,
    summary: "TikHub fallback placeholder. Replace with a real provider call only when browser-first mode is unavailable.",
    platform: query.platform,
    source: "api_provider",
  }));
}
