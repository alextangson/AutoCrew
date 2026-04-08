import type { BrowserPlatform, ResearchItem } from "../browser/types.js";

export interface TikHubResearchQuery {
  platform: BrowserPlatform;
  keyword: string;
  limit?: number;
}

export async function researchWithTikHub(
  _query: TikHubResearchQuery,
): Promise<ResearchItem[]> {
  // TikHub adapter is not implemented — return empty to trigger proper fallback.
  // Previously returned fake placeholder items ("API 候选 1/2/3") which polluted
  // the topic pool with useless entries. Empty array forces research.ts to fall
  // through to free engine or return an actionable error with suggestion to use
  // autocrew_intel pull instead.
  return [];
}
