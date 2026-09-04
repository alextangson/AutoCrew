import path from "node:path";
import fs from "node:fs/promises";
import { isContentId, isSafeFilename, isTopicId } from "./entity-id.js";
import { writeJsonAtomic, writeTextAtomic } from "./json-atomic.js";
import { stageGuardError } from "./stage-guard.js";
// 纯类型 import（编译后擦除，不产生 storage → modules 的运行时依赖）：
// 审稿结论的形状归审稿模块定义，这里复制一份就是把真相分成两处。
import type { ReviewMeta } from "../modules/writing/script-review.js";
import type { ScriptRequest } from "../modules/writing/script-prompt.js";
// 角度卡的形状归简报模块定义（它是简报 schema 的一部分），这里只引用不复制
import type { AngleCard } from "../modules/research/brief-store.js";

/**
 * 创始人选定的写作角度（角度卡 spec §1.3）。指针 + **生效卡快照**两样都存：
 * 点选存的是原卡，改写（选择 UI）存的是改写版——读侧统一走 `card`，不必再回简报里找，
 * 也不会因为「改写过」而丢掉创始人的那一版。指针（briefRevision/angleId）只用来判过期：
 * 重跑简报或改了选题文本，这份选择就作废，写稿按「没选」处理。
 */
export interface SelectedAngle {
  briefRevision: number;
  angleId: string;
  card: AngleCard;
  selectedAt: string;
}

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
  /** 创始人选中/改写的角度卡（角度卡 spec §1.3）；未选 = 字段不落，写稿走「未经角度点选」 */
  selectedAngle?: SelectedAngle;
  scoredAt?: string;
  createdAt: string;
  /**
   * 「最近一次有动作」的时间戳——3 天过期回收以它为锚（缺省回落 createdAt）。
   * 深调研启动即续期一次（深调研 spec §2）：正在被调研的选题不该半路被清走。
   */
  renewedAt?: string;
  /** 软删除时间戳(回收站语义,qingmo 设计细节);null/缺省 = 活跃 */
  deletedAt?: string | null;
}

/**
 * 素材在成片里的角色（横屏 spec §2.6）。挂接时必填，是 A-roll 发现与 BGM 选取的唯一依据——
 * 旧数据没有这个字段，消费方按「整篇都没标过角色」回落旧约定，不做数据迁移。
 */
export type AssetRole = "aroll" | "broll" | "bgm" | "other";

/** 视频/音频素材的客观事实（ffprobe 读出，挂接时钉住）：剪辑师 agent 要靠它排时长，指纹给不了 */
export interface AssetMedia {
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
}

export interface Asset {
  filename: string;
  type: "cover" | "broll" | "image" | "video" | "audio" | "subtitle" | "other";
  /** 一行内容说明；挂接 UI 用素材库 name/tags 预填——不靠人记得改文件名 */
  description?: string;
  addedAt: string;
  role?: AssetRole;
  /**
   * 素材库来源与其元数据**快照**（spec §2.6）。存快照不存引用：素材库改名/改标签
   * 不该悄悄改变一篇已定稿稿件的素材说明，那是「同一版稿件两种事实」。
   */
  sourceLibraryId?: string;
  sourceName?: string;
  tags?: string[];
  media?: AssetMedia;
  /**
   * 所有权标记（视频线 lifecycle spec §3.1）。只有本字段为 `"video-pipeline"` 的登记
   * 才允许被自动清理删除——**绝不按文件名删**：人手挂接的同名 `final-v1.mp4` 没有这个标记，
   * 清理时一律不碰（§4 #11）。历史成片没有这个字段，因此也不会被回溯清理（§4 #14）。
   */
  managedBy?: "video-pipeline";
  /** 与 managedBy 配对：这份成片是哪一版渲染的产物。清理按「所有权 + 版本」双重匹配 */
  renderedRevision?: number;
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
  /** 剪辑阶段（阶段制 spec §0）：视频稿定稿之后、封面之前的工作台 */
  | "editing"
  | "cover_pending"
  | "publish_ready"
  | "publishing"
  | "published"
  | "archived";

/** 状态的人话名。后端拒绝话术与事件文案共用一份，前端 VARIANT_STATUS 是它的镜像 */
export const CONTENT_STATUS_LABEL: Record<ContentStatus, string> = {
  topic_saved: "选题已存",
  drafting: "写作中",
  draft_ready: "草稿就绪",
  reviewing: "待审",
  revision: "修订中",
  approved: "已过审",
  editing: "剪辑",
  cover_pending: "封面设计",
  publish_ready: "待发布",
  publishing: "发布中",
  published: "已发布",
  archived: "已归档",
};

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
  /**
   * 发布时刻由系统按「AI 成稿 → 实际发布稿」的改动量推导，不是创始人手点的。
   * 手动改判会整条覆盖这份记录，标记随之消失——改判后的裁决就是人给的。
   */
  derived?: boolean;
  recordedAt: string;
}

export interface Content {
  id: string;
  title: string;
  body: string;
  /** 公众号摘要(≤20 字钩子):发布时写进草稿 digest 字段,可在发布面板生成/编辑。 */
  digest?: string;
  platform?: string;
  topicId?: string;
  status: ContentStatus;
  tags: string[];
  /** IDs of sibling content (same topic, different platforms) */
  siblings: string[];
  /** Platform-specific hashtags */
  hashtags: string[];
  /**
   * 稿成时刻（内容生产计时的中间节点）:占位稿转正为 draft_ready 时盖一次。
   * 「开写」不另设字段——占位稿是开写那一刻创建的,`createdAt` 就是开写时刻,
   * 生产用时的起点一律读 createdAt。旧稿无此字段 → 计时按「缺戳」跳过,不倒推、不编造。
   */
  draftReadyAt?: string;
  /**
   * 成片就绪时刻（视频生产线的终点戳，设计 spec §8.4）：审片确认通过时盖一次。
   * **只盖一次**（publishedAt 同款纪律）——重剪重审不覆盖首次达成的时刻。
   * 视频线的其余状态一律不进 Content（§2.1：updateContent 非原子，并发写会互相覆盖），
   * 全量状态在 `contents/<id>/video/state.json`。
   */
  videoReadyAt?: string;
  /**
   * 「当前这一版成片审过了」——阶段门（spec §1.2）唯一认的凭据。审片通过时视频线写入，
   * 从 done 重开（改选段再出一版）时清除。刻意不复用 `videoReadyAt`：那枚戳只盖一次、
   * 永不覆盖，重剪之后它会放行一版早就作废的成片。
   */
  videoDone?: { renderedRevision: number; at: string };
  /** ISO timestamp when published — 计时终点;首次盖章后不被重复确认覆盖 */
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
  /**
   * 生成占位稿身上钉住的原始写作请求——中断后「在原稿上重写」的唯一依据。
   * 不钉住就只能从标题反推选题（调研材料、对标卡开关全丢），而那正是重试
   * 一次多出一张僵尸卡的老路。转正时清掉：成稿没有「中断」可重试，留一份
   * 过期的请求只会让 meta 里多一处会骗人的事实。旧稿没有此字段，重试走降级还原。
   */
  genRequest?: ScriptRequest;
  /** 本稿写作时注入的对标拆解卡 id（收件箱设计 §3.5）：学习闭环归因，无卡时字段不落 */
  usedPatternIds?: string[];
  /** 本稿注入的调研简报版本（深调研 §6）：回溯得到 briefs/<topicId>.v<N>.json 那份不可变输入，无简报时字段不落 */
  usedBriefRevision?: number;
  /** 那份简报的内容指纹（P1 §3.0）：版本号说「哪一版」，指纹说「盘上那份没被换过」 */
  usedBriefHash?: string;
  /**
   * AI 审稿结论（审稿 spec §2.5）：工作台稿卡徽章的唯一读数。旧稿无此字段 = 不显示徽章。
   * 改稿链路（revise_draft / 收下修订）落盘时把 status 改成 "stale"——
   * 改过的稿不得继续顶着「已 AI 审稿」的徽章（§2.7）。
   */
  review?: ReviewMeta;
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

function isFileMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * 逐 content 写队列（codex 2026-07-27 评审：meta.json 读-改-写并发互相覆盖丢字段）。
 * 同一稿件的写路径按 id 排队（promise 链，inbox-runtime serialize() 同款，也是
 * 视频线 spec §2.1 为 state.json 选定的模式）。只护本进程内的 worker/IPC/回调
 * 并发；跨进程仍是 last-writer-wins（原子写只保证不留半个 JSON）。
 */
const contentWriteChains = new Map<string, Promise<unknown>>();

function serializeContentWrite<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = contentWriteChains.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn); // 前一步失败也不许卡住后一步
  const tail = next.then(() => undefined, () => undefined);
  contentWriteChains.set(id, tail);
  void tail.then(() => {
    if (contentWriteChains.get(id) === tail) contentWriteChains.delete(id);
  });
  return next;
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
  await writeJsonAtomic(path.join(dir, `${id}.json`), full);
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
  await writeJsonAtomic(path.join(dir, `${topic.id}.json`), topic);
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
  // 初始态也过阶段门（spec §1.2 收口）：from=to 时只有「这个阶段属不属于这种平台」会响，
  // 挡住的正是「把公众号稿直接建在剪辑阶段」这类跳阶段建稿。
  const initial = normalizeLegacyStatus(content.status);
  const illegal = await stageGuardError(content, initial, initial, async () => true);
  if (illegal) throw new Error(`稿件不能直接建在这个阶段：${illegal}`);

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

  // meta.json 最后写 = 提交点：中途崩溃只留一个没有 meta 的孤儿目录（读侧会跳过），不留半份稿
  await writeTextAtomic(path.join(projDir, "draft.md"), `# ${content.title}\n\n${content.body}\n`);
  await writeTextAtomic(path.join(projDir, "versions", "v1.md"), content.body);
  await writeJsonAtomic(path.join(projDir, "meta.json"), full);

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

/**
 * 状态在类型上就不许从这里写（阶段制 spec §1.2 收口）：`status` 的唯一写入通道是
 * `transitionStatus`——只有它在写锁内跑过阶段门。放开这里等于让任何一处 update 跳阶段。
 */
export type ContentUpdates = Partial<Omit<Content, "status">> & { _versionNote?: string };

/** 收口通道内部用：全仓只有 `transitionStatusLocked` 能带 status 走这条路 */
type StatusfulUpdates = ContentUpdates & { status?: ContentStatus };

/**
 * 契约（codex 2026-07-27 评审后收紧）：null 只表示「稿件不存在」；
 * 坏 JSON、写盘失败等一律向上抛——吞成 null 会让并发覆盖与磁盘故障都不可见。
 * 同一稿件的读-改-写按 id 串行，防止多写方（worker/IPC/回调）互相覆盖字段。
 */
export async function updateContent(id: string, updates: ContentUpdates, dataDir?: string): Promise<Content | null> {
  if (!isContentId(id)) return null;
  return serializeContentWrite(id, () => updateContentLocked(id, updates, dataDir));
}

async function updateContentLocked(id: string, updates: StatusfulUpdates, dataDir?: string): Promise<Content | null> {
  const projDir = path.join(getDataDir(dataDir), "contents", id);
  const metaPath = path.join(projDir, "meta.json");
  let raw: string;
  try {
    raw = await fs.readFile(metaPath, "utf-8");
  } catch (err) {
    if (isFileMissing(err)) return null;
    throw err;
  }
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
    await writeTextAtomic(path.join(projDir, "versions", `v${nextVersion}.md`), versionEntry.body);
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

  // draft.md 先写、meta.json 最后写 = 提交点：镜像超前可被下次成功写自愈，meta 不留中间态
  await writeTextAtomic(path.join(projDir, "draft.md"), `# ${updated.title}\n\n${updated.body}\n`);
  await writeJsonAtomic(metaPath, updated);

  return updated;
}

// --- Assets ---

/** 采纳裁决三键落库（PRD-v4 §8：北极星「采纳率」的读数来源）。重复裁决 = 覆盖（改判允许） */
export async function recordAdoption(
  id: string,
  verdict: AdoptionVerdict,
  dataDir?: string,
  reason?: RewriteReason,
  reasonNote?: string,
  opts?: { derived?: boolean },
): Promise<Content | null> {
  return updateContent(id, {
    adoption: {
      verdict,
      ...(verdict === "rewritten" && reason ? { reason } : {}),
      ...(verdict === "rewritten" && reasonNote ? { reasonNote } : {}),
      ...(opts?.derived ? { derived: true } : {}),
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

/**
 * 挂接素材的落盘一步：同卷硬链接，跨卷退回复制。
 *
 * A-roll 是 GB 级的——直传已经在 `library/uploads/` 存了一份，挂接再 copyFile
 * 就是双份占盘。硬链接让两侧共享同一份字节，且删除语义天然正确：任一侧 unlink
 * 只断自己那条链接，最后一条断掉数据才消失，content:asset_remove 与素材库的
 * uploads 连带清理都无需特判。
 *
 * 先 rm 再 link：link 不覆盖已存在的目标（EEXIST），rm 对齐 copyFile 的覆盖语义
 * （半途失败留下的孤儿字节重挂时要能盖掉）。
 */
async function linkOrCopyFile(src: string, dest: string): Promise<void> {
  await fs.rm(dest, { force: true });
  try {
    await fs.link(src, dest);
  } catch {
    // 跨卷（EXDEV）或文件系统不支持硬链接时退回复制；
    // src 真不可读的话 copyFile 会把真实错误照旧抛上去，失败不静默
    await fs.copyFile(src, dest);
  }
}

export async function addAsset(
  contentId: string,
  asset: Omit<Asset, "addedAt"> & { sourcePath?: string },
  dataDir?: string,
): Promise<{ ok: boolean; asset?: Asset; error?: string }> {
  if (!isContentId(contentId)) return { ok: false, error: "Invalid content id" };
  if (!isSafeFilename(asset.filename)) return { ok: false, error: "Invalid asset filename" };
  return serializeContentWrite(contentId, async () => {
    const projDir = path.join(getDataDir(dataDir), "contents", contentId);
    const metaPath = path.join(projDir, "meta.json");

    let raw: string;
    try {
      raw = await fs.readFile(metaPath, "utf-8");
    } catch (err) {
      if (isFileMissing(err)) return { ok: false, error: `Content ${contentId} not found` };
      throw err;
    }
    const content: Content = JSON.parse(raw);
    const now = new Date().toISOString();

    // Link (or copy) source file into assets/ if provided（失败向上抛，不再伪装成 not found）
    if (asset.sourcePath) {
      const destPath = path.join(projDir, "assets", asset.filename);
      await linkOrCopyFile(asset.sourcePath, destPath);
    }

    const { sourcePath: _copied, ...fields } = asset;
    const newAsset: Asset = { ...fields, addedAt: now };

    content.assets = [...(content.assets || []), newAsset];
    content.updatedAt = now;
    await writeJsonAtomic(metaPath, content);

    return { ok: true, asset: newAsset };
  });
}

/**
 * 幂等登记：同名素材**替换**而不是追加（视频线 lifecycle spec §3.1）。
 *
 * `addAsset` 是无条件 append——重试一次渲染就会在 meta 里留两条同名记录，
 * 之后 `removeAsset` 一删删两条、`detach` 也说不清删的是哪条。成片这种「同一版只该有一条」
 * 的登记必须走这里。文件仍然照拷（同名覆盖字节是期望行为：那是同一版的重渲结果）。
 */
export async function upsertAsset(
  contentId: string,
  asset: Omit<Asset, "addedAt"> & { sourcePath?: string },
  dataDir?: string,
): Promise<{ ok: boolean; asset?: Asset; error?: string }> {
  if (!isContentId(contentId)) return { ok: false, error: "Invalid content id" };
  if (!isSafeFilename(asset.filename)) return { ok: false, error: "Invalid asset filename" };
  return serializeContentWrite(contentId, async () => {
    const projDir = path.join(getDataDir(dataDir), "contents", contentId);
    const metaPath = path.join(projDir, "meta.json");
    let raw: string;
    try {
      raw = await fs.readFile(metaPath, "utf-8");
    } catch (err) {
      if (isFileMissing(err)) return { ok: false, error: `Content ${contentId} not found` };
      throw err;
    }
    const content: Content = JSON.parse(raw);
    if (asset.sourcePath) {
      await fs.mkdir(path.join(projDir, "assets"), { recursive: true });
      const destPath = path.join(projDir, "assets", asset.filename);
      // 先断链再拷：dest 若是挂接留下的硬链接，copyFile 的截断写会穿透改写素材库那份共享字节
      await fs.rm(destPath, { force: true });
      await fs.copyFile(asset.sourcePath, destPath);
    }
    const { sourcePath: _copied, ...fields } = asset;
    const now = new Date().toISOString();
    const existing = (content.assets || []).find((a) => a.filename === asset.filename);
    const next: Asset = { ...fields, addedAt: existing?.addedAt ?? now };
    content.assets = [...(content.assets || []).filter((a) => a.filename !== asset.filename), next];
    content.updatedAt = now;
    await writeJsonAtomic(metaPath, content);
    return { ok: true, asset: next };
  });
}

/**
 * 反登记一版受管成片（视频线 lifecycle spec §3.1）：**只删所有权与版本都对得上的那一条**。
 *
 * 刻意不复用 `removeAsset`：那个按文件名删，会把所有同名记录连同文件一起删掉——
 * 人手挂接的同名 `final-v1.mp4` 会被误伤，而清理是自动动作，误伤不可撤销。
 * 返回 false = 没有匹配的受管登记（历史成片、别人的文件），此时**什么都没动**。
 */
export async function removeManagedFinalAsset(
  contentId: string,
  renderedRevision: number,
  dataDir?: string,
): Promise<boolean> {
  if (!isContentId(contentId) || !Number.isInteger(renderedRevision)) return false;
  return serializeContentWrite(contentId, async () => {
    const projDir = path.join(getDataDir(dataDir), "contents", contentId);
    const metaPath = path.join(projDir, "meta.json");
    let raw: string;
    try {
      raw = await fs.readFile(metaPath, "utf-8");
    } catch (err) {
      if (isFileMissing(err)) return false;
      throw err;
    }
    const content: Content = JSON.parse(raw);
    const owned = (content.assets || []).filter(
      (a) => a.managedBy === "video-pipeline" && a.renderedRevision === renderedRevision,
    );
    if (owned.length === 0) return false;
    const doomed = new Set(owned.map((a) => a.filename));
    content.assets = (content.assets || []).filter((a) => !doomed.has(a.filename));
    content.updatedAt = new Date().toISOString();
    await writeJsonAtomic(metaPath, content);
    for (const filename of doomed) {
      if (!isSafeFilename(filename)) continue;
      try {
        await fs.unlink(path.join(projDir, "assets", filename));
      } catch {
        /* 文件已被人手删掉：登记清干净就算完成 */
      }
    }
    return true;
  });
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
  return serializeContentWrite(contentId, async () => {
    const projDir = path.join(getDataDir(dataDir), "contents", contentId);
    const metaPath = path.join(projDir, "meta.json");
    let raw: string;
    try {
      raw = await fs.readFile(metaPath, "utf-8");
    } catch (err) {
      if (isFileMissing(err)) return false; // false 只表示稿件不存在；写失败向上抛
      throw err;
    }
    const content: Content = JSON.parse(raw);
    content.assets = (content.assets || []).filter(a => a.filename !== filename);
    content.updatedAt = new Date().toISOString();
    await writeJsonAtomic(metaPath, content);
    // Also delete the file
    try { await fs.unlink(path.join(projDir, "assets", filename)); } catch { /* ok */ }
    return true;
  });
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
  return serializeContentWrite(contentId, async () => {
    const projDir = path.join(getDataDir(dataDir), "contents", contentId);
    const metaPath = path.join(projDir, "meta.json");
    const reviewPath = path.join(projDir, "cover-review.json");

    let raw: string;
    try {
      raw = await fs.readFile(metaPath, "utf-8");
    } catch (err) {
      if (isFileMissing(err)) return null; // null 只表示稿件不存在；写失败向上抛
      throw err;
    }
    const content: Content = JSON.parse(raw);
    const now = new Date().toISOString();
    // createdAt 保留首次值——反馈重做会反复保存,历史起点不许被覆盖
    const full: CoverReview = {
      ...review,
      createdAt: review.createdAt ?? now,
      updatedAt: now,
    };

    await writeJsonAtomic(reviewPath, full);
    content.updatedAt = now;
    await writeJsonAtomic(metaPath, content);
    return full;
  });
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
  return serializeContentWrite(contentId, () => approveCoverVariantLocked(contentId, label, dataDir));
}

async function approveCoverVariantLocked(
  contentId: string,
  label: "a" | "b" | "c",
  dataDir?: string,
): Promise<CoverReview | null> {
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  const reviewPath = path.join(projDir, "cover-review.json");
  const metaPath = path.join(projDir, "meta.json");

  let reviewRaw: string;
  let metaRaw: string;
  try {
    [reviewRaw, metaRaw] = await Promise.all([
      fs.readFile(reviewPath, "utf-8"),
      fs.readFile(metaPath, "utf-8"),
    ]);
  } catch (err) {
    if (isFileMissing(err)) return null; // 稿件或评审单不存在；其余失败向上抛
    throw err;
  }
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
  // 阶段制起（spec §0 清扫 1）：选封面**只做标记，不碰稿件状态**。
  // 推进阶段是人的动作，走顶栏推进按钮；这里代改状态会把人刚推到的阶段悄悄倒拨回去。
  content.updatedAt = now;

  await Promise.all([
    writeJsonAtomic(reviewPath, review),
    writeJsonAtomic(metaPath, content),
  ]);
  // 人机协同(V5.6.1):选定封面在文件夹根留一份「拿了就走」的副本(重选自动覆盖)
  if (review.approvedImagePath) {
    const ext = path.extname(review.approvedImagePath) || ".png";
    await fs.copyFile(review.approvedImagePath, path.join(projDir, `封面${ext}`)).catch(() => {});
  }
  return review;
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
  // 阶段制（spec §1.1）：视频稿定稿后走 editing → cover_pending → publish_ready。
  // 表保持平台无关的单表——公众号照旧 approved → publish_ready 直通，
  // 「哪条边属于哪种平台」由阶段门判定（stage-guard），不在这里分叉。
  approved: ["publish_ready", "reviewing", "editing"],
  editing: ["cover_pending", "approved"],
  cover_pending: ["publish_ready", "editing"],
  publish_ready: ["publishing", "approved"],
  publishing: ["published", "publish_ready"],
  published: ["archived", "publish_ready"],
  archived: ["draft_ready"],
};

export interface TransitionResult {
  ok: boolean;
  content?: Content;
  error?: string;
  /** true = 被阶段门拦下（不是状态图形状不对）。调用方据此说「卡在阶段门」 */
  blocked?: boolean;
  /** If an auto-trigger fired, describes what happened */
  autoTriggered?: string;
}

export interface TransitionOptions {
  /** 只越得过**状态图形状**（看板拖拽这类人工工具）；越不过阶段门（spec §1.2） */
  force?: boolean;
  /**
   * 调用方手里那一版的状态。与盘上不符即拒绝、不覆盖——开着的旧标签页与
   * 推进按钮双击都靠它，人看到的是一句人话而不是被静默改掉的状态。
   */
  expectedStatus?: ContentStatus;
  diffNote?: string;
}

/** 封面是否已定稿：复用既有判定（选用即写 approvedLabel，revise 掉它即作废） */
async function coverApproved(contentId: string, dataDir?: string): Promise<boolean> {
  const review = await getCoverReview(contentId, dataDir);
  return Boolean(review?.approvedLabel);
}

/**
 * 阶段门的**不写盘**预判：推进下拉的灰显原因、发布预检的「卡在阶段门」提示，
 * 与真正写入时跑的是同一个判定，不许两处结论打架。
 */
export async function stageBlockReason(
  content: Content,
  targetStatus: ContentStatus,
  dataDir?: string,
): Promise<string | null> {
  return stageGuardError(content, normalizeLegacyStatus(content.status), targetStatus, () =>
    coverApproved(content.id, dataDir),
  );
}

/**
 * 稿件状态的**唯一写入通道**（阶段制 spec §1.2）。
 *
 * 「读当前状态 → 校验 → 写入」整段跑在按 id 串行的写锁**内**：从前是锁外读、锁内写，
 * 两个并发推进都能读到同一个旧状态，各自算出「合法」再互相覆盖。
 *
 * 两层校验各管各的：`force` 越得过状态图形状（看板拖拽是人工工具），
 * 越不过阶段门——没剪的片子不许被强推进封面台。
 *
 * Note: opts.diffNote is accepted but no longer consumed here — the ad-hoc snapshot
 * write (learnings/edits) that used it is retired; content-save's recordDiff wiring
 * now owns the revision-edit cycle.  The param is kept because review.ts:283 passes it
 * and removing it would be a breaking API change with no immediate gain.
 */
export async function transitionStatus(
  contentId: string,
  targetStatus: ContentStatus,
  opts?: TransitionOptions,
  dataDir?: string,
): Promise<TransitionResult> {
  if (!isContentId(contentId)) return { ok: false, error: `Content ${contentId} not found` };
  return serializeContentWrite(contentId, () => transitionStatusLocked(contentId, targetStatus, opts, dataDir));
}

async function transitionStatusLocked(
  contentId: string,
  targetStatus: ContentStatus,
  opts: TransitionOptions | undefined,
  dataDir?: string,
): Promise<TransitionResult> {
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `Content ${contentId} not found` };

  const currentStatus = normalizeLegacyStatus(content.status);
  const label = (s: ContentStatus) => CONTENT_STATUS_LABEL[s] ?? s;

  if (opts?.expectedStatus && opts.expectedStatus !== currentStatus) {
    return {
      ok: false,
      error:
        `这篇现在是「${label(currentStatus)}」，你手上那份还写着「${label(opts.expectedStatus)}」` +
        `——刷新一下再推进，免得盖掉别处刚做的改动`,
    };
  }

  if (!opts?.force) {
    const allowed = STATE_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      return {
        ok: false,
        error: `Invalid transition: ${currentStatus} → ${targetStatus}. Allowed: ${(allowed || []).join(", ") || "none"}`,
      };
    }
  }

  // 阶段门在写锁内、force 之后——它是产品事实，强推不得（spec §1.2）
  const blocked = await stageGuardError(content, currentStatus, targetStatus, () =>
    coverApproved(contentId, dataDir),
  );
  if (blocked) return { ok: false, blocked: true, error: blocked };

  const now = new Date().toISOString();
  const updates: StatusfulUpdates = { status: targetStatus };

  // Auto-trigger: draft_ready → reviewing (signal to caller)
  let autoTriggered: string | undefined;
  if (targetStatus === "draft_ready") {
    autoTriggered = "draft_ready reached — auto-transition to reviewing recommended (run content-review)";
  }

  // Set publishedAt when transitioning to published
  if (targetStatus === "published" && !content.publishedAt) {
    updates.publishedAt = now;
  }

  const updated = await updateContentLocked(contentId, updates, dataDir);
  if (!updated) return { ok: false, error: "Failed to update content" };

  return { ok: true, content: updated, autoTriggered };
}

/**
 * 状态图形状允许的下一站（不含阶段门判定）。
 * UI 要「灰显带原因」时另配 `stageBlockReason` 逐条预判。
 */
export function getAllowedTransitions(status: ContentStatus): ContentStatus[] {
  return STATE_TRANSITIONS[status] || [];
}

export interface AllowedTransition {
  status: ContentStatus;
  /** 非空 = 形状允许但阶段门拦着：下拉里灰显这一条，并把原因摆出来 */
  blockedReason?: string;
}

/** 推进下拉的数据源：形状 + 阶段门预判一次算完，前端不必自己推演规则 */
export async function describeAllowedTransitions(
  content: Content,
  dataDir?: string,
): Promise<AllowedTransition[]> {
  const from = normalizeLegacyStatus(content.status);
  const out: AllowedTransition[] = [];
  for (const status of getAllowedTransitions(from)) {
    const reason = await stageBlockReason(content, status, dataDir);
    out.push(reason ? { status, blockedReason: reason } : { status });
  }
  return out;
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
