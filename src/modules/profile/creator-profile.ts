/**
 * Creator Profile — Structured creator persona stored at ~/.autocrew/creator-profile.json
 *
 * This is the core identity file that drives personalized writing, topic scoring,
 * and style calibration. It's initialized during onboarding (from host MEMORY or
 * by asking the user) and continuously enriched by the Learnings system.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";

/**
 * 规则作用域（PRD-v4 §4.3 声音内核/平台包分层）：
 * "voice_core" = 跨平台声音内核（用词癖好、口头禅、立场、禁忌）；
 * "platform:<id>" = 平台包专属（结构、长度、格式规范）。
 * 缺省视为 voice_core（历史规则兼容，无需迁移）。
 */
export type RuleScope = "voice_core" | `platform:${string}`;

export interface WritingRule {
  rule: string;
  /** "auto_distilled" = extracted from user edits, "user_explicit" = user stated directly,
   *  "calibrated" = produced by the calibration skills (A/B-verified during onboarding) */
  source: "auto_distilled" | "user_explicit" | "calibrated";
  /** 0-1, higher = more confident */
  confidence: number;
  scope?: RuleScope;
  /** true = 用户停用，生成时跳过（个性化中心可切换） */
  disabled?: boolean;
  createdAt: string;
}

/**
 * 受众画像单层（IA v5 V5.1）——core=核心受众,adjacent=邻近受众,surprise=意外受众。
 * 三层结构继承 v2 Phase 0.5 设计与老 muse 系统的存量数据形状。
 */
export interface PersonaTier {
  name: string;
  age?: string;
  job?: string;
  /** 核心焦虑一句话——受众停留审与选题评分的判断锚 */
  coreAnxiety?: string;
  /** 短语痛点(2-4 个),供选题匹配用(长句匹配不上,必须是短语) */
  painPoints?: string[];
  /** 什么内容能让 TA 停下滑动 */
  scrollStopTriggers?: string[];
}

export interface AudiencePersona {
  core: PersonaTier;
  adjacent?: PersonaTier;
  surprise?: PersonaTier;
  /** 与用户完成校准的时间;缺省=提案态,未经用户确认 */
  calibratedAt?: string;
}

/**
 * 归一化画像形状:历史扁平记录({name,painPoints,...})升格为 {core:{...}};
 * 老 muse 遗产数据(core.coreAnxiety 为字符串)原样通过。坏形状返回 null(读侧防御)。
 */
export function normalizeAudiencePersona(raw: unknown): AudiencePersona | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const tierOf = (v: unknown): PersonaTier | undefined => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const t = v as Record<string, unknown>;
    if (typeof t.name !== "string" || !t.name.trim()) return undefined;
    return {
      name: t.name,
      ...(typeof t.age === "string" ? { age: t.age } : {}),
      ...(typeof t.job === "string" ? { job: t.job } : {}),
      ...(typeof t.coreAnxiety === "string" ? { coreAnxiety: t.coreAnxiety } : {}),
      ...(Array.isArray(t.painPoints) ? { painPoints: t.painPoints.filter((p): p is string => typeof p === "string") } : {}),
      ...(Array.isArray(t.scrollStopTriggers) ? { scrollStopTriggers: t.scrollStopTriggers.filter((p): p is string => typeof p === "string") } : {}),
    };
  };
  const core = tierOf(obj.core);
  if (core) {
    return {
      core,
      ...(tierOf(obj.adjacent) ? { adjacent: tierOf(obj.adjacent) } : {}),
      ...(tierOf(obj.surprise) ? { surprise: tierOf(obj.surprise) } : {}),
      ...(typeof obj.calibratedAt === "string" ? { calibratedAt: obj.calibratedAt } : {}),
    };
  }
  // 历史扁平形状:{name, painPoints, ...} → 升格为 core 层
  const flat = tierOf(obj);
  return flat ? { core: flat } : null;
}

/** 画像一行话渲染(prompt/评审共用的唯一口径)。tiers 缺省只渲染 core。 */
export function personaSummary(persona: AudiencePersona | null | undefined, opts?: { allTiers?: boolean }): string {
  if (!persona?.core) return "";
  const one = (label: string, t?: PersonaTier): string => {
    if (!t) return "";
    const bits = [t.age, t.job].filter(Boolean).join("·");
    const anxiety = t.coreAnxiety || (t.painPoints ?? []).slice(0, 3).join("、");
    return `${label}${t.name}${bits ? `(${bits})` : ""}${anxiety ? `:${anxiety}` : ""}`;
  };
  if (!opts?.allTiers) return one("", persona.core);
  return [one("核心受众=", persona.core), one("邻近受众=", persona.adjacent), one("意外受众=", persona.surprise)]
    .filter(Boolean)
    .join(";");
}

/** 创作者目标(V5.6 /goal):北极星——注入选题/写作/复盘全链;旧目标留档供复盘对照 */
export interface CreatorGoal {
  statement: string;
  /** 期限,如 "2026-09-30" / "3 个月" */
  horizon?: string;
  /** 关键指标,如 ["公众号 1 万粉", "周更 3 篇"] */
  metrics?: string[];
  setAt: string;
  history?: Array<{ statement: string; setAt: string }>;
}

/** 目标一行话渲染(prompt/复盘共用口径) */
export function goalSummary(goal: CreatorGoal | null | undefined): string {
  if (!goal?.statement) return "";
  return (
    goal.statement +
    (goal.horizon ? `(期限:${goal.horizon})` : "") +
    (goal.metrics?.length ? `;关键指标:${goal.metrics.join("、")}` : "")
  );
}

export interface CompetitorAccount {
  platform: string;
  profileUrl: string;
  name: string;
  addedAt: string;
}

export interface PerformanceEntry {
  contentId: string;
  platform: string;
  metrics: Record<string, number>;
  recordedAt: string;
}

export interface CreatorProfile {
  /** User's content industry/niche */
  industry: string;
  /**
   * 选题雷达的粗筛关键词(校准中心可编辑)——与 industry 分开存:
   * industry 是给 LLM 读的散文定位,整段切词只会切出「部署工程师」这种永不命中的长 token,
   * 粗筛需要的是「AI、Agent、FDE」这类真会出现在标题里的短词。留空 = 回落 industry 切词。
   */
  focusKeywords?: string[];
  /** Active platforms */
  platforms: string[];
  /** Target audience persona */
  audiencePersona: AudiencePersona | null;
  /** 创作者目标(V5.6 /goal,可缺省——存量档案无此字段) */
  goal?: CreatorGoal | null;
  /** Auto-distilled + user-explicit writing rules */
  writingRules: WritingRule[];
  /**
   * 创作者原文段落(爆款吸收时逐字截取,V5.7 活人感)——写稿时作为声音样例注入。
   * 规则产生合规,样例产生声音:这是模仿语感的第一素材,抽象规则只做兜底。
   */
  voiceSamples?: string[];
  /** Style boundaries */
  styleBoundaries: { never: string[]; always: string[] };
  /** Competitor accounts (Pro) */
  competitorAccounts: CompetitorAccount[];
  /** Historical performance data points */
  performanceHistory: PerformanceEntry[];
  /** Whether style calibration has been completed */
  styleCalibrated: boolean;
  /** Profile creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

const PROFILE_FILE = "creator-profile.json";


function emptyProfile(): CreatorProfile {
  const now = new Date().toISOString();
  return {
    industry: "",
    platforms: [],
    audiencePersona: null,
    writingRules: [],
    styleBoundaries: { never: [], always: [] },
    competitorAccounts: [],
    performanceHistory: [],
    styleCalibrated: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Check if creator-profile.json exists.
 */
export async function profileExists(dataDir?: string): Promise<boolean> {
  const filePath = path.join(getDataDir(dataDir), PROFILE_FILE);
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the creator profile. Returns null if it doesn't exist.
 */
export async function loadProfile(dataDir?: string): Promise<CreatorProfile | null> {
  const filePath = path.join(getDataDir(dataDir), PROFILE_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const profile = JSON.parse(raw) as CreatorProfile;
    // 读侧归一(V5.1):历史扁平画像/老 muse 遗产形状 → 三层结构;坏形状置 null 而非带病传播
    profile.audiencePersona = normalizeAudiencePersona(profile.audiencePersona);
    return profile;
  } catch {
    return null;
  }
}

/**
 * Save the full creator profile (overwrite).
 */
export async function saveProfile(profile: CreatorProfile, dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  profile.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, PROFILE_FILE), JSON.stringify(profile, null, 2), "utf-8");
}

/**
 * Initialize a new empty profile. No-op if one already exists.
 * Returns the profile (existing or newly created).
 */
export async function initProfile(dataDir?: string): Promise<CreatorProfile> {
  const existing = await loadProfile(dataDir);
  if (existing) return existing;
  const profile = emptyProfile();
  await saveProfile(profile, dataDir);
  return profile;
}

/**
 * Partially update the profile (merge fields).
 */
export async function updateProfile(
  updates: Partial<Omit<CreatorProfile, "createdAt" | "updatedAt">>,
  dataDir?: string,
): Promise<CreatorProfile> {
  let profile = await loadProfile(dataDir);
  if (!profile) profile = emptyProfile();

  const merged: CreatorProfile = {
    ...profile,
    ...updates,
    // Arrays: replace entirely if provided, keep existing otherwise
    writingRules: updates.writingRules ?? profile.writingRules,
    competitorAccounts: updates.competitorAccounts ?? profile.competitorAccounts,
    performanceHistory: updates.performanceHistory ?? profile.performanceHistory,
    // Preserve immutable fields
    createdAt: profile.createdAt,
    updatedAt: new Date().toISOString(),
  };

  await saveProfile(merged, dataDir);
  return merged;
}

/**
 * Add a writing rule (deduplicates by rule text).
 *
 * 升格路由（PRD-v4 §4.3）：同一规则文本以另一个平台 scope 再次出现
 * （= 同一模式在 ≥2 个平台被纠正）→ 升格进声音内核（scope 改 voice_core）。
 */
export async function addWritingRule(rule: Omit<WritingRule, "createdAt">, dataDir?: string): Promise<CreatorProfile> {
  const profile = (await loadProfile(dataDir)) || emptyProfile();
  const existing = profile.writingRules.find((r) => r.rule === rule.rule);
  if (existing) {
    const existingScope = existing.scope ?? "voice_core";
    const incomingScope = rule.scope ?? "voice_core";
    if (existingScope !== "voice_core" && incomingScope !== existingScope) {
      existing.scope = "voice_core";
    }
  } else {
    profile.writingRules.push({ ...rule, createdAt: new Date().toISOString() });
  }
  await saveProfile(profile, dataDir);
  return profile;
}

/** 声音样本上限:再多注意力摊薄,且写稿 prompt 的 token 预算要留给调研材料 */
const VOICE_SAMPLES_CAP = 5;

/**
 * 追加声音样本(逐字段落):按文本去重,超上限保留最新——最近的爆款最能代表当前声音。
 */
export async function addVoiceSamples(samples: string[], dataDir?: string): Promise<CreatorProfile> {
  const profile = (await loadProfile(dataDir)) || emptyProfile();
  const merged = [...(profile.voiceSamples ?? [])];
  for (const s of samples) {
    const text = s.trim();
    if (text && !merged.includes(text)) merged.push(text);
  }
  profile.voiceSamples = merged.slice(-VOICE_SAMPLES_CAP);
  await saveProfile(profile, dataDir);
  return profile;
}

/**
 * 生成时注入的规则 = 声音内核 + 当前平台包，其余平台的规则隔离在外（PRD-v4 §4.3）。
 */
export function rulesForPlatform(profile: CreatorProfile, platform: string): WritingRule[] {
  return profile.writingRules.filter((r) => {
    if (r.disabled) return false;
    const scope = r.scope ?? "voice_core";
    return scope === "voice_core" || scope === `platform:${platform}`;
  });
}

/**
 * Edit or toggle a writing rule by index (个性化中心：可编辑、可停用).
 *
 * 注：直接 mutate loadProfile 返回对象后经 updateProfile 整组落盘——与 addWritingRule
 * 的 saveProfile-direct 模式不同但等价（updateProfile 对 writingRules 是整体替换语义，
 * 单线程无 yield 点，无并发窗口）。
 */
export async function updateWritingRule(
  index: number,
  patch: { rule?: string; disabled?: boolean },
  dataDir?: string,
): Promise<CreatorProfile> {
  const profile = await loadProfile(dataDir);
  if (!profile) throw new Error("尚无创作者档案");
  const target = profile.writingRules[index];
  if (!target) throw new Error(`规则不存在：index ${index}`);
  if (patch.rule !== undefined) {
    const text = patch.rule.trim();
    if (text === "") throw new Error("规则内容不能为空");
    target.rule = text;
  }
  if (patch.disabled !== undefined) target.disabled = patch.disabled;
  return updateProfile({ writingRules: profile.writingRules }, dataDir);
}

/**
 * Add a competitor account (deduplicates by profileUrl).
 */
export async function addCompetitor(account: Omit<CompetitorAccount, "addedAt">, dataDir?: string): Promise<CreatorProfile> {
  const profile = (await loadProfile(dataDir)) || emptyProfile();
  const exists = profile.competitorAccounts.some((c) => c.profileUrl === account.profileUrl);
  if (!exists) {
    profile.competitorAccounts.push({ ...account, addedAt: new Date().toISOString() });
  }
  await saveProfile(profile, dataDir);
  return profile;
}

/**
 * Record a performance data point.
 */
export async function addPerformanceEntry(entry: Omit<PerformanceEntry, "recordedAt">, dataDir?: string): Promise<void> {
  const profile = (await loadProfile(dataDir)) || emptyProfile();
  profile.performanceHistory.push({ ...entry, recordedAt: new Date().toISOString() });
  // Keep last 100 entries
  if (profile.performanceHistory.length > 100) {
    profile.performanceHistory = profile.performanceHistory.slice(-100);
  }
  await saveProfile(profile, dataDir);
}

/**
 * Detect what information is missing from the profile.
 * Used by the onboarding skill to decide what to ask.
 */
export function detectMissingInfo(profile: CreatorProfile): string[] {
  const missing: string[] = [];
  if (!profile.industry) missing.push("industry");
  if (profile.platforms.length === 0) missing.push("platforms");
  if (!profile.audiencePersona) missing.push("audience");
  if (!profile.styleCalibrated) missing.push("style");
  return missing;
}
