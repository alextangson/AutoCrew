/**
 * Service Config — Tool/API configurations stored at ~/.autocrew/services.json
 *
 * Separate from creator-profile.json. This file tracks which external services
 * (LLM, cover gen, TTS, platforms, etc.) are configured and ready to use.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface OmniServiceConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface CoverGenConfig {
  provider: string;
  apiKey: string;
  model?: string;
}

export interface VideoCrawlerServiceConfig {
  type: "mediacrawl" | "playwright" | "manual";
  command?: string;
}

export interface TTSConfig {
  provider: string;
  baseUrl?: string;
  apiKey: string;
  voice?: string;
}

export interface PlatformAuthStatus {
  configured: boolean;
  lastAuth?: string;
}

export interface IntelSourcesStatus {
  rssConfigured: boolean;
  trendsConfigured: boolean;
  competitorsConfigured: boolean;
}

export interface ServiceConfig {
  omni?: OmniServiceConfig;
  coverGen?: CoverGenConfig;
  videoCrawler?: VideoCrawlerServiceConfig;
  tts?: TTSConfig;
  platforms?: Record<string, PlatformAuthStatus>;
  intelSources?: IntelSourcesStatus;
  configuredAt: string;
  updatedAt: string;
}

export interface ConfigGap {
  module: string;
  feature: string;
  impact: string;
}

const SERVICE_FILE = "services.json";

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

function emptyServiceConfig(): ServiceConfig {
  const now = new Date().toISOString();
  return {
    configuredAt: now,
    updatedAt: now,
  };
}

/**
 * Load the service config. Returns empty config if file doesn't exist.
 */
export async function loadServiceConfig(dataDir?: string): Promise<ServiceConfig> {
  const filePath = path.join(getDataDir(dataDir), SERVICE_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as ServiceConfig;
  } catch {
    return emptyServiceConfig();
  }
}

/**
 * Save the service config (overwrite). Updates the updatedAt timestamp.
 */
export async function saveServiceConfig(config: ServiceConfig, dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  config.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, SERVICE_FILE), JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Detect which service modules are unconfigured.
 * Returns a list of gaps with module name, feature description, and impact.
 */
export async function detectConfigGaps(dataDir?: string): Promise<ConfigGap[]> {
  const c = await loadServiceConfig(dataDir);
  const gaps: ConfigGap[] = [];

  if (!c.omni?.apiKey) {
    gaps.push({ module: "omni", feature: "视频分析 (Omni)", impact: "视频拆解功能不可用" });
  }

  if (!c.coverGen?.apiKey) {
    gaps.push({ module: "coverGen", feature: "封面生成", impact: "AI 封面生成不可用" });
  }

  if (!(c.videoCrawler && c.videoCrawler.type !== "manual")) {
    gaps.push({ module: "videoCrawler", feature: "视频采集器", impact: "视频链接下载需手动操作" });
  }

  if (!c.tts?.apiKey) {
    gaps.push({ module: "tts", feature: "TTS 语音合成", impact: "视频配音不可用" });
  }

  const hasConfiguredPlatform = c.platforms
    && Object.values(c.platforms).some((p) => p.configured);
  if (!hasConfiguredPlatform) {
    gaps.push({ module: "platforms", feature: "发布平台", impact: "自动发布不可用" });
  }

  const hasIntelSource = c.intelSources
    && (c.intelSources.rssConfigured || c.intelSources.trendsConfigured || c.intelSources.competitorsConfigured);
  if (!hasIntelSource) {
    gaps.push({ module: "intelSources", feature: "情报源", impact: "RSS/趋势/竞品监控为空" });
  }

  return gaps;
}
