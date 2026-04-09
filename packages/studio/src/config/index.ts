import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DoubaoConfig {
  /** x-api-key from 豆包语音控制台 (preferred auth method) */
  apiKey?: string;
  /** App ID (optional, for legacy appid+token auth) */
  appId?: string;
  /** Access token (legacy auth, use apiKey instead) */
  accessToken?: string;
  /** Voice type ID, e.g. "S_9yYqs9VU1" for cloned voice or "BV700_V2_streaming" for built-in */
  voiceType: string;
  /** TTS cluster: "volcano_icl" for voice cloning, "volcano_tts" for standard voices */
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
