/**
 * Pattern Store — 对标拆解卡的 append-only JSONL（灵感收件箱设计 §3.5）。
 *
 * 文件：<dataDir>/patterns/patterns.jsonl，一行一条 PatternCard。
 * 幂等：id 按 sourceInboxId 确定性派生，同 id 后写覆盖先写（读取时 latest-wins），
 *       journal 本身永不改写——重试/续做不会产生第二张卡。
 * 删除：写墓碑（deletedAt 置值），物理不删——同链接再转发时查重能命中墓碑，
 *       由调用方走「此前已删过，需显式重拆」分支，而不是静默复活。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { CLIPBOARD_PLATFORMS, type ClipboardPlatform } from "../publish/clipboard-publisher.js";

const PATTERNS_DIR = "patterns";
const PATTERNS_FILE = "patterns.jsonl";

/** 拆解来源平台。与输出平台（applicablePlatforms）是两个枚举，绝不混用（§3.5 rule 19） */
export type PatternSourcePlatform = "douyin" | "x" | "wechat_article" | "web";

export interface PatternStats {
  likes?: number;
  comments?: number;
  collects?: number;
  capturedAt: string;
}

export interface PatternCard {
  /** `pat-<sourceInboxId>` */
  id: string;
  sourceUrl: string;
  /** 查重幂等键（解重定向 + 按域规范化后的 URL） */
  canonicalUrl: string;
  sourcePlatform: PatternSourcePlatform;
  /** 输出平台（设计里的 PlatformId 即本仓库的 ClipboardPlatform）：LLM 建议，创始人可改 */
  applicablePlatforms: ClipboardPlatform[];
  author?: string;
  title: string;
  /** ≤100 字 */
  hook: string;
  /** 3-6 步，每步 ≤50 字 */
  structure: string[];
  first5s?: string;
  /** 1-3 条 */
  whyItWorks: string[];
  /** 1-3 个，选卡时与选题标题/角度求交集 */
  themes: string[];
  stats?: PatternStats;
  /** 创始人备注：单独字段，永不与抓取内容拼接（§3.6） */
  founderNote?: string;
  sourceInboxId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** id/revision/时间戳由 store 派生，调用方只给内容字段 */
export type PatternCardInput = Omit<
  PatternCard,
  "id" | "revision" | "createdAt" | "updatedAt" | "deletedAt"
>;

/** 创始人可改的字段——白名单之外一律拒绝（IPC `patterns:update` 的边界） */
export const PATTERN_UPDATABLE_FIELDS = ["founderNote", "applicablePlatforms"] as const;

export interface PatternCardPatch {
  founderNote?: string;
  applicablePlatforms?: ClipboardPlatform[];
}

/** 字段级上限＝注入纪律的兜底：超限截断而非报错，保证卡片进 prompt 时长度可控（§3.5） */
const LIMITS = {
  hookChars: 100,
  structureItemChars: 50,
  structure: { min: 3, max: 6 },
  whyItWorks: { min: 1, max: 3 },
  themes: { min: 1, max: 3 },
} as const;

const KNOWN_PLATFORMS = new Set<string>(CLIPBOARD_PLATFORMS);

export function patternIdFor(sourceInboxId: string): string {
  return `pat-${sourceInboxId}`;
}

function patternsPath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), PATTERNS_DIR, PATTERNS_FILE);
}

/** 按码点截断：避免把代理对切一半，产出乱码 */
function clampChars(value: string, max: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("");
}

function clampList(items: string[], max: number, itemMax?: number): string[] {
  return items.slice(0, max).map((item) => (itemMax ? clampChars(item, itemMax) : item.trim()));
}

/** LLM 可能给出输出枚举之外的值（如把来源平台 "x" 塞进来）——丢弃并去重，留下的必是真平台 */
function normalizePlatforms(platforms: ClipboardPlatform[]): ClipboardPlatform[] {
  return Array.from(new Set(platforms)).filter((p) => KNOWN_PLATFORMS.has(p));
}

/** 条数下限补不出来（不能凭空造 structure 步骤）——只能报错，不静默收下残卡 */
function assertMinCounts(input: PatternCardInput): void {
  const problems: string[] = [];
  if (input.structure.length < LIMITS.structure.min) {
    problems.push(`structure 需 ≥${LIMITS.structure.min} 步，实得 ${input.structure.length}`);
  }
  if (input.whyItWorks.length < LIMITS.whyItWorks.min) {
    problems.push(`whyItWorks 需 ≥${LIMITS.whyItWorks.min} 条，实得 ${input.whyItWorks.length}`);
  }
  if (input.themes.length < LIMITS.themes.min) {
    problems.push(`themes 需 ≥${LIMITS.themes.min} 个，实得 ${input.themes.length}`);
  }
  if (problems.length) throw new Error(`拆解卡字段不合规：${problems.join("；")}`);
}

/** 显式逐字段挑选：调用方即使传来整张旧卡，store 自管字段（含 deletedAt）也不会被夹带进来 */
function normalizeContent(input: PatternCardInput): PatternCardInput {
  assertMinCounts(input);
  return {
    sourceUrl: input.sourceUrl,
    canonicalUrl: input.canonicalUrl,
    sourcePlatform: input.sourcePlatform,
    applicablePlatforms: normalizePlatforms(input.applicablePlatforms),
    author: input.author,
    title: input.title,
    hook: clampChars(input.hook, LIMITS.hookChars),
    structure: clampList(input.structure, LIMITS.structure.max, LIMITS.structureItemChars),
    first5s: input.first5s,
    whyItWorks: clampList(input.whyItWorks, LIMITS.whyItWorks.max),
    themes: clampList(input.themes, LIMITS.themes.max),
    stats: input.stats,
    founderNote: input.founderNote,
    sourceInboxId: input.sourceInboxId,
  };
}

async function readJournal(dataDir?: string): Promise<PatternCard[]> {
  let raw: string;
  try {
    raw = await fs.readFile(patternsPath(dataDir), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const cards: PatternCard[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      cards.push(JSON.parse(line) as PatternCard);
    } catch {
      // 跳过损坏行：单行损坏不应清空整个读视图
    }
  }
  return cards;
}

/** latest-wins。Map 顺序＝各 id 最后一次写入的先后（同 updatedAt 时用作稳定次序） */
async function latestById(dataDir?: string): Promise<Map<string, PatternCard>> {
  const byId = new Map<string, PatternCard>();
  for (const card of await readJournal(dataDir)) {
    if (!card || typeof card.id !== "string") continue;
    byId.delete(card.id);
    byId.set(card.id, card);
  }
  return byId;
}

async function appendCard(card: PatternCard, dataDir?: string): Promise<void> {
  const dir = path.join(getDataDir(dataDir), PATTERNS_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(patternsPath(dataDir), JSON.stringify(card) + "\n", "utf-8");
}

/**
 * 落卡。同 sourceInboxId 重复调用只更新同一张卡（revision+1、updatedAt 刷新）。
 * 墓碑不继承：能走到这里就是调用方显式重拆，属于「显式覆盖」而非静默复活（§3.5）。
 */
export async function upsertPatternCard(
  input: PatternCardInput,
  dataDir?: string,
): Promise<PatternCard> {
  const content = normalizeContent(input);
  const id = patternIdFor(input.sourceInboxId);
  const existing = (await latestById(dataDir)).get(id);
  const now = new Date().toISOString();
  const card: PatternCard = {
    ...content,
    id,
    revision: existing ? existing.revision + 1 : 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await appendCard(card, dataDir);
  return card;
}

/** 创始人补注/改适用平台。白名单外字段直接报错——静默忽略会让「改了没生效」查不出来 */
export async function updatePatternCard(
  id: string,
  patch: PatternCardPatch,
  dataDir?: string,
): Promise<PatternCard> {
  const allowed = new Set<string>(PATTERN_UPDATABLE_FIELDS);
  const rejected = Object.keys(patch).filter((key) => !allowed.has(key));
  if (rejected.length) {
    throw new Error(
      `拆解卡只允许修改 ${PATTERN_UPDATABLE_FIELDS.join("/")}，被拒字段：${rejected.join("、")}`,
    );
  }
  const existing = (await latestById(dataDir)).get(id);
  if (!existing || existing.deletedAt) {
    throw new Error(`拆解卡不存在或已删除：${id}`);
  }
  const card: PatternCard = {
    ...existing,
    ...(patch.founderNote !== undefined ? { founderNote: patch.founderNote } : {}),
    ...(patch.applicablePlatforms !== undefined
      ? { applicablePlatforms: normalizePlatforms(patch.applicablePlatforms) }
      : {}),
    revision: existing.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  await appendCard(card, dataDir);
  return card;
}

/** 墓碑删除。已是墓碑则原样返回（幂等），卡不存在返回 null */
export async function deletePatternCard(
  id: string,
  dataDir?: string,
): Promise<PatternCard | null> {
  const existing = (await latestById(dataDir)).get(id);
  if (!existing) return null;
  if (existing.deletedAt) return existing;
  const now = new Date().toISOString();
  const tombstone: PatternCard = {
    ...existing,
    revision: existing.revision + 1,
    updatedAt: now,
    deletedAt: now,
  };
  await appendCard(tombstone, dataDir);
  return tombstone;
}

export interface ListPatternOptions {
  includeDeleted?: boolean;
}

/** 默认排除墓碑，按 updatedAt 降序；同 updatedAt 时后写的在前 */
export async function listPatternCards(
  opts: ListPatternOptions = {},
  dataDir?: string,
): Promise<PatternCard[]> {
  const byWriteOrderDesc = Array.from((await latestById(dataDir)).values()).reverse();
  const visible = opts.includeDeleted
    ? byWriteOrderDesc
    : byWriteOrderDesc.filter((card) => !card.deletedAt);
  return visible.sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * 查重入口——**含墓碑返回**。调用方据 deletedAt 分流：
 * 有值 → 回执「此前已删过，回复 /redo 可重拆」；无值 → 「已收录过」。
 */
export async function findPatternByCanonicalUrl(
  canonicalUrl: string,
  dataDir?: string,
): Promise<PatternCard | null> {
  const cards = await listPatternCards({ includeDeleted: true }, dataDir);
  return cards.find((card) => card.canonicalUrl === canonicalUrl) ?? null;
}
