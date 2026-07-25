/**
 * Script Prompt Assembly — pure function driving prompt construction.
 *
 * Takes a track pack, optional creator profile, and request (topic + platform + research)
 * and assembles system/user prompts for the writing model. No I/O, no side effects.
 */
import type { TrackPack, StructureMode, QualityGateSpec } from "../packs/pack-schema.js";
import type { CreatorProfile } from "../profile/creator-profile.js";
import { rulesForPlatform, personaSummary, goalSummary } from "../profile/creator-profile.js";
import type { ContrastPair } from "../learnings/diff-tracker.js";
import { resolveQualityGate } from "./quality-gate.js";
import type { ClipboardPlatform } from "../publish/clipboard-publisher.js";
import type { PatternCard } from "../patterns/pattern-store.js";

export interface ScriptRequest {
  topic: string;
  platform: ClipboardPlatform;
  /** 调研材料（可选，RAW 注入） */
  research?: string;
  /** 显式指定赛道包；缺省按平台路由（wechat_mp → 公众号图文，其余 → 口播） */
  packId?: string;
  /** 灵感库血缘（V5.4c）:选题来自灵感库时携带——归因、过期保护、平台矩阵都靠它 */
  topicId?: string;
  /** 对标拆解卡注入开关（收件箱设计 §3.5）：缺省启用，false = 本次不选卡也不注入 */
  usePatterns?: boolean;
}

export interface ScriptPromptExtras {
  /** 创始人亲手改稿的对比对(diff-tracker 提取)——教"改动方向" */
  contrastPairs?: ContrastPair[];
  /** 对标拆解卡（收件箱设计 §3.5 的唯一注入点）：缺省/空数组时整块不出现 */
  patterns?: PatternCard[];
}

/** 定界符导出给测试与下游断言用——块的存在与否是可验证结构，不靠匹配文案 */
export const PATTERN_BLOCK_START = "<<<REFERENCE_PATTERNS>>>";
export const PATTERN_BLOCK_END = "<<<END_REFERENCE_PATTERNS>>>";

export function buildScriptPrompts(
  pack: TrackPack,
  profile: CreatorProfile | null,
  req: ScriptRequest,
  extras?: ScriptPromptExtras,
): { system: string; user: string } {
  const system = buildSystemPrompt(pack, profile, req.platform, extras);
  const user = buildUserPrompt(req, extras?.patterns ?? []);
  return { system, user };
}

function buildSystemPrompt(
  pack: TrackPack,
  profile: CreatorProfile | null,
  platform: ClipboardPlatform,
  extras?: ScriptPromptExtras,
): string {
  const parts: string[] = [];

  // Role + pack name（包可覆盖：公众号图文写手 vs 口播编剧）
  parts.push(pack.writerRole ?? `你是一名专业的口播脚本编剧，擅长为《${pack.name}》赛道创作高效的内容。`);
  parts.push("");

  // Hooks with instruction
  parts.push("## 钩子（Hook）选择");
  parts.push("从以下钩子类型中只选一种最强的来打开脚本：");
  parts.push("");
  for (const hook of pack.hooks) {
    parts.push(`- **${hook.type}**：${hook.whenToUse}`);
  }
  parts.push("");

  if (pack.structureModes?.length) parts.push(renderStructureModes(pack.structureModes));

  parts.push(renderStructure(pack));

  const gate = resolveQualityGate(pack, platform);
  if (gate) parts.push(renderQualityGate(gate));

  // 提交前自检(V5.7):此前 selfReview 只活在 MCP 技能路径,引擎写稿模型从没见过它
  if (pack.selfReview.length > 0) {
    parts.push("## 提交前自检(逐项过一遍,不达标先改再提交)");
    for (const q of pack.selfReview) {
      parts.push(`- ${q}`);
    }
    parts.push("");
  }

  // Platform adjustments
  const platformAdj = pack.platformAdjustments[platform];
  if (platformAdj) {
    parts.push("## 平台特化");
    parts.push(`**篇幅/格式**：${platformAdj.chars}`);
    parts.push(`**风格要求**：${platformAdj.style}`);
    parts.push("");
  }

  const profileSection = profile ? renderProfile(profile, platform, extras?.contrastPairs) : "";
  if (profileSection) parts.push(profileSection);

  // Compliance
  parts.push("## 合规声明");
  parts.push(pack.complianceNote);
  parts.push("");

  // Tool submission requirement
  parts.push("## 输出要求");
  parts.push("**必须调用 submit_script 工具提交成品，不要把脚本写在普通回复里。**");
  parts.push("工具需要以下字段：title（标题）、hook（开篇）、body（正文）、cta（行动号召）、hashtags（话题标签）。");

  return parts.join("\n");
}

function renderStructureModes(modes: StructureMode[]): string {
  const parts: string[] = ["## 结构模式（选其一）", "按选题特性选择最合适的一种模式展开全文："];
  for (const m of modes) {
    parts.push(`- **${m.name}**：${m.guide}`);
  }
  parts.push("");
  return parts.join("\n");
}

/** Gate 阈值前置进 prompt：让模型第一稿就冲达标线，而不是靠打回轮学习要求 */
function renderQualityGate(gate: QualityGateSpec): string {
  const parts: string[] = ["## 质量硬门禁（提交即校验，未达标会被打回重写）"];
  if (gate.minChars !== undefined) parts.push(`- 全文中文字符 ≥ ${gate.minChars}`);
  if (gate.maxChars !== undefined) parts.push(`- 全文中文字符 ≤ ${gate.maxChars}（发布文案硬顶，超限打回压缩）`);
  if (gate.minDataPoints !== undefined) {
    parts.push(`- 数据引用（数字+百分比/时间/金额等量纲）≥ ${gate.minDataPoints} 处`);
  }
  if (gate.minImageTags !== undefined) {
    parts.push(`- 正文 [IMAGE: 具体画面prompt] 配图标记 ≥ ${gate.minImageTags} 个，分布在不同段落`);
  }
  if (gate.bannedHookPatterns?.length) parts.push("- 开头命中反模式即打回（禁用开头见上方规则）");
  parts.push("");
  return parts.join("\n");
}

function renderStructure(pack: TrackPack): string {
  const parts: string[] = ["## 脚本结构规则"];
  const sections: Array<[string, string[]]> = [
    ["### Hook（开篇）", pack.structure.hook],
    ["### Body（正文）", pack.structure.body],
    ["### CTA（行动号召）", pack.structure.cta],
  ];
  for (const [heading, rules] of sections) {
    if (rules.length === 0) continue;
    parts.push(heading);
    for (const rule of rules) {
      parts.push(`- ${rule}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

function renderProfile(profile: CreatorProfile, platform: ClipboardPlatform, contrastPairs?: ContrastPair[]): string {
  const parts: string[] = [];

  // 受众画像(V5.1):写手必须知道写给谁——core 层全量,邻近/意外一行带过
  const audience = personaSummary(profile.audiencePersona, { allTiers: true });
  if (audience) {
    parts.push("## 目标受众");
    parts.push(audience);
    const triggers = profile.audiencePersona?.core?.scrollStopTriggers ?? [];
    if (triggers.length > 0) parts.push(`核心受众的停留触发:${triggers.join("、")}`);
    parts.push("写作时以核心受众为主要对话对象:开头要打中 TA 的处境,论证密度按 TA 的认知水平校准。");
    parts.push("");
  }

  // 创作目标(V5.6 /goal):内容服务目标,但不生硬点名目标本身
  const goal = goalSummary(profile.goal);
  if (goal) {
    parts.push("## 创作目标");
    parts.push(goal);
    parts.push("选角度与 CTA 时让内容服务这个目标,但不要在正文里生硬点名目标本身。");
    parts.push("");
  }

  // 声音样本(V5.7 活人感):样例产生声音,规则只做兜底——这是模仿语感的第一素材
  const samples = (profile.voiceSamples ?? []).filter((s) => s.trim() !== "");
  if (samples.length > 0) {
    parts.push("## 创作者声音样本");
    parts.push("下面是创作者本人写的段落。成稿要像同一个人写的——学语感、节奏、用词习惯,不是学内容;禁止照抄或化用其中的句子:");
    samples.forEach((s, i) => {
      parts.push(`【样本 ${i + 1}】${s.slice(0, 300)}`);
    });
    parts.push("");
  }

  // 改稿方向(V5.7):创始人亲手改过的地方,教的是品味方向
  if (contrastPairs && contrastPairs.length > 0) {
    parts.push("## 改稿方向(创作者亲手改过的地方)");
    parts.push("每组左边是被创作者删改的写法,右边是 TA 改成的样子。学改动方向,新稿不要再犯左边的毛病:");
    for (const p of contrastPairs) {
      parts.push(`- 改前:「${p.before}」→ 改后:「${p.after}」${p.note ? `(创作者备注:${p.note})` : ""}`);
    }
    parts.push("");
  }

  // 声音内核 + 当前平台包，其余平台的规则不进上下文（PRD-v4 §4.3 隔离）
  const activeRules = rulesForPlatform(profile, platform);
  if (activeRules.length > 0) {
    parts.push("## 个人写作规则");
    for (const rule of activeRules) {
      parts.push(`- ${rule.rule}`);
    }
    parts.push("");
  }

  const { never, always } = profile.styleBoundaries;
  if (never.length > 0 || always.length > 0) {
    parts.push("## 风格边界");
    if (never.length > 0) {
      parts.push("**绝不用**：");
      for (const item of never) {
        parts.push(`- ${item}`);
      }
    }
    if (always.length > 0) {
      parts.push("**必须用**：");
      for (const item of always) {
        parts.push(`- ${item}`);
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * 对标拆解卡定界块（§3.5 注入 + §3.6 注入防护）：外部来源的内容进 prompt 必须带
 * 边界与用途说明——卡是"怎么讲"的参考，不是可搬运的文案。字段级长度上限已在
 * pattern-store 落库时截过，这里不重复截断。
 */
function renderPatterns(cards: PatternCard[]): string {
  const parts: string[] = [
    PATTERN_BLOCK_START,
    "以下为对标拆解参考：借钩子类型与结构骨架，禁止改写或翻译其文案原句。",
  ];
  cards.forEach((card, i) => {
    parts.push(`【参考 ${i + 1}】${card.title}`);
    parts.push(`- 钩子：${card.hook}`);
    parts.push(`- 结构：${card.structure.map((step, j) => `${j + 1}) ${step}`).join(" ")}`);
    if (card.whyItWorks.length > 0) parts.push(`- 为什么有效：${card.whyItWorks.join("；")}`);
    if (card.themes.length > 0) parts.push(`- 主题：${card.themes.join("、")}`);
  });
  parts.push(PATTERN_BLOCK_END);
  return parts.join("\n");
}

function buildUserPrompt(req: ScriptRequest, patterns: PatternCard[]): string {
  const parts: string[] = [];

  parts.push(`选题：${req.topic}`);
  parts.push("");

  if (req.research) {
    parts.push(`调研材料：${req.research}`);
  } else {
    parts.push("无调研材料，基于常识写但避免编造数据。");
  }
  parts.push("");

  if (patterns.length > 0) {
    parts.push(renderPatterns(patterns));
    parts.push("");
  }

  parts.push(`目标平台：${req.platform}`);

  return parts.join("\n");
}
