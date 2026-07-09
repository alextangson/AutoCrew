/**
 * 受众画像生成与校准（IA v5 V5.1,继承 PRD-v2 Phase 0.5 设计）。
 *
 * 流程:generateAudiencePersonaProposal 产出三层画像提案(core/adjacent/surprise)
 * → 用户确认(校准中心画像面板或对话流) → savePersonaCalibrated 落
 * creator-profile(唯一事实源)并打 calibratedAt 章。提案态绝不直接落库——
 * 画像是后续写作与「受众停留审」的审核标准,必须经过用户确认。
 *
 * V5.6:输入不再只有定位想象——注入数据回流信号(已发内容表现/采纳率/记忆洞察),
 * 画像跟着谁真的停留、谁真的收藏修正。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadEngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { listContents, adoptionStats, getDataDir } from "../../storage/local-store.js";
import { listLatestOutcomes } from "../flywheel/outcome-store.js";
import type { OutcomeMetrics } from "../flywheel/outcome-schema.js";
import {
  loadProfile,
  updateProfile,
  normalizeAudiencePersona,
  type AudiencePersona,
  type CreatorProfile,
} from "./creator-profile.js";

export interface PersonaProposalResult {
  proposal: AudiencePersona;
  /** 生成依据摘要(对话里给用户看的"我为什么这么画") */
  basis: string;
}

const TIER_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "给这个受众起个有记忆点的名字,如「小林」" },
    age: { type: "string", description: "年龄或年龄段,如「28」「35-45」" },
    job: { type: "string", description: "职业/身份,如「连续创业者」" },
    coreAnxiety: { type: "string", description: "核心焦虑一句话,第一人称视角写" },
    painPoints: { type: "array", items: { type: "string" }, description: "2-4 个短语痛点(≤8字,用于选题匹配)" },
    scrollStopTriggers: { type: "array", items: { type: "string" }, description: "1-3 个能让 TA 停下滑动的内容特征" },
  },
  required: ["name", "coreAnxiety", "painPoints"],
} as const;

function buildSubmitPersonaTool(captured: { persona: AudiencePersona | null; basis: string }): LoopTool {
  return {
    name: "submit_persona",
    description: "提交三层受众画像提案。core 必填;adjacent/surprise 尽量给出。",
    parameters: {
      type: "object",
      properties: {
        core: { ...TIER_SCHEMA, description: "核心受众:内容最主要写给谁" },
        adjacent: { ...TIER_SCHEMA, description: "邻近受众:处境相邻、会被同一批内容打中的人" },
        surprise: { ...TIER_SCHEMA, description: "意外受众:定位之外但确实会被吸引的人群" },
        basis: { type: "string", description: "生成依据摘要,2-3 句,说清画像从定位/作品的哪些信号推出" },
      },
      required: ["core", "basis"],
    },
    execute(args) {
      const normalized = normalizeAudiencePersona(args);
      if (!normalized) return "Error: core 画像缺失或缺 name,请补全后重新调用 submit_persona";
      if (!normalized.core.coreAnxiety || !(normalized.core.painPoints ?? []).length) {
        return "Error: core 画像必须有 coreAnxiety 和至少 1 个 painPoints 短语,请补全后重新调用";
      }
      captured.persona = normalized;
      captured.basis = typeof args.basis === "string" ? args.basis : "";
      return "已收到画像提案";
    },
  };
}

/** 数据回流信号:画像不该只从定位想象——谁真的停留/收藏/被采纳,是更硬的证据。 */
export interface PersonaSignals {
  /** 已发内容表现 top/bottom(按 views 排序);≥2 条带 views 的作品快照才输出 */
  outcomes: string;
  /** 采纳裁决聚合;≥3 篇已裁决才输出(小样本噪声不进 prompt) */
  adoption: string;
  /** MEMORY.md「Performance Insights」末 6 条 */
  insights: string;
}

const METRIC_LABELS: Array<[keyof OutcomeMetrics, string]> = [
  ["views", "阅读/播放"],
  ["likes", "赞"],
  ["favorites", "藏"],
  ["comments", "评"],
  ["follows", "粉"],
  ["completionRate", "完播%"],
];

function renderMetrics(m: OutcomeMetrics): string {
  return METRIC_LABELS.flatMap(([k, label]) => (typeof m[k] === "number" ? [`${label} ${m[k]}`] : [])).join(" · ");
}

async function readPerformanceInsights(dataDir?: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(getDataDir(dataDir), "MEMORY.md"), "utf-8");
    const section = raw.match(/## Performance Insights\n([\s\S]*?)(?=\n## |$)/);
    if (!section) return "";
    return section[1].split("\n").map((l) => l.trim()).filter((l) => l.startsWith("-")).slice(-6).join("\n");
  } catch {
    return "";
  }
}

export async function gatherPersonaSignals(dataDir?: string): Promise<PersonaSignals> {
  const [outcomes, stats, insights] = await Promise.all([
    listLatestOutcomes(dataDir).catch(() => []),
    adoptionStats(dataDir).catch(() => null),
    readPerformanceInsights(dataDir),
  ]);
  const withViews = outcomes.filter((o) => typeof o.metrics.views === "number");
  let outcomeBlock = "";
  if (withViews.length >= 2) {
    const sorted = [...withViews].sort((a, b) => (b.metrics.views ?? 0) - (a.metrics.views ?? 0));
    const line = (o: (typeof sorted)[number]) => `- 《${o.platformTitle}》(${o.platform}) ${renderMetrics(o.metrics)}`;
    const top = sorted.slice(0, 3).map(line).join("\n");
    const rest = sorted.length > 3 ? sorted.slice(-Math.min(3, sorted.length - 3)).map(line).join("\n") : "";
    outcomeBlock = `表现最好:\n${top}` + (rest ? `\n表现最差:\n${rest}` : "");
  }
  const adoptionBlock =
    stats && stats.judged >= 3 && stats.rate !== null
      ? `已裁决 ${stats.judged} 篇,采纳率 ${Math.round(stats.rate * 100)}%(采纳 ${stats.adopted}/轻改 ${stats.lightEdit}/重写 ${stats.rewritten})`
      : "";
  return { outcomes: outcomeBlock, adoption: adoptionBlock, insights };
}

function buildPersonaUserMessage(
  industry: string,
  rules: string,
  never: string[] | undefined,
  recentTitles: string,
  signals: PersonaSignals,
): string {
  return (
    `创作者定位:${industry}\n` +
    (rules ? `\n写作规则(反映其口吻与立场):\n${rules}\n` : "") +
    (never?.length ? `\n风格红线(never):${never.join("、")}\n` : "") +
    (recentTitles ? `\n近期稿件标题:\n${recentTitles}\n` : "") +
    (signals.outcomes ? `\n已发内容表现(真实数据,画像要贴着它修正):\n${signals.outcomes}\n` : "") +
    (signals.adoption ? `\n稿件采纳信号:${signals.adoption}\n` : "") +
    (signals.insights ? `\n长期记忆·表现洞察:\n${signals.insights}\n` : "") +
    "\n请生成三层受众画像提案。"
  );
}

/**
 * 生成画像提案:输入=定位 + 风格边界 + 活跃写作规则 + 近期稿件标题(真实创作痕迹)
 * + 数据回流信号(gatherPersonaSignals)。输出是提案,不落库。
 */
export async function generateAudiencePersonaProposal(
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<PersonaProposalResult> {
  const [config, profile, contents, signals] = await Promise.all([
    loadEngineConfig(dataDir),
    loadProfile(dataDir),
    listContents(dataDir).catch(() => []),
    gatherPersonaSignals(dataDir),
  ]);
  const industry = profile?.industry?.trim();
  if (!industry) {
    throw new Error("先在校准中心填写定位(行业/赛道),画像需要以定位为锚");
  }

  const rules = (profile?.writingRules ?? [])
    .filter((r) => !r.disabled)
    .slice(0, 8)
    .map((r) => `- ${r.rule}`)
    .join("\n");
  const boundaries = profile?.styleBoundaries;
  const recentTitles = contents
    .filter((c) => c.status !== "drafting")
    .slice(0, 8)
    .map((c) => `- ${c.title}`)
    .join("\n");

  const captured = { persona: null as AudiencePersona | null, basis: "" };
  const submitTool = buildSubmitPersonaTool(captured);
  const loopFn = deps?.runLoopImpl ?? runLoop;

  await loopFn(config, {
    model: config.strongModel,
    systemPrompt:
      "你是新媒体受众研究员。根据创作者的定位、创作痕迹与真实数据信号,推导三层受众画像:" +
      "core(核心受众)/adjacent(邻近受众)/surprise(意外受众)。" +
      "画像必须具体到能当审稿标准用:coreAnxiety 要写出 TA 深夜会想的那句话,painPoints 必须是短语(用于选题关键词匹配)。" +
      "不要泛泛的「上班族」——要有名字、处境和真实焦虑。" +
      "若提供了已发内容表现/采纳信号:谁停留、谁收藏是比定位想象更硬的证据,画像要向数据修正;但样本小时只做微调,别过拟合单篇爆款。" +
      "完成后调用 submit_persona 提交。",
    userMessage: buildPersonaUserMessage(industry, rules, boundaries?.never, recentTitles, signals),
    tools: [submitTool],
    maxTurns: 3,
    logMeta: { agent: "audience-researcher" },
  });

  if (!captured.persona) {
    throw new Error("画像生成失败:模型未调用 submit_persona 提交画像");
  }
  return { proposal: captured.persona, basis: captured.basis };
}

/**
 * 校准落库:用户确认/修正后的画像写入 profile 并打 calibratedAt。
 * 入参接受任意形状(总编辑透传),normalize 后不合法即报错——审核标准不能带病上岗。
 */
export async function savePersonaCalibrated(
  personaInput: unknown,
  dataDir?: string,
): Promise<CreatorProfile> {
  const normalized = normalizeAudiencePersona(personaInput);
  if (!normalized) {
    throw new Error("画像形状不合法:至少需要 core.name");
  }
  if (!normalized.core.coreAnxiety && !(normalized.core.painPoints ?? []).length) {
    throw new Error("core 画像至少要有 coreAnxiety 或 painPoints,否则无法作为审稿标准");
  }
  const stamped: AudiencePersona = { ...normalized, calibratedAt: new Date().toISOString() };
  return updateProfile({ audiencePersona: stamped }, dataDir);
}
