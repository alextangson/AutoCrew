import path from "node:path";
import fs from "node:fs/promises";
import matter from "gray-matter";
import yaml from "js-yaml";

// ─── Constants ───────────────────────────────────────────────────────────────

export const PIPELINE_STAGES = [
  "intel",
  "topics",
  "drafting",
  "production",
  "published",
  "trash",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME ?? ".",
  ".autocrew",
  "data",
);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IntelItem {
  title: string;
  domain: string;
  source: "web_search" | "rss" | "competitor" | "trend" | "manual";
  sourceUrl?: string;
  collectedAt: string;
  relevance: number;
  tags: string[];
  expiresAfter: number; // days
  summary: string;
  keyPoints: string[];
  topicPotential: string;
}

export interface TopicScore {
  heat: number;
  differentiation: number;
  audienceFit: number;
  overall: number;
}

export interface TopicCandidate {
  title: string;
  domain: string;
  score: TopicScore;
  formats: string[];
  suggestedPlatforms: string[];
  createdAt: string;
  intelRefs: string[];
  angles: string[];
  audienceResonance: string;
  references: string[];
}

export interface DraftVersion {
  file: string;
  createdAt: string;
  note: string;
}

export interface PlatformStatus {
  format: string;
  status: string;
}

export interface StageEntry {
  stage: PipelineStage;
  entered: string;
}

export interface ProjectMeta {
  title: string;
  domain: string;
  format: string;
  createdAt: string;
  sourceTopic: string;
  intelRefs: string[];
  versions: DraftVersion[];
  current: string;
  history: StageEntry[];
  platforms: PlatformStatus[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ─── Directory Init ─────────────────────────────────────────────────────────

export function pipelinePath(dataDir?: string): string {
  return path.join(dataDir ?? DEFAULT_DATA_DIR, "pipeline");
}

export function stagePath(stage: PipelineStage, dataDir?: string): string {
  return path.join(pipelinePath(dataDir), stage);
}

export async function initPipeline(dataDir?: string): Promise<void> {
  for (const stage of PIPELINE_STAGES) {
    await fs.mkdir(stagePath(stage, dataDir), { recursive: true });
  }
  // Intel sub-directories
  await fs.mkdir(path.join(stagePath("intel", dataDir), "_sources"), {
    recursive: true,
  });
  await fs.mkdir(path.join(stagePath("intel", dataDir), "_archive"), {
    recursive: true,
  });
}
