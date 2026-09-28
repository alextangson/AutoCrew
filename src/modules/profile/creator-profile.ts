/**
 * Creator Profile — Structured creator persona stored at ~/.autocrew/creator-profile.json
 *
 * This is the core identity file that drives personalized writing, topic scoring,
 * and style calibration. It's initialized during onboarding (from host MEMORY or
 * by asking the user) and continuously enriched by the Learnings system.
 */
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { normalizeRules } from "./writing-rules.js";
export { rulesForPlatform, ruleStatus, isRuleActive, addWritingRule, updateWritingRule, decideWritingRule, type RuleStatus, type RuleDecision } from "./writing-rules.js";

/**
 * 规则作用域（PRD-v4 §4.3 声音内核/平台包分层）：
 * "voice_core" = 跨平台声音内核（用词癖好、口头禅、立场、禁忌）；
 * "platform:<id>" = 平台包专属（结构、长度、格式规范）。
 * 缺省视为 voice_core（历史规则兼容，无需迁移）。
 */
export type RuleScope = "voice_core" | `platform:${string}`;

export interface WritingRule {
  /** 稳定 ID；存量规则缺失时读侧按内容补一个，下次写入落盘 */
  id?: string;
  /** 每次内容或状态变化 +1；审批事件绑定 id+revision */
  revision?: number;
  /**
   * active 生效 / pending 待批 / rejected 丢弃（墓碑：以后蒸馏再提同一条直接挡掉）/ disabled 停用。
   * 缺省按存量规则处理：disabled:true → 停用，否则生效。新写入的规则一律显式带 status。
   */
  status?: "active" | "pending" | "rejected" | "disabled";
  /** 蒸馏/记录时依据的证据摘录（哪几处改稿、哪条用户原话），给创始人审批时看 */
  evidence?: string[];
  /** 「升级为全局」提案：指向被升级的平台规则 id；批准后原规则停用、本条生效 */
  promotes?: string;
  /** 提案针对的原平台规则 revision；原规则之后被改过/重新批过，这份提案就过时了 */
  promotesRevision?: number;
  /** 已完成的升级：来自哪条平台规则（只作记录，不再参与审批） */
  promotedFrom?: string;
  rule: string;
  /** "auto_distilled" = extracted from user edits, "user_explicit" = user stated directly,
   *  "calibrated" = produced by the calibration skills (A/B-verified during onboarding) */
  source: "auto_distilled" | "user_explicit" | "calibrated" | "manual";
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
  /** 档案写入序号（CAS 用） */
  revision?: number;
  /** 工作台审批事件（幂等键 eventId） */
  ruleDecisions?: Array<{ eventId: string; ruleId: string; revision: number; decision: string; at: string }>;
  /** User's content industry/niche */
  industry: string;
  /** 创作者保存的表达定位；不能只保存在档案里而不交给写手。 */
  expressionPersona?: string;
  /** 长期内容规划。视频时长/字数只作为视频稿的默认值，本次要求优先。 */
  contentFormat?: { videoLength?: string; contentDepth?: string; wordCount?: string };
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
 * 读侧给存量规则补稳定 id 与 revision（只在内存里；下一次写入才落盘），不改它们的生效状态。
 */
export async function loadProfile(dataDir?: string): Promise<CreatorProfile | null> {
  const filePath = path.join(getDataDir(dataDir), PROFILE_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const profile = JSON.parse(raw) as CreatorProfile;
    // 读侧归一(V5.1):历史扁平画像/老 muse 遗产形状 → 三层结构;坏形状置 null 而非带病传播
    profile.audiencePersona = normalizeAudiencePersona(profile.audiencePersona);
    profile.writingRules = normalizeRules(profile.writingRules ?? []);
    profile.revision ??= 0; // 读出来的档案总带 revision，整份保存时据此做 CAS
    return profile;
  } catch {
    return null;
  }
}

/**
 * 档案写入统一走这里（spec §3 D「写档案要串行」）：同一资料目录一条队列、带预期 revision、temp+rename 原子落盘。
 * 单写者约束：同一资料目录只允许一个 AutoCrew 进程写（见 profile-writer-lock）；进程内由这条队列串行。
 */
const profileQueues = new Map<string, Promise<unknown>>();
function serializeProfile<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(getDataDir(dataDir));
  const next = (profileQueues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(() => {}, () => {});
  profileQueues.set(key, tail);
  void tail.then(() => { if (profileQueues.get(key) === tail) profileQueues.delete(key); });
  return next;
}

async function writeProfile(profile: CreatorProfile, dataDir?: string): Promise<void> {
  profile.revision = (profile.revision ?? 0) + 1;
  profile.updatedAt = new Date().toISOString();
  await writeJsonAtomicMkdir(path.join(getDataDir(dataDir), PROFILE_FILE), profile);
}

/**
 * 比对预期 revision：拿着旧快照整份覆盖会丢掉别人刚写的东西（例如创始人刚批的规则），直接报冲突。
 * 读出来的档案一定带 revision；不带 revision 的是调用方从零构造的整份档案（初始化、测试夹具），按覆盖处理。
 */
async function casWrite(profile: CreatorProfile, dataDir?: string): Promise<void> {
  const current = await loadProfile(dataDir);
  if (current && profile.revision !== undefined && (current.revision ?? 0) !== profile.revision) {
    throw new Error("档案已被其他操作更新（profile_revision_conflict），请重新读取后再保存");
  }
  await writeProfile(profile, dataDir);
}

/**
 * Save the full creator profile (compare-and-swap on revision).
 * 内部可信接口：模型可达的入口（MCP editorial、对话、IPC）都不把 writingRules 透传到这里，规则只能走 writing-rules 的函数。
 */
export async function saveProfile(profile: CreatorProfile, dataDir?: string): Promise<void> {
  return serializeProfile(dataDir, () => casWrite(profile, dataDir));
}

/** 读-改-写一次完成，全程在队列里，不会跟审批或后台蒸馏互相覆盖 */
export async function mutateProfile<T = void>(
  fn: (profile: CreatorProfile) => T,
  dataDir?: string,
): Promise<{ profile: CreatorProfile; result: T }> {
  return serializeProfile(dataDir, async () => {
    const profile = (await loadProfile(dataDir)) ?? emptyProfile();
    const result = fn(profile);
    await writeProfile(profile, dataDir);
    return { profile, result };
  });
}

/**
 * Initialize a new empty profile. No-op if one already exists.
 * Returns the profile (existing or newly created).
 */
export async function initProfile(dataDir?: string): Promise<CreatorProfile> {
  return serializeProfile(dataDir, async () => {
    const existing = await loadProfile(dataDir);
    if (existing) return existing;
    const profile = emptyProfile();
    await writeProfile(profile, dataDir);
    return profile;
  });
}

/**
 * Partially update the profile (merge fields). 不接受 writingRules：规则的增改审批只走 writing-rules。
 */
export async function updateProfile(
  updates: Partial<Omit<CreatorProfile, "createdAt" | "updatedAt" | "writingRules" | "revision" | "ruleDecisions">>,
  dataDir?: string,
): Promise<CreatorProfile> {
  const { profile } = await mutateProfile((profile) => {
    const safe = { ...updates } as Record<string, unknown>;
    delete safe.writingRules; delete safe.revision; delete safe.ruleDecisions; delete safe.createdAt;
    Object.assign(profile, safe);
  }, dataDir);
  return profile;
}

/** 声音样本上限:再多注意力摊薄,且写稿 prompt 的 token 预算要留给调研材料 */
const VOICE_SAMPLES_CAP = 5;

/**
 * 追加声音样本(逐字段落):按文本去重,超上限保留最新——最近的爆款最能代表当前声音。
 */
export async function addVoiceSamples(samples: string[], dataDir?: string): Promise<CreatorProfile> {
  const { profile } = await mutateProfile((profile) => {
    const merged = [...(profile.voiceSamples ?? [])];
    for (const s of samples) {
      const text = s.trim();
      if (text && !merged.includes(text)) merged.push(text);
    }
    profile.voiceSamples = merged.slice(-VOICE_SAMPLES_CAP);
  }, dataDir);
  return profile;
}

/**
 * Add a competitor account (deduplicates by profileUrl).
 */
export async function addCompetitor(account: Omit<CompetitorAccount, "addedAt">, dataDir?: string): Promise<CreatorProfile> {
  const { profile } = await mutateProfile((profile) => {
    const exists = profile.competitorAccounts.some((c) => c.profileUrl === account.profileUrl);
    if (!exists) profile.competitorAccounts.push({ ...account, addedAt: new Date().toISOString() });
  }, dataDir);
  return profile;
}

/**
 * Record a performance data point.
 */
export async function addPerformanceEntry(entry: Omit<PerformanceEntry, "recordedAt">, dataDir?: string): Promise<void> {
  await mutateProfile((profile) => {
    profile.performanceHistory.push({ ...entry, recordedAt: new Date().toISOString() });
    // Keep last 100 entries
    if (profile.performanceHistory.length > 100) profile.performanceHistory = profile.performanceHistory.slice(-100);
  }, dataDir);
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
