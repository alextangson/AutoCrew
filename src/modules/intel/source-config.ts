import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { pipelinePath } from "../../storage/pipeline-store.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RssFeed {
  url: string;
  domain: string;
  tags?: string[];
}

export interface TrendSource {
  source: string;
  enabled?: boolean;
  region?: string;
  subreddits?: string[];
  min_score?: number;
  keywords?: string[];
  categories?: string[];
}

export interface CompetitorAccount {
  platform: string;
  name: string;
  id: string;
  domain: string;
}

export interface SourceConfig {
  rss: RssFeed[];
  trends: TrendSource[];
  accounts: CompetitorAccount[];
  keywords: string[];
}

export interface RecommendedSources {
  trends: TrendSource[];
  rssSuggestions: RssFeed[];
}

// ─── Source Config Loader ───────────────────────────────────────────────────

export async function loadSourceConfig(dataDir?: string): Promise<SourceConfig> {
  const sourcesDir = path.join(pipelinePath(dataDir), "intel", "_sources");
  const config: SourceConfig = {
    rss: [],
    trends: [],
    accounts: [],
    keywords: [],
  };

  let files: string[];
  try {
    files = (await fs.readdir(sourcesDir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return config;
  }

  for (const file of files) {
    const content = await fs.readFile(path.join(sourcesDir, file), "utf-8");
    const data = yaml.load(content) as Record<string, unknown> | null;
    if (!data) continue;

    if (Array.isArray(data.rss)) {
      config.rss.push(...(data.rss as RssFeed[]));
    }
    if (Array.isArray(data.trends)) {
      config.trends.push(...(data.trends as TrendSource[]));
    }
    if (Array.isArray(data.accounts)) {
      config.accounts.push(...(data.accounts as CompetitorAccount[]));
    }
    if (Array.isArray(data.keywords)) {
      config.keywords.push(...(data.keywords as string[]));
    }
  }

  return config;
}

// ─── Recommended Sources ────────────────────────────────────────────────────

interface PresetEntry {
  trends: TrendSource[];
  rss_suggestions: RssFeed[];
}

interface PresetsFile {
  presets: Record<string, PresetEntry>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRESETS_PATH = path.resolve(__dirname, "../../data/source-presets.yaml");

export async function getRecommendedSources(industry: string): Promise<RecommendedSources> {
  const content = await fs.readFile(PRESETS_PATH, "utf-8");
  const file = yaml.load(content) as PresetsFile;
  const presets = file.presets;

  // Exact match
  if (presets[industry]) {
    const preset = presets[industry];
    return {
      trends: preset.trends ?? [],
      rssSuggestions: preset.rss_suggestions ?? [],
    };
  }

  // Partial match — find first key that contains the industry string or vice versa
  for (const key of Object.keys(presets)) {
    if (key === "_default") continue;
    if (key.includes(industry) || industry.includes(key)) {
      const preset = presets[key];
      return {
        trends: preset.trends ?? [],
        rssSuggestions: preset.rss_suggestions ?? [],
      };
    }
  }

  // Default fallback
  const fallback = presets._default;
  return {
    trends: fallback?.trends ?? [],
    rssSuggestions: fallback?.rss_suggestions ?? [],
  };
}
