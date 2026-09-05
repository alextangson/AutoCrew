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
import {
  evidenceByRef,
  isAngleCardV3,
  tensionByRef,
  type AngleCard,
  type AngleCardV3,
  type BriefEvidence,
} from "../research/brief-store.js";
// v2 卡的兼容读法（v3 有自己的一套渲染，见 buildAngleBlockV3）
import { cardAudiencePain, cardHoldTrigger } from "../research/angle-cards.js";
import { STRUCTURE_MENU } from "../research/angle-stage.js";
import { DEFAULT_PERSONAS, PERSONA_KEYS } from "../research/personas.js";
import { OWN_MATERIAL_USAGE_RULE } from "../research/own-material.js";
import { domainOf } from "../research/brief-inject.js";
import { sanitizeExternal } from "../research/research-prompt-kit.js";

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
  /**
   * 创作者手写的角度（角度卡 spec §1.3 优先级最高一档）。有它就压过选中的角度卡——
   * 创始人手写即最高裁决，卡还展示但不注入。
   */
  direction?: string;
  /**
   * 用户**明确**要跳过角度点选时的原话转述（§1.6：不让模型猜裸布尔）。
   * 只进 run-log 留痕，不进 prompt——它是「为什么没选角度」的证据，不是写作指令。
   */
  angleSkipReason?: string;
}

/** 生效的角度卡 + 它引用的那份证据（由 generate-script 解析好传进来，本模块不读盘） */
export interface ResolvedAngle {
  card: AngleCard;
  evidence: BriefEvidence[];
  tensions: string[];
}

export interface ScriptPromptExtras {
  /** 创始人亲手改稿的对比对(diff-tracker 提取)——教"改动方向" */
  contrastPairs?: ContrastPair[];
  /** 对标拆解卡（收件箱设计 §3.5 的唯一注入点）：缺省/空数组时整块不出现 */
  patterns?: PatternCard[];
  /** 生效角度卡（角度卡 spec §1.5）：req.direction 存在时由调用方留空——手写压过点选 */
  angle?: ResolvedAngle;
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
  const user = buildUserPrompt(req, extras?.patterns ?? [], extras?.angle);
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

  const profileSection = profile ? renderBrandContext(profile, platform, extras?.contrastPairs) : "";
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

/**
 * 创作者品牌上下文（受众/目标/声音样本/改稿方向/平台规则/风格边界）。
 * 写初稿与改稿共用同一块——两条路吃不同的上下文，改出来的稿就不是同一个人写的。
 * platform 放宽为 string：改稿链路拿到的是 Content.platform（可能为空/未知平台），
 * 空串时 rulesForPlatform 只回 voice_core 规则，正是想要的行为。
 */
export function renderBrandContext(
  profile: CreatorProfile,
  platform: string,
  contrastPairs?: ContrastPair[],
): string {
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

// ─── 本稿切入点（角度卡 spec §1.5 注入） ─────────────────────────────────────

/** 卡上的字段是模型写的、引文更是外部原文——同简报块的注入纪律：剥链接 + 掐伪造定界符 + 截断 */
export const ANGLE_FIELD_MAX = 200;
/**
 * 机制与收获感放宽到 400（spec §3.1 的字段上限同值）：这两项是 v3 卡里唯一要求
 * 「讲清因果 / 说人话」的字段，200 字截断会把因果链切成半句，写手照着半句写出来的
 * 就是比喻——那正是 P0c 判否的那一族。
 */
export const ANGLE_LONG_FIELD_MAX = 400;
const ANGLE_QUOTE_MAX = 160;
const ANGLE_CLAIM_MAX = 80;

function angleField(raw: string, max = ANGLE_FIELD_MAX): string {
  return sanitizeExternal(raw, max).replace(/\s+/g, " ").trim();
}

/**
 * 【本稿切入点】块。角度约束的是**全稿**不是开头，所以 thesis 要标死「必须论证」、
 * antiScope 要标死「禁区」——只丢一句 angle 进去等于什么都没约束（P1-16）。
 * coreEvidence 按 id 解出原文引用：论点旁边就摆着它的证据，写手不必回去翻简报块。
 */
export function buildAngleBlock(card: AngleCard, evidence: BriefEvidence[], tensions: string[] = []): string {
  if (isAngleCardV3(card)) return buildAngleBlockV3(card, tensions);
  const lines = [
    "【本稿切入点（已选定，全稿按它写）】",
    `切入点：${angleField(card.angle)}`,
    `核心论点：${angleField(card.thesis)}`,
    "　↑ 全稿必须论证它，不是复述材料——每一段都要服务于把这句话立住。",
  ];
  const cited = card.coreEvidenceIds
    .map((id) => evidenceByRef(evidence, id))
    .filter((e): e is BriefEvidence => e !== null);
  if (cited.length > 0) {
    lines.push("支撑证据（论点的地基，引用时保持原意）：");
    for (const e of cited) {
      lines.push(
        `- ${angleField(e.claim, ANGLE_CLAIM_MAX) || "（无主张）"}｜引文：「${angleField(e.quote, ANGLE_QUOTE_MAX)}」｜来源：${domainOf(e.sourceUrl)}`,
      );
    }
  }
  const tension = card.tensionId ? tensionByRef(tensions, card.tensionId) : null;
  if (tension) lines.push(`依托的张力点：${angleField(tension)}`);
  lines.push(`禁区（这一稿不写）：${angleField(card.antiScope)}`);
  lines.push("　↑ 写进去就是跑题，四平八稳面面俱到没有深度。");
  lines.push(`目标受众痛点：${angleField(cardAudiencePain(card))}`);
  lines.push(`预期停留触发：${angleField(cardHoldTrigger(card))}`);
  lines.push(`开头钩子草稿（手感参考，可以改写，不必照抄）：${angleField(card.hookDraft)}`);
  return lines.join("\n");
}

/**
 * 一稿只有一个主张，所以这些规矩不是「建议」而是硬约束——从 P0c 那 3/6 可发稿里反推出来的
 * （实验版 `experiments/p0-inputs-vs-structure/lib/angle-stage.ts` 的 `renderDirection`）。
 *
 * 与实验版的**一处故意不同**：实验版允许「找不到就标 `[未证实]`」。生产版删掉这个出口——
 * 数字硬门（§4.4）按账本逐个数字对账，`[未证实]` 拦不下也放不行，写进正文只会让写手
 * 以为自己有一条合法的退路，然后交上来一稿被硬门整篇打回。
 */
function angleHardRules(): string[] {
  return [
    "———— 这一稿的硬规矩 ————",
    "前 3 秒必须点出上面那个误区或反常识并提问，不要「今天聊聊」「最近很多人问」这类开场。",
    "全篇只讲这一个主张；讲第二个主张就是稀释，宁可这一个讲透。",
    "结尾给观众今天就能做的那一步（上面的「最小动作」），不要「欢迎讨论」。",
    "术语必须翻译：每个专业词第一次出现时用一句大白话解释，或者干脆不用。",
    "证据纪律：每个数字、每个「某公司/某研究/某人说」都必须来自材料里带 id 的证据" +
      "（简报与补证的 ev-、内部语料的 om-）或 find_evidence 查回来的引文；" +
      "找不到就删掉那个数字或改成定性说法——不要编，也不要写「未证实」蒙混过去，代码会逐个数字对账。",
    `第一手材料只用上面「第一手锚点」指定的那一处；其余创作者材料只供口吻参考，不得当案例讲。${OWN_MATERIAL_USAGE_RULE}。`,
    "自嘲只能嘲行为和判断，不能嘲身份、学历、出身、是否科班。",
    "**不写任何镜头、画面、字幕条、B-roll 标注**（[画面]、[字幕条]、[口播]、[切真人] 一类）：" +
      "画面是稿子定稿之后的事，这一稿只写能读出口的正文。",
  ];
}

/** 第一手锚点：卡上钉住的那一处亲历材料。quote 已由立意 pass 逐字校验过，这里只做注入消毒 */
function anchorLine(card: AngleCardV3): string {
  const anchor = card.firsthandAnchor;
  if (!anchor) {
    return "第一手锚点：无——这一稿没有可用的亲历材料，不要虚构「我当时」「我试过」这类经历。";
  }
  const where = anchor.chunkId ? `（片段 ${sanitizeExternal(anchor.chunkId, 80)}）` : "";
  return `第一手锚点${where}：「${angleField(anchor.quote, ANGLE_LONG_FIELD_MAX)}」——这是创作者本人说过的话，作为转折点用，可以改写口吻但不能改事实。`;
}

/**
 * 【本稿切入点】块 v3（spec §4.4）。与 v2 最大的不同：v2 只说「切入点 + 论点 + 禁区」，
 * v3 把「对谁说（主画像）→ 他信的错的东西（误区）→ 为什么会这样（机制）→ 所以主张什么
 * → 他今天做什么（最小动作）」串成一条链——P0c 的可发稿全在这条链上，被否的那些
 * 断在「机制」那一环（靠比喻撑）。
 *
 * 核心证据**不在这里**：它在 research 槽的优先级 1 块里（§4.3），逐字引文进 200 字的
 * 立意字段只会被截半。
 */
export function buildAngleBlockV3(card: AngleCardV3, tensions: string[] = []): string {
  const persona = DEFAULT_PERSONAS[card.primaryPersona];
  const lines = [
    "【本稿切入点（已选定，全稿按它写）】",
    `主画像（这一稿写给谁）：${persona.name}——${persona.who}。他走进来时的处境：${persona.state}。`,
    `他信的那个错的东西（误区）：${angleField(card.misconception)}`,
    `为什么会这样（机制，正文要把这条因果讲透，不是打比方）：${angleField(card.mechanism, ANGLE_LONG_FIELD_MAX)}`,
    `核心主张（全稿必须论证它，不是复述材料）：${angleField(card.thesis)}`,
    `切入点：${angleField(card.angle)}`,
    `他看完要做的最小动作：${angleField(card.nextAction)}`,
    "三画像收益（写的时候心里有这三个人，但只对主画像说话）：",
    ...PERSONA_KEYS.map(
      (k) => `- ${DEFAULT_PERSONAS[k].name}：${angleField(card.personaGains[k] ?? "")}`,
    ),
    `要命中的网感元素：${card.elements.map((e) => angleField(e, 20)).join("、")}`,
    `反方会说：${angleField(card.counterResponse)}——正文里要正面回应，不要绕开。`,
    anchorLine(card),
    `结构骨架：${STRUCTURE_MENU[card.structure]}。只用这一种骨架；措辞、节奏、案例展开你自己定。`,
    `收获感（正文必须兑现，用大白话）：${angleField(card.payoff, ANGLE_LONG_FIELD_MAX)}`,
    `禁区（这一稿不写）：${angleField(card.antiScope)}`,
    `开头钩子草稿（手感参考，可以改写，不必照抄）：${angleField(card.hookDraft)}`,
  ];
  const tension = card.tensionId ? tensionByRef(tensions, card.tensionId) : null;
  if (tension) lines.push(`依托的张力点：${angleField(tension)}`);
  if (card.evidenceLevel === "overview") {
    lines.push(
      "注意：这张卡是**综述级**（写它的时候还没有第一手证据）。正文里凡是没有材料撑住的判断，" +
        "要么用 find_evidence 找到证据，要么写成明确的个人判断，不要伪装成事实。",
    );
  }
  lines.push(...angleHardRules());
  return lines.join("\n");
}

/** 手写角度块：创始人自己写的一句话，不消毒、不解读——原样交给写手，它就是最高裁决 */
export function buildDirectionBlock(direction: string): string {
  return [
    "【本稿切入点（创作者手写，最高优先级）】",
    direction.trim(),
    "按这句话的角度写全稿；它与调研材料冲突时以它为准，材料只用来支撑它。",
  ].join("\n");
}

/** 三套角度来源的合并（§1.3）：手写 > 选中卡 > 无。三者皆无时返回空串，整块省略 */
function angleBlockFor(req: ScriptRequest, angle?: ResolvedAngle): string {
  if (req.direction?.trim()) return buildDirectionBlock(req.direction);
  return angle ? buildAngleBlock(angle.card, angle.evidence, angle.tensions) : "";
}

function buildUserPrompt(req: ScriptRequest, patterns: PatternCard[], angle?: ResolvedAngle): string {
  const parts: string[] = [];

  parts.push(`选题：${req.topic}`);
  parts.push("");

  // 角度在材料之前：先定「这一稿要论证什么」，再看「有哪些材料可用」
  const angleBlock = angleBlockFor(req, angle);
  if (angleBlock) {
    parts.push(angleBlock);
    parts.push("");
  }

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
