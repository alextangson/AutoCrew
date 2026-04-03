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

export interface PerformanceData {
  views?: number;
  completionRate?: number;
  likes?: number;
  saves?: number;
  comments?: number;
  shares?: number;
  topComments?: string[];
  collectedAt?: string;
}

export interface PerformanceLearning {
  contentId: string;
  rating: "viral" | "on_target" | "below_expectation";
  coreAttribution: "strong_title" | "good_hook" | "right_topic" | "timing" | "luck";
  hypothesisResult: "confirmed" | "rejected" | "inconclusive";
  learning: string;
  createdAt: string;
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
  hypothesis?: string;
  experimentType?: "title_test" | "hook_test" | "format_test" | "angle_test";
  controlRef?: string;
  hypothesisResult?: "confirmed" | "rejected" | "inconclusive";
  performanceData?: PerformanceData;
  performanceLearnings?: PerformanceLearning[];
  contentPillar?: string;
  commentTriggers?: Array<{ type: "controversy" | "unanswered_question" | "quote_hook"; position: string }>;
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

  // Extract key points from body
  const keyPointsMatch = body.match(/## 关键信息\n\n([\s\S]*?)(?:\n## |$)/);
  const keyPoints = keyPointsMatch
    ? keyPointsMatch[1]
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2))
    : [];

  // Extract summary
  const summaryMatch = body.match(/## 摘要\n\n([\s\S]*?)(?:\n## |$)/);
  const summary = summaryMatch ? summaryMatch[1].trim() : "";

  // Extract topic potential
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
      // Overwrite existing
      const existingPath = path.join(domainDir, existing);
      await fs.writeFile(existingPath, intelToMarkdown(item), "utf-8");
      return existingPath;
    }
  } catch {
    // directory may not exist yet, that's fine
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

// ─── Topic Pool ─────────────────────────────────────────────────────────────

export function topicToMarkdown(topic: TopicCandidate): string {
  const frontmatter: Record<string, unknown> = {
    title: topic.title,
    domain: topic.domain,
    score_heat: topic.score.heat,
    score_differentiation: topic.score.differentiation,
    score_audience_fit: topic.score.audienceFit,
    score_overall: topic.score.overall,
    formats: topic.formats,
    suggested_platforms: topic.suggestedPlatforms,
    created_at: topic.createdAt,
    intel_refs: topic.intelRefs,
    references: topic.references,
  };

  const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 }).trimEnd();

  const body = `# ${topic.title}

## 切入角度

${topic.angles.map((a) => `- ${a}`).join("\n")}

## 目标受众共鸣点

${topic.audienceResonance}

## 参考素材

${topic.references.map((r) => `- ${r}`).join("\n")}
`;

  return `---\n${yamlStr}\n---\n\n${body}`;
}

export function parseTopicFile(content: string): TopicCandidate {
  const { data, content: body } = matter(content);

  const anglesMatch = body.match(/## 切入角度\n\n([\s\S]*?)(?:\n## |$)/);
  const angles = anglesMatch
    ? anglesMatch[1]
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2))
    : [];

  const resonanceMatch = body.match(
    /## 目标受众共鸣点\n\n([\s\S]*?)(?:\n## |$)/,
  );
  const audienceResonance = resonanceMatch ? resonanceMatch[1].trim() : "";

  return {
    title: data.title,
    domain: data.domain,
    score: {
      heat: data.score_heat,
      differentiation: data.score_differentiation,
      audienceFit: data.score_audience_fit,
      overall: data.score_overall,
    },
    formats: data.formats ?? [],
    suggestedPlatforms: data.suggested_platforms ?? [],
    createdAt: data.created_at,
    intelRefs: data.intel_refs ?? [],
    angles,
    audienceResonance,
    references: data.references ?? [],
  };
}

export async function saveTopic(
  topic: TopicCandidate,
  dataDir?: string,
): Promise<string> {
  await initPipeline(dataDir);
  const topicsDir = stagePath("topics", dataDir);
  const filename = `${slugify(topic.domain)}-${slugify(topic.title)}.md`;
  const filePath = path.join(topicsDir, filename);
  await fs.writeFile(filePath, topicToMarkdown(topic), "utf-8");
  return filePath;
}

export async function listTopics(
  domain?: string,
  dataDir?: string,
): Promise<TopicCandidate[]> {
  const topicsDir = stagePath("topics", dataDir);
  const items: TopicCandidate[] = [];

  let files: string[];
  try {
    files = await fs.readdir(topicsDir);
  } catch {
    return [];
  }

  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const content = await fs.readFile(path.join(topicsDir, f), "utf-8");
    const topic = parseTopicFile(content);
    if (domain && topic.domain !== domain) continue;
    items.push(topic);
  }

  items.sort((a, b) => b.score.overall - a.score.overall);
  return items;
}

export async function decayTopicScores(
  dataDir?: string,
): Promise<{ decayed: number; trashed: number }> {
  const topicsDir = stagePath("topics", dataDir);
  const trashDir = stagePath("trash", dataDir);
  await fs.mkdir(trashDir, { recursive: true });

  let decayed = 0;
  let trashed = 0;

  let files: string[];
  try {
    files = await fs.readdir(topicsDir);
  } catch {
    return { decayed: 0, trashed: 0 };
  }

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DECAY_AFTER_DAYS = 14;
  const DECAY_PER_DAY = 2;
  const TRASH_THRESHOLD = 20;

  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const filePath = path.join(topicsDir, f);
    const content = await fs.readFile(filePath, "utf-8");
    const topic = parseTopicFile(content);
    const createdMs = new Date(topic.createdAt).getTime();
    const ageDays = (now - createdMs) / DAY_MS;

    if (ageDays <= DECAY_AFTER_DAYS) continue;

    const decayDays = ageDays - DECAY_AFTER_DAYS;
    const decayAmount = Math.floor(decayDays) * DECAY_PER_DAY;

    topic.score.overall = Math.max(0, topic.score.overall - decayAmount);
    decayed++;

    if (topic.score.overall < TRASH_THRESHOLD) {
      await fs.rename(filePath, path.join(trashDir, f));
      trashed++;
    } else {
      await fs.writeFile(filePath, topicToMarkdown(topic), "utf-8");
    }
  }

  return { decayed, trashed };
}

// ─── Project Lifecycle ──────────────────────────────────────────────────────

export async function readMeta(dir: string): Promise<ProjectMeta> {
  const content = await fs.readFile(path.join(dir, "meta.yaml"), "utf-8");
  return yaml.load(content) as ProjectMeta;
}

export async function writeMeta(dir: string, meta: ProjectMeta): Promise<void> {
  await fs.writeFile(
    path.join(dir, "meta.yaml"),
    yaml.dump(meta, { lineWidth: -1 }),
    "utf-8",
  );
}

export async function findProject(
  name: string,
  dataDir?: string,
): Promise<{ dir: string; stage: PipelineStage } | null> {
  for (const stage of PIPELINE_STAGES) {
    if (stage === "intel" || stage === "topics") continue;
    const dir = path.join(stagePath(stage, dataDir), name);
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) return { dir, stage };
    } catch {
      // not here
    }
  }
  return null;
}

export async function startProject(
  topicSlug: string,
  dataDir?: string,
): Promise<string> {
  await initPipeline(dataDir);
  const topicsDir = stagePath("topics", dataDir);

  // Find the topic file
  const files = await fs.readdir(topicsDir);
  const topicFile = files.find(
    (f) => f.endsWith(".md") && f.includes(topicSlug),
  );
  if (!topicFile) throw new Error(`Topic not found: ${topicSlug}`);

  const content = await fs.readFile(
    path.join(topicsDir, topicFile),
    "utf-8",
  );
  const topic = parseTopicFile(content);
  const projectName = slugify(topic.title);

  const projectDir = path.join(stagePath("drafting", dataDir), projectName);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(path.join(projectDir, "references"), { recursive: true });

  const now = new Date().toISOString();

  const meta: ProjectMeta = {
    title: topic.title,
    domain: topic.domain,
    format: topic.formats[0] ?? "article",
    createdAt: now,
    sourceTopic: topicFile,
    intelRefs: topic.intelRefs,
    versions: [{ file: "draft-v1.md", createdAt: now, note: "initial draft" }],
    current: "draft-v1.md",
    history: [{ stage: "drafting", entered: now }],
    platforms: [],
  };

  await writeMeta(projectDir, meta);
  await fs.writeFile(
    path.join(projectDir, "draft-v1.md"),
    `# ${topic.title}\n\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(projectDir, "draft.md"),
    `# ${topic.title}\n\n`,
    "utf-8",
  );

  // Remove topic file
  await fs.unlink(path.join(topicsDir, topicFile));

  return projectDir;
}

const STAGE_ORDER: PipelineStage[] = ["drafting", "production", "published"];

export async function advanceProject(
  name: string,
  dataDir?: string,
): Promise<string> {
  const found = await findProject(name, dataDir);
  if (!found) throw new Error(`Project not found: ${name}`);

  const currentIdx = STAGE_ORDER.indexOf(found.stage);
  if (currentIdx === -1 || currentIdx >= STAGE_ORDER.length - 1) {
    throw new Error(`Cannot advance from stage: ${found.stage}`);
  }

  const nextStage = STAGE_ORDER[currentIdx + 1];
  const newDir = path.join(stagePath(nextStage, dataDir), name);

  await fs.rename(found.dir, newDir);

  const meta = await readMeta(newDir);
  meta.history.push({ stage: nextStage, entered: new Date().toISOString() });
  await writeMeta(newDir, meta);

  return newDir;
}

export async function addDraftVersion(
  name: string,
  content: string,
  note: string,
  dataDir?: string,
): Promise<string> {
  const found = await findProject(name, dataDir);
  if (!found) throw new Error(`Project not found: ${name}`);

  const meta = await readMeta(found.dir);
  const versionNum = meta.versions.length + 1;
  const filename = `draft-v${versionNum}.md`;

  await fs.writeFile(path.join(found.dir, filename), content, "utf-8");
  // Update draft.md to latest content
  await fs.writeFile(path.join(found.dir, "draft.md"), content, "utf-8");

  meta.versions.push({
    file: filename,
    createdAt: new Date().toISOString(),
    note,
  });
  meta.current = filename;
  await writeMeta(found.dir, meta);

  return path.join(found.dir, filename);
}

export async function trashProject(
  name: string,
  dataDir?: string,
): Promise<void> {
  const found = await findProject(name, dataDir);
  if (!found) throw new Error(`Project not found: ${name}`);

  const trashDir = path.join(stagePath("trash", dataDir), name);
  await fs.rename(found.dir, trashDir);

  const meta = await readMeta(trashDir);
  meta.history.push({ stage: "trash", entered: new Date().toISOString() });
  await writeMeta(trashDir, meta);
}

export async function restoreProject(
  name: string,
  dataDir?: string,
): Promise<string> {
  const trashDir = path.join(stagePath("trash", dataDir), name);
  const meta = await readMeta(trashDir);

  // Find the previous stage (the one before trash)
  const previousEntry = meta.history
    .filter((h) => h.stage !== "trash")
    .at(-1);
  const restoreStage = previousEntry?.stage ?? "drafting";

  const newDir = path.join(stagePath(restoreStage, dataDir), name);
  await fs.rename(trashDir, newDir);

  meta.history.push({
    stage: restoreStage,
    entered: new Date().toISOString(),
  });
  await writeMeta(newDir, meta);

  return newDir;
}

export async function getProjectMeta(
  name: string,
  dataDir?: string,
): Promise<ProjectMeta | null> {
  const found = await findProject(name, dataDir);
  if (!found) return null;
  return readMeta(found.dir);
}

export async function listProjects(
  stage: PipelineStage,
  dataDir?: string,
): Promise<string[]> {
  const dir = stagePath(stage, dataDir);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
