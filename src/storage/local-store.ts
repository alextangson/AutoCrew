import path from "node:path";
import fs from "node:fs/promises";
import { isContentId, isSafeFilename, isTopicId } from "./entity-id.js";

export interface Topic {
  id: string;
  title: string;
  description: string;
  tags: string[];
  source?: string;
  /** 入库理由——「为什么值得你写」（IA v4.2 §4：无理由的灵感库 = RSS 收件箱） */
  reason?: string;
  /** 证据链接（雷达原文/对标文章），派活时随 brief 下发 */
  link?: string;
  /** 海外源/项目的原始标题；title 保存加工后的中文可写选题。 */
  originalTitle?: string;
  /** 选题综合分 0-100。 */
  score?: number;
  scoreBreakdown?: {
    audienceFit: number;
    materialRichness: number;
    novelty: number;
    timeliness: number;
  };
  /** 可以直接派给写手展开的角度。 */
  angles?: string[];
  scoredAt?: string;
  createdAt: string;
  /** 软删除时间戳(回收站语义,qingmo 设计细节);null/缺省 = 活跃 */
  deletedAt?: string | null;
}

export interface Asset {
  filename: string;
  type: "cover" | "broll" | "image" | "video" | "audio" | "subtitle" | "other";
  description?: string;
  addedAt: string;
}

export interface ContentVersion {
  version: number;
  /** 该版本对应的标题；旧数据可能缺失。 */
  title?: string;
  body: string;
  note?: string;
  savedAt: string;
}

export type ContentStatus =
  | "topic_saved"
  | "drafting"
  | "draft_ready"
  | "reviewing"
  | "revision"
  | "approved"
  | "cover_pending"
  | "publish_ready"
  | "publishing"
  | "published"
  | "archived";

/** Legacy status values for backward compatibility */
export type LegacyContentStatus = "draft" | "review";

/** All accepted status values (new + legacy) */
export type AnyContentStatus = ContentStatus | LegacyContentStatus;

/** Map legacy status to new status */
export function normalizeLegacyStatus(s: string): ContentStatus {
  if (s === "draft") return "draft_ready";
  if (s === "review") return "reviewing";
  return s as ContentStatus;
}

/** 采纳裁决（PRD-v4 §8 北极星读数）：口径 = 主观判定，light_edit =「轻改即用」，rewritten =「推倒重写」（裁决 B） */
export type AdoptionVerdict = "adopted" | "light_edit" | "rewritten";

/** 重写原因 chip（IA v4.2 §B6）——最强负信号的一次点击标注，可选，喂纠正路由 */
export type RewriteReason = "style_mismatch" | "factual_error" | "structure_bad";

/** 分镜行（V5.4b）:一镜一行,给拍摄/剪辑用 */
export interface StoryboardShot {
  /** 景别/机位,如「近景怼脸」「中景+屏幕」 */
  shot: string;
  /** 画面内容 */
  visual: string;
  /** 对应口播句(节选) */
  line: string;
  /** 字幕/贴纸/转场提示(可空) */
  overlay?: string;
}

/** 视频发布件（V5.4b）:平台原生发布物料,与口播稿分离存储 */
export interface VideoKit {
  platform: string;
  /** 平台发布标题(按平台字数纪律:小红书 ≤20 字等)——创始人 2026-07-08 裁决:发布配套要齐 */
  postTitle: string;
  /** 平台发布文案(含话题标签,可直接粘贴) */
  caption: string;
  storyboard: StoryboardShot[];
  /** 封面大字(≤8字) */
  coverText: string;
  /** 封面生图 prompt(竖版) */
  coverPrompt: string;
  /** 已生成的封面图路径(相对稿件目录;未生成则缺省) */
  coverPath?: string;
  generatedAt: string;
}

export interface AdoptionRecord {
  verdict: AdoptionVerdict;
  /** 仅 rewritten 时可选携带（§10-B 低摩擦裁决不变：一次点击，可跳过） */
  reason?: RewriteReason;
  /** 自由文本原因（IA v5 V5.0:「哪里不行」不只选择题）——风格蒸馏的高价值负信号,与 chip 归类字段分开 */
  reasonNote?: string;
  recordedAt: string;
}

export interface Content {
  id: string;
  title: string;
  body: string;
  platform?: string;
  topicId?: string;
  status: ContentStatus;
  tags: string[];
  /** IDs of sibling content (same topic, different platforms) */
  siblings: string[];
  /** Platform-specific hashtags */
  hashtags: string[];
  /** ISO timestamp when published */
  publishedAt: string | null;
  /** URL on the target platform after publishing */
  publishUrl: string | null;
  /** Platform performance metrics (views, likes, comments, shares, etc.) */
  performanceData: Record<string, number>;
  /** 采纳裁决（三键落库；未裁决 = 不参与采纳率分母） */
  adoption?: AdoptionRecord;
  /** 视频发布件（IA v5 V5.4b）:发布文案/分镜/封面——口播稿是"读的",发布件是"发的" */
  videoKit?: VideoKit;
  /** 最近一次生成/处理失败的原因（防呆:失败留痕,成功后清空）。UI 据此显示中断徽章与重试 */
  lastError?: string | null;
  /** 软删除时间戳(回收站语义);null/缺省 = 活跃。默认读侧全部过滤 */
  deletedAt?: string | null;
  assets: Asset[];
  versions: ContentVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface CoverVariant {
  label: "a" | "b" | "c";
  /** Full image generation prompt used */
  imagePrompt?: string;
  /** Content-specific art direction, not a fixed template name */
  style?: string;
  /** Unique visual idea/metaphor for this candidate */
  creativeConcept?: string;
  /** Production medium, e.g. documentary photo / paper collage */
  visualMedium?: string;
  /** Color and material direction */
  palette?: string;
  /** Chinese title text on the cover (2-9 chars) */
  titleText?: string;
  /** Generated image paths by aspect ratio */
  imagePaths: {
    "3:4"?: string;
    "16:9"?: string;
    "4:3"?: string;
    /** 公众号横版(21:9/16:9 原生出图后垂直裁切) */
    "2.35:1"?: string;
  };
  /** 修订轮次(反馈重做递增;文件名带 -rN 防浏览器缓存旧图) */
  revision?: number;
  /** Model used for generation */
  model?: string;
  /** Whether personal IP reference photos were used */
  hasPersonalIP?: boolean;
  /** Layout description */
  layoutHint?: string;
  /** Design reasoning (for display) */
  designReason?: string;
  // Legacy fields (kept for backward compat)
  titleMain?: string;
  titleSub?: string;
  titleLayout?: string;
  stopTrigger?: string;
  keyMoment?: string;
  hookText?: string;
  renderPrompt?: string;
  seedreamPrompt?: string;
  prototypeId?: string;
  prototypeName?: string;
  sourceCategory?: string;
  imagePath?: string;
}

export interface CoverReview {
  platform: string;
  /** Whether concepts came from the LLM art director or the rotating local fallback pool */
  designSource?: "designer" | "hybrid" | "rules";
  /** 候选目标数与逐张失败原因；部分成功也必须可见、可选。 */
  expectedVariantCount?: number;
  generationErrors?: string[];
  /** 候选生成时选定的主比例(横屏 16:9/4:3 = B站/抖音PC;2.35:1 = 公众号超宽横幅);缺省 3:4 */
  primaryRatio?: "3:4" | "16:9" | "4:3" | "2.35:1";
  status: "review_pending" | "approved" | "publish_ready";
  stopReason?: string;
  coverHook?: string;
  variants: CoverVariant[];
  approvedLabel?: "a" | "b" | "c";
  approvedImagePath?: string;
  approvedAt?: string;
  notes?: string;
  /** 反馈重做历史(封面「纠正即训练」的原始记录) */
  feedback?: Array<{ label: "a" | "b" | "c"; note: string; prevPrompt?: string; at: string }>;
  createdAt?: string;
  updatedAt?: string;
}

export function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  // 工作区可重定向：冒烟/测试用隔离目录，多工作区切换的地基（IA v4.2 工程线）
  if (process.env.AUTOCREW_DATA_DIR) return process.env.AUTOCREW_DATA_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// --- Topics ---

async function topicsDir(dataDir?: string): Promise<string> {
  const dir = path.join(getDataDir(dataDir), "topics");
  await ensureDir(dir);
  return dir;
}

export async function saveTopic(topic: Omit<Topic, "id" | "createdAt">, dataDir?: string): Promise<Topic> {
  const dir = await topicsDir(dataDir);
  const id = `topic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const full: Topic = {
    ...topic,
    id,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(full, null, 2), "utf-8");
  return full;
}

export async function listTopics(dataDir?: string): Promise<Topic[]> {
  const dir = await topicsDir(dataDir);
  const files = await fs.readdir(dir);
  const topics: Topic[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(dir, f), "utf-8");
    topics.push(JSON.parse(raw));
  }
  return topics.filter((t) => !t.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTopic(id: string, dataDir?: string): Promise<Topic | null> {
  if (!isTopicId(id)) return null;
  const dir = await topicsDir(dataDir);
  try {
    const raw = await fs.readFile(path.join(dir, `${id}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeTopic(topic: Topic, dataDir?: string): Promise<void> {
  if (!isTopicId(topic.id)) throw new Error("Invalid topic id");
  const dir = await topicsDir(dataDir);
  await fs.writeFile(path.join(dir, `${topic.id}.json`), JSON.stringify(topic, null, 2), "utf-8");
}

/** 更新灵感加工结果（中文标题、评分、角度等）；id/createdAt 不允许被覆盖。 */
export async function updateTopic(
  id: string,
  updates: Partial<Omit<Topic, "id" | "createdAt">>,
  dataDir?: string,
): Promise<Topic | null> {
  const topic = await getTopic(id, dataDir);
  if (!topic) return null;
  const next: Topic = { ...topic, ...updates, id: topic.id, createdAt: topic.createdAt };
  await writeTopic(next, dataDir);
  return next;
}

/** 选题移入回收站(软删除,可恢复)。不存在 → null */
export async function softDeleteTopic(id: string, dataDir?: string): Promise<Topic | null> {
  const topic = await getTopic(id, dataDir);
  if (!topic) return null;
  topic.deletedAt = new Date().toISOString();
  await writeTopic(topic, dataDir);
  return topic;
}

export async function restoreTopic(id: string, dataDir?: string): Promise<Topic | null> {
  const topic = await getTopic(id, dataDir);
  if (!topic) return null;
  topic.deletedAt = null;
  await writeTopic(topic, dataDir);
  return topic;
}

// --- Contents ---

async function contentsDir(dataDir?: string): Promise<string> {
  const dir = path.join(getDataDir(dataDir), "contents");
  await ensureDir(dir);
  return dir;
}

/**
 * Each content is stored as a project directory:
 *   contents/{id}/
 *     meta.json       — metadata (title, status, tags, assets, versions index)
 *     draft.md        — current body as readable markdown
 *     assets/         — media files (covers, broll, images, videos)
 *     versions/       — version history (v1.md, v2.md, ...)
 */
async function contentProjectDir(id: string, dataDir?: string): Promise<string> {
  if (!isContentId(id)) throw new Error("Invalid content id");
  const dir = path.join(getDataDir(dataDir), "contents", id);
  await ensureDir(dir);
  await ensureDir(path.join(dir, "assets"));
  await ensureDir(path.join(dir, "versions"));
  return dir;
}

export async function saveContent(
  content: Omit<Content, "id" | "createdAt" | "updatedAt" | "assets" | "versions" | "siblings" | "hashtags" | "publishedAt" | "publishUrl" | "performanceData"> & Partial<Pick<Content, "siblings" | "hashtags" | "publishedAt" | "publishUrl" | "performanceData">>,
  dataDir?: string,
): Promise<Content> {
  const id = `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const projDir = await contentProjectDir(id, dataDir);

  const full: Content = {
    ...content,
    id,
    siblings: content.siblings ?? [],
    hashtags: content.hashtags ?? [],
    publishedAt: content.publishedAt ?? null,
    publishUrl: content.publishUrl ?? null,
    performanceData: content.performanceData ?? {},
    assets: [],
    versions: [{ version: 1, title: content.title, body: content.body, note: "初稿", savedAt: now }],
    createdAt: now,
    updatedAt: now,
  };

  // Write meta.json
  await fs.writeFile(path.join(projDir, "meta.json"), JSON.stringify(full, null, 2), "utf-8");
  // Write readable draft.md
  await fs.writeFile(path.join(projDir, "draft.md"), `# ${content.title}\n\n${content.body}\n`, "utf-8");
  // Write version snapshot
  await fs.writeFile(path.join(projDir, "versions", "v1.md"), content.body, "utf-8");

  return full;
}

/**
 * Normalize a content's status at the read boundary so no downstream consumer
 * ever sees a legacy value. Write paths already normalize (content-save.ts), but
 * pre-S2.7 drafts on disk can still carry "draft"/"review"; normalizing here means
 * every list/get reader (renderer panels, dashboard, flywheel, baselines) is covered
 * in one place. normalizeLegacyStatus is idempotent, so new statuses pass through.
 */
function withNormalizedStatus(c: Content): Content {
  return { ...c, status: normalizeLegacyStatus(c.status) };
}

export async function listContents(dataDir?: string): Promise<Content[]> {
  const dir = path.join(getDataDir(dataDir), "contents");
  await ensureDir(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const contents: Content[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(dir, entry.name, "meta.json");
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      contents.push(JSON.parse(raw));
    } catch {
      // Legacy flat JSON file support (DEPRECATED — will be removed in v0.3.0)
      if (entry.name.endsWith(".json")) {
        try {
          console.warn(`[autocrew] DEPRECATED: Legacy flat file "${entry.name}" detected. Run migration to project-directory format.`);
          const raw = await fs.readFile(path.join(dir, entry.name), "utf-8");
          contents.push(JSON.parse(raw));
        } catch { /* skip */ }
      }
    }
  }
  // Also read any legacy flat .json files at the contents/ level (DEPRECATED — will be removed in v0.3.0)
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), "utf-8");
      const parsed = JSON.parse(raw);
      if (!contents.find(c => c.id === parsed.id)) {
        contents.push(parsed);
      }
    } catch { /* skip */ }
  }
  return contents
    .filter((c) => !c.deletedAt)
    .map(withNormalizedStatus)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 读全量含已删(回收站专用)。日常读侧一律走 listContents(已过滤) */
async function listContentsRaw(dataDir?: string): Promise<Content[]> {
  const dir = path.join(getDataDir(dataDir), "contents");
  await ensureDir(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const contents: Content[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      contents.push(JSON.parse(await fs.readFile(path.join(dir, entry.name, "meta.json"), "utf-8")));
    } catch { /* skip */ }
  }
  return contents.map(withNormalizedStatus).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 稿件移入回收站(软删除,可恢复)。不存在 → null */
export async function softDeleteContent(id: string, dataDir?: string): Promise<Content | null> {
  return updateContent(id, { deletedAt: new Date().toISOString() }, dataDir);
}

export async function restoreContent(id: string, dataDir?: string): Promise<Content | null> {
  return updateContent(id, { deletedAt: null }, dataDir);
}

export interface TrashList {
  topics: Topic[];
  contents: Content[];
}

/** 回收站聚合(qingmo 设计细节:已删选题 + 已删稿件一屏,可逐项恢复) */
export async function listTrash(dataDir?: string): Promise<TrashList> {
  const dir = await topicsDir(dataDir);
  const files = await fs.readdir(dir);
  const topics: Topic[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const t = JSON.parse(await fs.readFile(path.join(dir, f), "utf-8")) as Topic;
      if (t.deletedAt) topics.push(t);
    } catch { /* skip */ }
  }
  const contents = (await listContentsRaw(dataDir)).filter((c) => c.deletedAt);
  return {
    topics: topics.sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || "")),
    contents,
  };
}

export async function getContent(id: string, dataDir?: string): Promise<Content | null> {
  if (!isContentId(id)) return null;
  const projDir = path.join(getDataDir(dataDir), "contents", id);
  try {
    const raw = await fs.readFile(path.join(projDir, "meta.json"), "utf-8");
    return withNormalizedStatus(JSON.parse(raw));
  } catch {
    // Legacy flat file fallback (DEPRECATED — will be removed in v0.3.0)
    const legacyPath = path.join(getDataDir(dataDir), "contents", `${id}.json`);
    try {
      console.warn(`[autocrew] DEPRECATED: Reading legacy flat file for content "${id}". Run migration to project-directory format.`);
      const raw = await fs.readFile(legacyPath, "utf-8");
      return withNormalizedStatus(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}

export type ContentUpdates = Partial<Content> & { _versionNote?: string };

export async function updateContent(id: string, updates: ContentUpdates, dataDir?: string): Promise<Content | null> {
  if (!isContentId(id)) return null;
  const projDir = path.join(getDataDir(dataDir), "contents", id);
  const metaPath = path.join(projDir, "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const existing: Content = JSON.parse(raw);
    const now = new Date().toISOString();

    // 正文或标题变化都形成新版本；版本不再只记录 body，标题优化也可追溯。
    const bodyChanged = updates.body !== undefined && updates.body !== existing.body;
    const titleChanged = updates.title !== undefined && updates.title !== existing.title;
    if (bodyChanged || titleChanged) {
      const nextVersion = (existing.versions?.length || 0) + 1;
      const versionEntry: ContentVersion = {
        version: nextVersion,
        title: updates.title ?? existing.title,
        body: updates.body ?? existing.body,
        note: updates._versionNote || `第 ${nextVersion} 版`,
        savedAt: now,
      };
      existing.versions = [...(existing.versions || []), versionEntry];
      // Write version snapshot
      await fs.writeFile(
        path.join(projDir, "versions", `v${nextVersion}.md`),
        versionEntry.body,
        "utf-8",
      );
    }

    const updated: Content = {
      ...existing,
      ...updates,
      id: existing.id,
      assets: updates.assets || existing.assets || [],
      versions: existing.versions,
      siblings: updates.siblings || existing.siblings || [],
      hashtags: updates.hashtags || existing.hashtags || [],
      publishedAt: updates.publishedAt !== undefined ? updates.publishedAt : existing.publishedAt ?? null,
      publishUrl: updates.publishUrl !== undefined ? updates.publishUrl : existing.publishUrl ?? null,
      performanceData: updates.performanceData || existing.performanceData || {},
      createdAt: existing.createdAt,
      updatedAt: now,
    };

    await fs.writeFile(metaPath, JSON.stringify(updated, null, 2), "utf-8");
    // Update readable draft
    await fs.writeFile(
      path.join(projDir, "draft.md"),
      `# ${updated.title}\n\n${updated.body}\n`,
      "utf-8",
    );

    return updated;
  } catch {
    return null;
  }
}

// --- Assets ---

/** 采纳裁决三键落库（PRD-v4 §8：北极星「采纳率」的读数来源）。重复裁决 = 覆盖（改判允许） */
export async function recordAdoption(
  id: string,
  verdict: AdoptionVerdict,
  dataDir?: string,
  reason?: RewriteReason,
  reasonNote?: string,
): Promise<Content | null> {
  return updateContent(id, {
    adoption: {
      verdict,
      ...(verdict === "rewritten" && reason ? { reason } : {}),
      ...(verdict === "rewritten" && reasonNote ? { reasonNote } : {}),
      recordedAt: new Date().toISOString(),
    },
  }, dataDir);
}

export interface AdoptionStats {
  /** 已裁决稿数（分母） */
  judged: number;
  adopted: number;
  lightEdit: number;
  rewritten: number;
  /** 采纳率 = (采纳 + 轻改) / 已裁决；无裁决时 null（不显示假 0%） */
  rate: number | null;
}

export async function adoptionStats(dataDir?: string): Promise<AdoptionStats> {
  const contents = await listContents(dataDir);
  const judged = contents.filter((c) => c.adoption);
  const count = (v: AdoptionVerdict) => judged.filter((c) => c.adoption?.verdict === v).length;
  const adopted = count("adopted");
  const lightEdit = count("light_edit");
  return {
    judged: judged.length,
    adopted,
    lightEdit,
    rewritten: count("rewritten"),
    rate: judged.length === 0 ? null : (adopted + lightEdit) / judged.length,
  };
}

export async function addAsset(
  contentId: string,
  asset: { filename: string; type: Asset["type"]; description?: string; sourcePath?: string },
  dataDir?: string,
): Promise<{ ok: boolean; asset?: Asset; error?: string }> {
  if (!isContentId(contentId)) return { ok: false, error: "Invalid content id" };
  if (!isSafeFilename(asset.filename)) return { ok: false, error: "Invalid asset filename" };
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  const metaPath = path.join(projDir, "meta.json");

  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const content: Content = JSON.parse(raw);
    const now = new Date().toISOString();

    // Copy source file into assets/ if provided
    if (asset.sourcePath) {
      const destPath = path.join(projDir, "assets", asset.filename);
      await fs.copyFile(asset.sourcePath, destPath);
    }

    const newAsset: Asset = {
      filename: asset.filename,
      type: asset.type,
      description: asset.description,
      addedAt: now,
    };

    content.assets = [...(content.assets || []), newAsset];
    content.updatedAt = now;
    await fs.writeFile(metaPath, JSON.stringify(content, null, 2), "utf-8");

    return { ok: true, asset: newAsset };
  } catch {
    return { ok: false, error: `Content ${contentId} not found` };
  }
}

export async function listAssets(contentId: string, dataDir?: string): Promise<Asset[]> {
  if (!isContentId(contentId)) return [];
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  try {
    const raw = await fs.readFile(path.join(projDir, "meta.json"), "utf-8");
    const content: Content = JSON.parse(raw);
    return content.assets || [];
  } catch {
    return [];
  }
}

export async function removeAsset(contentId: string, filename: string, dataDir?: string): Promise<boolean> {
  if (!isContentId(contentId) || !isSafeFilename(filename)) return false;
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  const metaPath = path.join(projDir, "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const content: Content = JSON.parse(raw);
    content.assets = (content.assets || []).filter(a => a.filename !== filename);
    content.updatedAt = new Date().toISOString();
    await fs.writeFile(metaPath, JSON.stringify(content, null, 2), "utf-8");
    // Also delete the file
    try { await fs.unlink(path.join(projDir, "assets", filename)); } catch { /* ok */ }
    return true;
  } catch {
    return false;
  }
}

// --- Versions ---

export async function listVersions(contentId: string, dataDir?: string): Promise<ContentVersion[]> {
  if (!isContentId(contentId)) return [];
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  try {
    const raw = await fs.readFile(path.join(projDir, "meta.json"), "utf-8");
    const content: Content = JSON.parse(raw);
    return content.versions || [];
  } catch {
    return [];
  }
}

export async function getVersion(contentId: string, version: number, dataDir?: string): Promise<string | null> {
  if (!isContentId(contentId) || !Number.isInteger(version) || version < 1) return null;
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  try {
    return await fs.readFile(path.join(projDir, "versions", `v${version}.md`), "utf-8");
  } catch {
    return null;
  }
}

export async function revertToVersion(contentId: string, version: number, dataDir?: string): Promise<Content | null> {
  const [body, versions] = await Promise.all([
    getVersion(contentId, version, dataDir),
    listVersions(contentId, dataDir),
  ]);
  if (body === null) return null;
  const target = versions.find((item) => item.version === version);
  return updateContent(
    contentId,
    { body, ...(target?.title ? { title: target.title } : {}), _versionNote: `回滚到 v${version}` },
    dataDir,
  );
}

// --- Cover review ---

export async function saveCoverReview(
  contentId: string,
  review: Omit<CoverReview, "updatedAt">,
  dataDir?: string,
): Promise<CoverReview | null> {
  if (!isContentId(contentId)) return null;
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  const metaPath = path.join(projDir, "meta.json");
  const reviewPath = path.join(projDir, "cover-review.json");

  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const content: Content = JSON.parse(raw);
    const now = new Date().toISOString();
    // createdAt 保留首次值——反馈重做会反复保存,历史起点不许被覆盖
    const full: CoverReview = {
      ...review,
      createdAt: review.createdAt ?? now,
      updatedAt: now,
    };

    await fs.writeFile(reviewPath, JSON.stringify(full, null, 2), "utf-8");
    content.updatedAt = now;
    await fs.writeFile(metaPath, JSON.stringify(content, null, 2), "utf-8");
    return full;
  } catch {
    return null;
  }
}

export async function getCoverReview(contentId: string, dataDir?: string): Promise<CoverReview | null> {
  if (!isContentId(contentId)) return null;
  const reviewPath = path.join(getDataDir(dataDir), "contents", contentId, "cover-review.json");
  try {
    const raw = await fs.readFile(reviewPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function approveCoverVariant(
  contentId: string,
  label: "a" | "b" | "c",
  dataDir?: string,
): Promise<CoverReview | null> {
  if (!isContentId(contentId)) return null;
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  const reviewPath = path.join(projDir, "cover-review.json");
  const metaPath = path.join(projDir, "meta.json");

  try {
    const [reviewRaw, metaRaw] = await Promise.all([
      fs.readFile(reviewPath, "utf-8"),
      fs.readFile(metaPath, "utf-8"),
    ]);
    const review: CoverReview = JSON.parse(reviewRaw);
    const content: Content = JSON.parse(metaRaw);
    const selected = review.variants.find((variant) => variant.label === label);
    if (!selected) {
      return null;
    }

    const now = new Date().toISOString();
    review.status = "publish_ready";
    review.approvedLabel = label;
    // 修复存量 bug:create_candidates 只写 imagePaths,旧字段 imagePath 从未赋值。
    // 主比例可选(V5.6.1 横屏封面),取主比例成图,再兜底其他比例
    review.approvedImagePath =
      selected.imagePaths?.[review.primaryRatio ?? "3:4"] ??
      selected.imagePaths?.["3:4"] ??
      selected.imagePaths?.["16:9"] ??
      selected.imagePaths?.["4:3"] ??
      selected.imagePath;
    review.approvedAt = now;
    review.updatedAt = now;
    // 修复存量 bug:选封面不许把已进发布链的稿件倒拨回 approved
    const protectedStatuses: ContentStatus[] = ["publish_ready", "publishing", "published", "archived"];
    if (!protectedStatuses.includes(content.status)) {
      content.status = "approved";
    }
    content.updatedAt = now;

    await Promise.all([
      fs.writeFile(reviewPath, JSON.stringify(review, null, 2), "utf-8"),
      fs.writeFile(metaPath, JSON.stringify(content, null, 2), "utf-8"),
    ]);
    // 人机协同(V5.6.1):选定封面在文件夹根留一份「拿了就走」的副本(重选自动覆盖)
    if (review.approvedImagePath) {
      const ext = path.extname(review.approvedImagePath) || ".png";
      await fs.copyFile(review.approvedImagePath, path.join(projDir, `封面${ext}`)).catch(() => {});
    }
    return review;
  } catch {
    return null;
  }
}

// --- Content Status Machine ---

/**
 * Valid state transitions: from → allowed targets.
 * 前向推进 + 显式回退（创始人反馈：状态卡住不能退回）。回退边刻意收敛为
 * 「退一步」语义,不做任意跳转——保持管线可读,又允许纠错。
 */
const STATE_TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  topic_saved: ["drafting"],
  drafting: ["draft_ready", "topic_saved"],
  draft_ready: ["reviewing", "drafting"],
  reviewing: ["revision", "approved", "draft_ready"],
  revision: ["reviewing", "approved", "draft_ready"],
  // cover_pending 移出 approved 的出口:封面设计师是 P1.5 才转正的员工（PRD-v4 §4.2），
  // 现无 UI/通道,把它作为可达状态暴露 = 展示未转正员工（§7.4 红线）+ 掉进无工具死角。
  // 公众号发布链在发布时自动配封面（wechat-mp.ts）,P0 不需要此状态。
  // 保留 enum 与下面的出口给历史数据兜底;封面设计师转正时把 cover_pending 加回这里。
  // 「已审核/待发布」可直接拖到「已发布」= 人工标记已发布(创始人在公众号后台手动发完，
  // 回看板归位)。这不触发真实推送——推送是「推 →」/publish 工具的事,这里只落状态+publishedAt。
  approved: ["publish_ready", "reviewing", "published"],
  cover_pending: ["publish_ready", "approved"],
  publish_ready: ["publishing", "approved", "published"],
  publishing: ["published", "publish_ready"],
  published: ["archived", "publish_ready"],
  archived: ["draft_ready"],
};

export interface TransitionResult {
  ok: boolean;
  content?: Content;
  error?: string;
  /** If an auto-trigger fired, describes what happened */
  autoTriggered?: string;
}

/**
 * Transition a content item to a new status with validation.
 * Enforces the state machine defined in PRD §13.
 *
 * Auto-trigger rules:
 * - draft_ready → reviewing: fires automatically (caller should run content-review)
 *
 * Note: opts.diffNote is accepted but no longer consumed here — the ad-hoc snapshot
 * write (learnings/edits) that used it is retired; content-save's recordDiff wiring
 * now owns the revision-edit cycle.  The param is kept because review.ts:283 passes it
 * and removing it would be a breaking API change with no immediate gain.
 */
export async function transitionStatus(
  contentId: string,
  targetStatus: ContentStatus,
  opts?: { force?: boolean; diffNote?: string },
  dataDir?: string,
): Promise<TransitionResult> {
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `Content ${contentId} not found` };

  const currentStatus = normalizeLegacyStatus(content.status);

  // Validate transition
  if (!opts?.force) {
    const allowed = STATE_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      return {
        ok: false,
        error: `Invalid transition: ${currentStatus} → ${targetStatus}. Allowed: ${(allowed || []).join(", ") || "none"}`,
      };
    }
  }

  const now = new Date().toISOString();
  const updates: Partial<Content> = { status: targetStatus };

  // Auto-trigger: draft_ready → reviewing (signal to caller)
  let autoTriggered: string | undefined;
  if (targetStatus === "draft_ready") {
    autoTriggered = "draft_ready reached — auto-transition to reviewing recommended (run content-review)";
  }

  // Set publishedAt when transitioning to published
  if (targetStatus === "published" && !content.publishedAt) {
    updates.publishedAt = now;
  }

  const updated = await updateContent(contentId, updates, dataDir);
  if (!updated) return { ok: false, error: "Failed to update content" };

  return { ok: true, content: updated, autoTriggered };
}

/**
 * Get allowed next statuses for a content item.
 */
export function getAllowedTransitions(status: ContentStatus): ContentStatus[] {
  return STATE_TRANSITIONS[status] || [];
}

// --- Multi-platform distribution ---

/**
 * Create a platform-specific variant from a topic.
 * Automatically sets up sibling relationships.
 */
export async function createPlatformVariant(
  topicId: string,
  platform: string,
  opts?: { title?: string; body?: string },
  dataDir?: string,
): Promise<{ ok: boolean; content?: Content; error?: string }> {
  const topic = await getTopic(topicId, dataDir);
  if (!topic) return { ok: false, error: `Topic ${topicId} not found` };

  // Find existing siblings for this topic
  const allContents = await listContents(dataDir);
  const existingSiblings = allContents.filter(
    (c) => c.topicId === topicId,
  );

  // Check if this platform already has a variant
  const existing = existingSiblings.find((c) => c.platform === platform);
  if (existing) {
    return { ok: false, error: `Platform variant already exists: ${existing.id}` };
  }

  // Create the new content
  const content = await saveContent(
    {
      title: opts?.title || `${topic.title} (${platform})`,
      body: opts?.body || `<!-- Generated from topic: ${topicId} -->\n\n${topic.description}`,
      platform,
      topicId,
      status: "topic_saved",
      tags: [...topic.tags],
    },
    dataDir,
  );

  // Update all siblings to reference each other
  const allSiblingIds = [...existingSiblings.map((c) => c.id), content.id];
  for (const sib of existingSiblings) {
    const siblingIds = allSiblingIds.filter((id) => id !== sib.id);
    await updateContent(sib.id, { siblings: siblingIds }, dataDir);
  }
  // Update the new content's siblings
  const newSiblingIds = allSiblingIds.filter((id) => id !== content.id);
  if (newSiblingIds.length > 0) {
    await updateContent(content.id, { siblings: newSiblingIds }, dataDir);
  }

  // Re-read to get the updated version
  const final = await getContent(content.id, dataDir);
  return { ok: true, content: final || content };
}

/**
 * List all sibling content items (same topic, different platforms).
 */
export async function listSiblings(
  contentId: string,
  dataDir?: string,
): Promise<Content[]> {
  const content = await getContent(contentId, dataDir);
  if (!content) return [];

  const siblingIds = content.siblings || [];
  if (siblingIds.length === 0 && content.topicId) {
    // Fallback: find by topicId
    const all = await listContents(dataDir);
    return all.filter((c) => c.topicId === content.topicId && c.id !== contentId);
  }

  const siblings: Content[] = [];
  for (const id of siblingIds) {
    const sib = await getContent(id, dataDir);
    if (sib) siblings.push(sib);
  }
  return siblings;
}
