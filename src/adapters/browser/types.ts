export type BrowserPlatform =
  | "xiaohongshu"
  | "douyin"
  | "wechat_mp"
  | "wechat_video"
  | "bilibili";

export interface BrowserSessionStatus {
  platform: BrowserPlatform;
  loggedIn: boolean;
  profileName?: string;
  note?: string;
}

export interface ResearchItem {
  title: string;
  summary?: string;
  url?: string;
  author?: string;
  metrics?: Record<string, number | string>;
  platform: BrowserPlatform;
  source: "browser_cdp" | "browser_relay" | "api_provider" | "manual";
}

export interface BrowserResearchQuery {
  platform: BrowserPlatform;
  keyword: string;
  limit?: number;
}

export interface BrowserAdapter {
  id: string;
  description: string;
  getSessionStatus?(platform: BrowserPlatform): Promise<BrowserSessionStatus>;
  research(query: BrowserResearchQuery): Promise<ResearchItem[]>;
}
