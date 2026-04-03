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

// ─── Intel Storage ──────────────────────────────────────────────────────────

export function intelToMarkdown(item: IntelItem): string {
  const frontmatter: Record<string, unknown> = {
    title: item.title,
    domain: item.domain,
    source: item.source,
    collected_at: item.collectedAt,
    relevance: item.relevance,
    tags: item.tags,
    expires_after: item.expiresAfter,
  };
  if (item.sourceUrl) frontmatter.source_url = item.sourceUrl;

  const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 }).trimEnd();

  const body = `# ${item.title}

## 摘要

${item.summary}

## 关键信息

${item.keyPoints.map((p) => `- ${p}`).join("\n")}

## 选题潜力

${item.topicPotential}
`;

  return `---\n${yamlStr}\n---\n\n${body}`;
}

export function parseIntelFile(content: string): IntelItem {
  const { data, content: body } = matter(content);

  const keyPointsMatch = body.match(/## 关键信息\n\n([\s\S]*?)(?:\n## |$)/);
  const keyPoints = keyPointsMatch
    ? keyPointsMatch[1]
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2))
    : [];

  const summaryMatch = body.match(/## 摘要\n\n([\s\S]*?)(?:\n## |$)/);
  const summary = summaryMatch ? summaryMatch[1].trim() : "";

  const potentialMatch = body.match(/## 选题潜力\n\n([\s\S]*?)$/);
  const topicPotential = potentialMatch ? potentialMatch[1].trim() : "";

  return {
    title: data.title,
    domain: data.domain,
    source: data.source,
    sourceUrl: data.source_url,
    collectedAt: data.collected_at,
    relevance: data.relevance,
    tags: data.tags ?? [],
    expiresAfter: data.expires_after,
    summary,
    keyPoints,
    topicPotential,
  };
}

export async function saveIntel(
  item: IntelItem,
  dataDir?: string,
): Promise<string> {
  await initPipeline(dataDir);
  const domainDir = path.join(stagePath("intel", dataDir), item.domain);
  await fs.mkdir(domainDir, { recursive: true });

  const slug = slugify(item.title);
  const datePrefix = item.collectedAt.slice(0, 10);
  const filename = `${datePrefix}-${slug}.md`;
  const filePath = path.join(domainDir, filename);

  // Dedup: check if a file with the same slug already exists
  try {
    const files = await fs.readdir(domainDir);
    const existing = files.find((f) => f.endsWith(`-${slug}.md`));
    if (existing) {
      const existingPath = path.join(domainDir, existing);
      await fs.writeFile(existingPath, intelToMarkdown(item), "utf-8");
      return existingPath;
    }
  } catch {
    // directory may not exist yet
  }

  await fs.writeFile(filePath, intelToMarkdown(item), "utf-8");
  return filePath;
}

export async function listIntel(
  domain?: string,
  dataDir?: string,
): Promise<IntelItem[]> {
  const intelDir = stagePath("intel", dataDir);
  const items: IntelItem[] = [];

  let domains: string[];
  try {
    const entries = await fs.readdir(intelDir, { withFileTypes: true });
    domains = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name);
  } catch {
    return [];
  }

  if (domain) {
    domains = domains.filter((d) => d === domain);
  }

  for (const d of domains) {
    const domainDir = path.join(intelDir, d);
    const files = await fs.readdir(domainDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const content = await fs.readFile(path.join(domainDir, f), "utf-8");
      items.push(parseIntelFile(content));
    }
  }

  items.sort(
    (a, b) =>
      new Date(b.collectedAt).getTime() - new Date(a.collectedAt).getTime(),
  );
  return items;
}

export async function archiveExpiredIntel(
  dataDir?: string,
): Promise<{ archived: number }> {
  const intelDir = stagePath("intel", dataDir);
  const archiveDir = path.join(intelDir, "_archive");
  await fs.mkdir(archiveDir, { recursive: true });

  let archived = 0;
  let domains: string[];
  try {
    const entries = await fs.readdir(intelDir, { withFileTypes: true });
    domains = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name);
  } catch {
    return { archived: 0 };
  }

  const now = Date.now();

  for (const d of domains) {
    const domainDir = path.join(intelDir, d);
    const files = await fs.readdir(domainDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const filePath = path.join(domainDir, f);
      const content = await fs.readFile(filePath, "utf-8");
      const item = parseIntelFile(content);
      const collectedMs = new Date(item.collectedAt).getTime();
      const expiresMs = item.expiresAfter * 24 * 60 * 60 * 1000;
      if (now - collectedMs > expiresMs) {
        await fs.rename(filePath, path.join(archiveDir, f));
        archived++;
      }
    }
  }

  return { archived };
}
