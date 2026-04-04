import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DoubaoConfig {
  appId: string;
  accessToken: string;
  voiceType: string;
  cluster?: string;
}

export interface JianyingConfig {
  draftDir: string;
}

export interface StudioConfig {
  tts: {
    provider: "doubao";
    doubao?: DoubaoConfig;
  };
  screenshot: {
    provider: "puppeteer";
  };
  compositor: {
    provider: "ffmpeg" | "jianying";
    jianying?: JianyingConfig;
  };
}

const defaults: StudioConfig = {
  tts: { provider: "doubao" },
  screenshot: { provider: "puppeteer" },
  compositor: { provider: "jianying" },
};

export async function loadConfig(dataDir: string): Promise<StudioConfig> {
  try {
    const raw = await readFile(join(dataDir, "studio.config.json"), "utf-8");
    const parsed = JSON.parse(raw) as Partial<StudioConfig>;
    return { ...defaults, ...parsed };
  } catch {
    return { ...defaults };
  }
}
