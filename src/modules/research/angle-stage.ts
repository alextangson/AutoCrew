/**
 * 立意 pass（P1 spec §4.1）：**独立于调研综合**的一次 LLM 运行，产出角度卡 v3。
 *
 * 为什么独立成一 pass（P0 三轮实验的结论）：同一次运行里既做「材料综合」又做「立意」，
 * 立场会在综合阶段就被材料的调子定死——36 篇里 12 篇同选题稿全是「劝你别碰」，0 篇可发。
 * 把立意拆出来单跑能避免材料立场直接变成创作立场；具体策划方法应服从本次任务。
 *
 * 三条纪律：
 * 1. **代码只校形状与引用**：机制是不是因果、payoff 是不是大白话、主张是不是比喻——
 *    这些是语义判断，交审稿的第三类判据（§4.5），立意 pass 只在提示词里要求（codex #20）。
 * 2. **引用不可伪造**：coreEvidenceIds 逐条回简报证据；firsthandAnchor 是结构化引用，
 *    `excerptHash` 由代码算、quote 必须在被引材料（简报证据或内部语料片段）里逐字命中（codex #8）。
 * 3. **打分不选卡**：分数只用于展示与排序，永远不写 `selectedAngle`——选哪张是创始人的
 *    品味闸口，代码替他选就等于把这个闸口拆了（codex #7）。
 */
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import type { EngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopFallbackInfo, LoopResult, LoopTool } from "../../engine/loop.js";
import type { CreatorProfile } from "../profile/creator-profile.js";
import { renderCreativeTask, type CreativeTask } from "../writing/creative-task.js";
import { checkDistinct } from "./angle-cards.js";
import {
  ANGLE_ELEMENTS,
  ANGLE_STRUCTURES,
  evidenceByRef,
  evidenceRefId,
  tensionByRef,
  type AngleCardV3,
  type AngleElement,
  type AngleStructure,
  type FirsthandAnchor,
  type ResearchBrief,
} from "./brief-store.js";
import {
  OWN_MATERIAL_USAGE_RULE,
  excerptHashOf,
  ownChunkById,
  renderOwnMaterial,
  type OwnMaterial,
} from "./own-material.js";
import { PERSONA_KEYS, renderPersonas, type PersonaKey } from "./personas.js";
import { quoteCorpus } from "./research-broker.js";
import type { ResearchTopicRef } from "./research-perspectives.js";
import type { RunState } from "./research-tools.js";
import {
  INJECTION_NOTICE,
  captureSubmit,
  clampChars,
  externalBlock,
  newCapture,
  objList,
  sanitizeExternal,
  str,
  stripDelimiters,
  strList,
  type Checked,
  type SubmitCapture,
} from "./research-prompt-kit.js";

// ─── 预算（同视角子运行的三层合围） ─────────────────────────────────────────

const MAX_TURNS = 5;
const MAX_TOTAL_TOKENS = 60_000;
/** 墙钟：到点丢结果（runLoop 不可中断）。与视角同口径 8 分钟：DeepSeek V4 Pro 吃 9k 字材料出 4 张卡实测 4 分钟不够（2026-09-05 预览超时） */
export const DEFAULT_ANGLE_DEADLINE_MS = 480_000;

const CARD_MIN = 3;
const CARD_MAX = 4;
const TEXT_MAX = 200;
/** 机制与收获感要讲清因果，给到 400 字；其余字段一律 200 */
const LONG_TEXT_MAX = 400;
const EVIDENCE_NEEDS_MAX = 3;
const OVERVIEW_NEEDS_MIN = 2;
const RESEARCH_BLOCK_MAX = 9000;
/** 内部语料块在立意提示词里的预算：装不下的整段丢掉（renderOwnMaterial 保证块始终完整） */
const OWN_MATERIAL_MAX = 9000;
/** 每路视角进立意 prompt 的洞察条数上限——P0 的 full 档喂的是四视角全文，立意要看到同一份 */
const INSIGHTS_PER_PERSPECTIVE = 6;
/** 无来源推断进立意 prompt 的条数上限（与产地 §3.6 同口径 6 条） */
const INFERENCES_PER_PERSPECTIVE = 6;
const QUOTE_MAX = 300;

/** 结构骨架菜单：方法服务本次规划，字段枚举保留以兼容存量卡片。 */
export const STRUCTURE_MENU: Record<AngleStructure, string> = {
  "myth-busting": "纠偏：仅在用户需要且确有受众误区时，用证据解释问题与判断；不强制反问或先制造错误认知",
  story: "自然叙事：具体场景或经历 → 按真实进展展开 → 自然落到理解与感受；不编造亲历、转折或行动口号",
  "single-point": "解释或实用建议：围绕一个明确问题讲清来龙去脉，或给出适用步骤与边界；不强求多数人想不到",
  "claim-case-claim": "观点与案例：先说明判断 → 用适切案例检验 → 给出有证据的结论与边界；结论不必更激烈",
};

// ─── 契约 ────────────────────────────────────────────────────────────────────

export interface RunAngleStageInput {
  /** 只用它的**事实字段**（摘要/张力/证据/缺口）；卡是本 pass 的产出，传进来的一律忽略 */
  brief: ResearchBrief;
  topic: ResearchTopicRef;
  /** 创作者自己的材料（P1b §3.2）：第一手锚点的另一半来源；缺省 = 这轮只有简报证据可引 */
  ownMaterial?: OwnMaterial;
  profile: CreatorProfile | null;
  /** 本次要求高于账号默认规划，贯穿调研与立意。 */
  creativeTask?: CreativeTask;
  engineConfig?: EngineConfig;
  dataDir?: string;
  runLoopImpl?: typeof runLoop;
  deadlineMs?: number;
}

export type AngleStageErrorCode = "deadline" | "no_submit" | "invalid_output" | "engine_failed";

export interface AngleStagePayload {
  cards: AngleCardV3[];
  misconceptions: Record<PersonaKey, string[]>;
}

export type AngleStageResult =
  | {
      status: "succeeded";
      cards: AngleCardV3[];
      misconceptions: Record<PersonaKey, string[]>;
      tokensUsed: number;
      /** 这轮立意是备用端点顶完的（P2 spec §4.3）：落进 ResearchJob.usedFallback */
      usedFallback?: LoopFallbackInfo;
    }
  | { status: "failed"; errorCode: AngleStageErrorCode; reason: string };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── 引用校验（引用不可伪造） ────────────────────────────────────────────────

export { excerptHashOf };

/**
 * 逐字命中：先按**模型实际看到的形态**归一（broker 的 quoteCorpus：消毒 + 折空白），
 * 再把空白全去掉比子串——中文引文里的空格差异不该算作篡改（broker 冒烟实证同款理由）。
 */
function verbatimIn(haystack: string, needle: string): boolean {
  const norm = (s: string) => quoteCorpus(s).replace(/\s+/g, "");
  return needle.trim().length > 0 && norm(haystack).includes(norm(needle));
}

/**
 * 锚点是否**当下仍然成立**：引用解得到 + 指纹对得上 + 引文逐字在被引正文里。
 *
 * 内部语料的两类（transcript / approved_draft）要拿着当轮扫到的 `ownMaterial` 才验得了。
 * **没传语料时只校形状**：产地那一步已经逐字校验过、`excerptHash` 又是创始人改写里的
 * 禁改字段，若在这里一律判否，一张带第一手锚点的卡会连改都改不了（改写路径没有语料入口）。
 */
export function isAnchorValid(card: AngleCardV3, brief: ResearchBrief, ownMaterial?: OwnMaterial): boolean {
  const anchor = card.firsthandAnchor;
  if (!anchor) return false;
  if (anchor.kind === "brief_evidence") {
    const ev = evidenceByRef(brief.evidence, anchor.chunkId);
    return !!ev && anchor.excerptHash === excerptHashOf(ev.quote) && verbatimIn(ev.quote, anchor.quote);
  }
  const chunk = ownChunkById(ownMaterial, anchor.chunkId);
  if (!chunk) return ownMaterial ? false : Boolean(anchor.chunkId && anchor.excerptHash && anchor.quote);
  return anchor.excerptHash === chunk.excerptHash && verbatimIn(chunk.text, anchor.quote);
}

// ─── 打分（代码侧，确定性；只用于展示与排序） ────────────────────────────────

export function scoreAngleCard(
  card: AngleCardV3,
  brief: ResearchBrief,
  ownMaterial?: OwnMaterial,
): { score: number; reasons: string[] } {
  const reasons: string[] = ["证据支撑分，不代表传播潜力或爆款概率"];
  const refs = [...new Set(card.coreEvidenceIds)];
  const completeReferences = refs.length > 0 && refs.every(ref => {
    const evidence = evidenceByRef(brief.evidence, ref);
    return Boolean(evidence?.claim.trim() && evidence.quote.trim() && evidence.sourceUrl.trim());
  });
  let score = 0;
  if (card.evidenceLevel === "grounded" && completeReferences) {
    score += 1;
    reasons.push("有可追溯的简报证据（grounded）");
  } else {
    reasons.push("证据尚不足，不能据此判断主张成立");
  }
  if (isAnchorValid(card, brief, ownMaterial)) {
    score += 2;
    reasons.push("引文锚点校验通过");
  } else {
    reasons.push("无可校验的引文锚点");
  }

  return { score, reasons };
}

// ─── 校验（形状 + 引用；语义判断交审稿） ─────────────────────────────────────

function pushLen(value: string, max: number, label: string, tag: string, problems: string[]): void {
  if (!value) problems.push(`${tag}：缺 ${label}`);
  else if (Array.from(value).length > max) problems.push(`${tag}：${label} 超过 ${max} 字，压缩后重交`);
}

const ANCHOR_KINDS = ["transcript", "approved_draft", "brief_evidence"] as const;

function readAnchorArg(
  raw: unknown,
  brief: ResearchBrief,
  ownMaterial: OwnMaterial | undefined,
  tag: string,
  problems: string[],
): FirsthandAnchor | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const kind = str(item.kind) || "brief_evidence";
  const ref = str(item.chunk_id ?? item.chunkId ?? item.content_id ?? item.contentId);
  const quote = str(item.quote);
  if (kind === "brief_evidence") {
    const ev = evidenceByRef(brief.evidence, ref);
    if (!ev) {
      problems.push(`${tag}：第一手锚点引用「${ref || "(空)"}」不存在——只能引本份简报的 ev-N，或者不给锚点`);
      return undefined;
    }
    if (!verbatimIn(ev.quote, quote)) {
      problems.push(`${tag}：第一手锚点的 quote 必须是 ${ref} 那条证据里的**逐字**片段，不能转述`);
      return undefined;
    }
    return { kind: "brief_evidence", chunkId: ref, excerptHash: excerptHashOf(ev.quote), quote };
  }
  if (kind !== "transcript" && kind !== "approved_draft") {
    problems.push(`${tag}：firsthandAnchor.kind 只能是 ${ANCHOR_KINDS.join(" / ")}`);
    return undefined;
  }
  // 内部语料的引用只能落在**本轮实际喂进去的**片段上：编一个 om:… 就等于凭空声明第一手材料
  const chunk = ownChunkById(ownMaterial, ref);
  if (!chunk) {
    problems.push(
      `${tag}：第一手锚点引用「${ref || "(空)"}」不存在——只能引上面「我自己的材料」块里给出的片段 id（om: 开头），或者不给锚点`,
    );
    return undefined;
  }
  if (chunk.kind !== kind) {
    problems.push(`${tag}：片段 ${ref} 的 kind 是 ${chunk.kind}，不是 ${kind}`);
    return undefined;
  }
  if (!verbatimIn(chunk.text, quote)) {
    problems.push(`${tag}：第一手锚点的 quote 必须是片段 ${ref} 正文里的**逐字**片段，不能转述或改写`);
    return undefined;
  }
  return {
    kind: chunk.kind,
    contentId: chunk.contentId,
    sourceRevision: chunk.sourceRevision,
    chunkId: chunk.id,
    excerptHash: chunk.excerptHash,
    quote,
  };
}

/** 单张卡的判据（产地与创始人改写共用；`tag` 决定报错口吻挂在哪张卡上） */
export function validateAngleCardV3(card: AngleCardV3, brief: ResearchBrief, tag: string, problems: string[]): void {
  pushLen(card.angle, TEXT_MAX, "angle", tag, problems);
  pushLen(card.thesis, TEXT_MAX, "thesis", tag, problems);
  pushLen(card.antiScope, TEXT_MAX, "antiScope", tag, problems);
  pushLen(card.hookDraft, TEXT_MAX, "hookDraft", tag, problems);
  if (card.structure === "myth-busting" || card.misconception) {
    pushLen(card.misconception, TEXT_MAX, "misconception（纠偏时需要的受众误区）", tag, problems);
  }
  pushLen(card.nextAction, TEXT_MAX, "nextAction（读后理解、判断或可选行动）", tag, problems);
  pushLen(card.counterResponse, TEXT_MAX, "counterResponse（合理异议或适用边界）", tag, problems);
  pushLen(card.mechanism, LONG_TEXT_MAX, "mechanism（判断依据或事件发展）", tag, problems);
  pushLen(card.payoff, LONG_TEXT_MAX, "payoff（读者获得的理解、感受或实际帮助）", tag, problems);
  if (!PERSONA_KEYS.includes(card.primaryPersona)) problems.push(`${tag}：primaryPersona 只能是 grow/trust/convert`);
  if (PERSONA_KEYS.includes(card.primaryPersona) && !card.personaGains?.[card.primaryPersona]?.trim()) {
    problems.push(`${tag}：缺主目标 ${card.primaryPersona} 的收益——说明这篇内容对读者有什么用`);
  }
  if (!ANGLE_STRUCTURES.includes(card.structure)) {
    problems.push(`${tag}：structure 只能是 ${ANGLE_STRUCTURES.join(" / ")}`);
  }
  validateEvidenceLevel(card, brief, tag, problems);
}

function validateEvidenceLevel(card: AngleCardV3, brief: ResearchBrief, tag: string, problems: string[]): void {
  const refs = card.coreEvidenceIds ?? [];
  const bad = refs.filter((id) => !evidenceByRef(brief.evidence, id));
  const known = brief.evidence.length
    ? `本份简报只有 ${brief.evidence.length} 条证据（${evidenceRefId(0)}…${evidenceRefId(brief.evidence.length - 1)}）`
    : "本份简报一条证据都没有";
  if (bad.length > 0) problems.push(`${tag}：coreEvidenceIds 指向不存在的证据 ${bad.join("、")}——${known}`);
  if (card.evidenceLevel === "grounded") {
    if (refs.length === 0) {
      problems.push(`${tag}：grounded 至少引 1 条简报证据；引不到就把 evidenceLevel 改成 overview（${known}）`);
    }
  } else if (card.evidenceLevel === "overview") {
    if ((card.evidenceNeeds ?? []).length < OVERVIEW_NEEDS_MIN) {
      problems.push(`${tag}：overview 卡必须写 ≥${OVERVIEW_NEEDS_MIN} 条 evidenceNeeds——没证据就得说清去找什么`);
    }
  } else {
    problems.push(`${tag}：evidenceLevel 只能是 grounded 或 overview`);
  }
  const needs = card.evidenceNeeds ?? [];
  if (needs.length < 1) problems.push(`${tag}：缺 evidenceNeeds（1-${EVIDENCE_NEEDS_MAX} 条，写清还缺什么证据）`);
  if (needs.length > EVIDENCE_NEEDS_MAX) problems.push(`${tag}：evidenceNeeds 最多 ${EVIDENCE_NEEDS_MAX} 条`);
  if (card.tensionId && !tensionByRef(brief.tensions, card.tensionId)) {
    problems.push(`${tag}：tensionId「${card.tensionId}」不存在——张力点为空就别给这个字段`);
  }
}

/** tool args → 落盘形状。id 由代码按位置编（angle-1…），模型说了不算 */
function readCard(
  item: Record<string, unknown>,
  index: number,
  brief: ResearchBrief,
  ownMaterial: OwnMaterial | undefined,
  problems: string[],
): AngleCardV3 {
  const tag = `候选 ${index + 1}`;
  const pick = (snake: string, camel: string): string => str(item[snake] ?? item[camel]);
  const gains = (item.persona_gains ?? item.personaGains) as Record<string, unknown> | undefined;
  const elements = strList(item.elements).filter((e): e is AngleElement =>
    (ANGLE_ELEMENTS as readonly string[]).includes(e),
  );
  const anchor = readAnchorArg(item.firsthand_anchor ?? item.firsthandAnchor, brief, ownMaterial, tag, problems);
  const card: AngleCardV3 = {
    cardVersion: 3,
    id: `angle-${index + 1}`,
    angle: pick("angle", "angle"),
    thesis: pick("thesis", "thesis"),
    evidenceLevel: str(item.evidence_level ?? item.evidenceLevel) === "overview" ? "overview" : "grounded",
    coreEvidenceIds: strList(item.core_evidence_ids ?? item.coreEvidenceIds),
    ...(pick("tension_id", "tensionId") ? { tensionId: pick("tension_id", "tensionId") } : {}),
    antiScope: pick("anti_scope", "antiScope"),
    hookDraft: pick("hook_draft", "hookDraft"),
    primaryPersona: str(item.primary_persona ?? item.primaryPersona) as PersonaKey,
    misconception: pick("misconception", "misconception"),
    mechanism: pick("mechanism", "mechanism"),
    payoff: pick("payoff", "payoff"),
    nextAction: pick("next_action", "nextAction"),
    counterResponse: pick("counter_response", "counterResponse"),
    personaGains: {
      grow: str(gains?.grow),
      trust: str(gains?.trust),
      convert: str(gains?.convert),
    },
    elements,
    ...(anchor ? { firsthandAnchor: anchor } : {}),
    evidenceNeeds: strList(item.evidence_needs ?? item.evidenceNeeds),
    structure: str(item.structure) as AngleStructure,
  };
  validateAngleCardV3(card, brief, tag, problems);
  return card;
}

function readMisconceptions(raw: unknown): Record<PersonaKey, string[]> {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { grow: [] as string[], trust: [] as string[], convert: [] as string[] };
  for (const k of PERSONA_KEYS) {
    out[k] = strList(src[k]);
  }
  return out;
}

export function validateAngles(
  args: Record<string, unknown>,
  brief: ResearchBrief,
  ownMaterial?: OwnMaterial,
): Checked<AngleStagePayload> {
  const problems: string[] = [];
  const misconceptions = readMisconceptions(args.misconceptions);
  const items = objList(args.candidates ?? args.cards).slice(0, CARD_MAX);
  if (items.length < CARD_MIN) problems.push(`候选需 ${CARD_MIN}-${CARD_MAX} 个，当前 ${items.length} 个`);
  const cards = items.map((item, i) => readCard(item, i, brief, ownMaterial, problems));
  // 差异性沿用角度卡 spec 的字面粗筛（thesis+antiScope 的 bigram Jaccard）——一套口径，不另起
  if (problems.length === 0) checkDistinct(cards, problems);
  if (problems.length > 0) return { ok: false, problems };
  // 打分是**代码写的**：模型给的 score 一律不看，这里统一算一次
  for (const card of cards) {
    const { score, reasons } = scoreAngleCard(card, brief, ownMaterial);
    card.score = score;
    card.scoreReasons = reasons;
  }
  return { ok: true, value: { cards, misconceptions } };
}

// ─── 提示词 ──────────────────────────────────────────────────────────────────

export function buildAngleSystemPrompt(profile: CreatorProfile | null, creativeTask?: CreativeTask): string {
  return [
    INJECTION_NOTICE,
    "",
    "你是这位创作者内容团队里的策划，本轮负责立意，不写稿。平台、体裁、目的和表达方式由本次创作任务决定，不默认短视频口播。",
    "立意 = 对明确读者有价值的核心判断、问题解释或叙事发现；不必是反常识论断，不必引导关注或成交。",
    "",
    renderCreativeTask(creativeTask),
    "受众和目标：",
    renderPersonas(profile),
    "",
    "策划规则：",
    "1. 本次用户方向、受众、平台、提纲、必写与禁区是共同约束。候选只能在这个范围内展开；用户方向已明确时，提供该方向内的叙事入口或论证路径，不另换主张。",
    "2. 区分媒介与目的：公众号按阅读逻辑和内容深度策划；口播考虑听懂和口语节奏；自然叙事保留具体场景、过程和真实感；实用说明优先讲清步骤和适用边界。没有指定平台或体裁就明确未设，不替用户决定。",
    "3. 方法按需：有真实误区且纠偏符合要求才用 myth-busting；叙事、解释、经验分享不强造误区、冲突或反转。情绪和网感元素可用也可不用，elements 可以为空，不凑数量。",
    "4. primaryPersona 保留 grow/trust/convert 目标标签，仅选本次最相关的一项；personaGains 只需说明该目标下的读者收益，其余留空，不编造三种人群或同时满足三种目的。",
    "5. mechanism 说明主张依据、事情如何发展或建议为何有效；材料不足以支持因果时标明未知，不把相关性写成因果。payoff 写读者能获得的理解、感受或实际帮助；nextAction 可以是读后的理解与判断，不必是行动号召。",
    "6. counterResponse 说明合理异议或适用边界；没有可支持的反方就说明尚无材料，不制造稻草人。misconception 仅在适合纠偏时填写，其余为空；misconceptions 的三个数组都允许为空。",
    "7. 证据级别：主张有简报证据撑着就写 evidenceLevel=grounded 并给 coreEvidenceIds（ev-N）；材料里确实没有就写 overview，并在 evidenceNeeds 里写够 2 条「去找什么」——不要为了凑 grounded 硬引一条不相干的证据。",
    "8. 第一手锚点：优先引创作者自己的材料（kind=transcript / approved_draft，chunk_id 写材料块里的 om:… 片段 id）；没有合适的就引简报证据（kind=brief_evidence，chunk_id 写 ev-N）。quote 一律从被引正文里逐字复制，引用会被代码逐字校验；实在没有合适的就不要给锚点。",
    `9. 自己的材料怎么用：${OWN_MATERIAL_USAGE_RULE}——锚点必须直接支撑这张卡的主张，挂不上就别挂。不要编造亲历、身份、数字或受众焦虑。`,
    "10. 证据充分与传播潜力分别判断：可追溯证据不证明读者一定感兴趣。可能吸引人的原因只能作为待验证假设；不承诺爆款、不编造播放量或成功概率。",
    "",
    "结构是菜单不是模板，服从本次用户规划；措辞、节奏、案例展开留给写手：",
    ...ANGLE_STRUCTURES.map((k) => `- ${k}：${STRUCTURE_MENU[k]}`),
    "",
    `给 ${CARD_MIN}-${CARD_MAX} 个有实质差异的候选立意或展开路径；用户明确的核心主张保持一致，不为差异而偏离任务。`,
    "只通过 submit_angles 提交，不要在正文里写稿。系统会单独说明证据推荐依据，最终选择仍由用户决定。",
  ].filter(Boolean).join("\n");
}

/** 简报事实块：引文只掐定界符**不改写**——锚点要逐字回引它，消毒会让原文对不上 */
function briefFacts(brief: ResearchBrief): string {
  const lines = [`简报摘要：${sanitizeExternal(brief.summary, 400)}`];
  brief.tensions.forEach((t, i) => lines.push(`张力点 tension-${i + 1}：${sanitizeExternal(t, 200)}`));
  if (brief.evidence.length > 0) lines.push("证据（引用时写 ev-N）：");
  brief.evidence.forEach((e, i) => {
    const domain = /^https?:\/\/([^/?#]+)/i.exec(e.sourceUrl)?.[1] ?? "未知来源";
    lines.push(
      `- ${evidenceRefId(i)}｜${sanitizeExternal(e.claim, TEXT_MAX)}｜引文：「${clampChars(stripDelimiters(e.quote), QUOTE_MAX)}」｜来源：${domain}`,
    );
  });
  if (brief.evidence.length === 0) lines.push("（本份简报没有可引用的证据——只能出 overview 卡）");
  for (const gap of brief.gaps.slice(0, 8)) lines.push(`材料缺口：${sanitizeExternal(gap, TEXT_MAX)}`);
  // 四视角洞察：P0 实验里立意吃的是视角全文而不只是摘要——受众/反方视角的洞察正是误区与反方一句话的来源
  for (const p of brief.perspectives) {
    if (p.insights.length === 0) continue;
    lines.push(`视角「${p.name}」洞察：`);
    for (const ins of p.insights.slice(0, INSIGHTS_PER_PERSPECTIVE)) lines.push(`- ${sanitizeExternal(ins.text, TEXT_MAX)}`);
  }
  // 受众推断正是**误区**的原料（P1c §3.6）：误区本来就说不出出处，它靠的是对受众的判断。
  // 标签写死「不可作证据」——它能进 misconception，绝不能进 coreEvidenceIds 或锚点。
  for (const p of brief.perspectives) {
    const inferences = p.inferences ?? [];
    if (inferences.length === 0) continue;
    lines.push(`视角「${p.name}」受众推断（无来源，不可作证据）：`);
    for (const inf of inferences.slice(0, INFERENCES_PER_PERSPECTIVE)) {
      lines.push(`- ${sanitizeExternal(inf.text, TEXT_MAX)}${inf.persona ? `（画像 ${inf.persona}）` : ""}`);
    }
  }
  return clampChars(externalBlock(lines), RESEARCH_BLOCK_MAX);
}

export function buildAngleUserMessage(input: RunAngleStageInput): string {
  const own = renderOwnMaterial(input.ownMaterial?.chunks ?? [], OWN_MATERIAL_MAX);
  return [
    "本次选题（来自我们自己的灵感库，可信）：",
    `标题：${clampChars(input.topic.title.trim(), 120) || "(无标题)"}`,
    `描述：${clampChars(input.topic.description.trim(), 600) || "(无描述)"}`,
    "",
    renderCreativeTask(input.creativeTask),
    "调研简报的事实部分：",
    briefFacts(input.brief),
    ...(own ? ["", "我自己的材料（第一手，锚点优先引这里）：", own] : []),
    "",
    "依据共同任务书的受众、目的和明确方向提出候选；只在适用时写误区，最后调用 submit_angles 一次交齐。",
  ].join("\n");
}

// ─── 工具 schema ─────────────────────────────────────────────────────────────

/** 必填文本字段：`名 → 说明`（required 清单由它派生，别两处各写一遍） */
const CARD_TEXT_FIELDS: Record<string, string> = {
  angle: "切入点一句话",
  thesis: "符合用户方向的核心判断、问题解释或叙事发现，不是材料复述",
  misconception: "真实受众误区；非纠偏结构可留空，不编造错误认知",
  mechanism: "说明判断依据、事件发展或建议为何有效；因果未证实时明确不确定性",
  payoff: "读者获得的理解、感受、判断或实际帮助",
  next_action: "读后的理解、判断或可选行动，不要求关注/成交口号",
  counter_response: "合理异议或适用边界；没有材料支持时说明未知，不制造稻草人",
  hook_draft: "适合本次平台与表达方式的开头草稿，不强制钩子套路",
  anti_scope: "这一稿明确不写什么",
};

const CARD_SCHEMA = {
  type: "object",
  required: [
    ...Object.keys(CARD_TEXT_FIELDS),
    "primary_persona",
    "evidence_level",
    "persona_gains",
    "elements",
    "evidence_needs",
    "structure",
  ],
  properties: {
    ...Object.fromEntries(Object.entries(CARD_TEXT_FIELDS).map(([k, d]) => [k, { type: "string", description: d }])),
    primary_persona: { type: "string", enum: PERSONA_KEYS, description: "本次内容的主目标标签，不是预设人群" },
    evidence_level: { type: "string", enum: ["grounded", "overview"] },
    core_evidence_ids: { type: "array", items: { type: "string" }, description: "grounded 必填：ev-N" },
    tension_id: { type: "string", description: "依托的张力点 tension-N，可省" },
    persona_gains: {
      type: "object",
      required: PERSONA_KEYS,
      description: "主目标对应收益必填，其余可以是空字符串",
      properties: Object.fromEntries(PERSONA_KEYS.map((k) => [k, { type: "string" }])),
    },
    elements: { type: "array", items: { type: "string", enum: [...ANGLE_ELEMENTS] }, description: "实际适用的表达元素，可为空，不凑数量" },
    firsthand_anchor: {
      type: "object",
      description: "第一手锚点（可省）：创作者自己的材料优先",
      required: ["kind", "chunk_id", "quote"],
      properties: {
        kind: { type: "string", enum: [...ANCHOR_KINDS] },
        chunk_id: {
          type: "string",
          description: "内部语料写材料块里的片段 id（om:…），简报证据写 ev-N",
        },
        quote: { type: "string", description: "从被引正文里逐字复制的片段" },
      },
    },
    evidence_needs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: EVIDENCE_NEEDS_MAX },
    structure: { type: "string", enum: [...ANGLE_STRUCTURES] },
  },
};

const SUBMIT_SCHEMA = {
  type: "object",
  required: ["misconceptions", "candidates"],
  properties: {
    misconceptions: {
      type: "object",
      required: PERSONA_KEYS,
      properties: Object.fromEntries(
        PERSONA_KEYS.map((k) => [k, { type: "array", items: { type: "string" }, description: "适用于本次内容的真实误区，无则空数组" }]),
      ),
    },
    candidates: { type: "array", minItems: CARD_MIN, maxItems: CARD_MAX, items: CARD_SCHEMA },
  },
};

const SUBMIT_TOOL_NAME = "submit_angles";

function buildSubmitTool(
  capture: SubmitCapture<AngleStagePayload>,
  brief: ResearchBrief,
  ownMaterial: OwnMaterial | undefined,
  state: RunState,
): LoopTool {
  return {
    name: SUBMIT_TOOL_NAME,
    description: "提交符合本次任务的候选立意；误区只在适用时填写。一次交齐；校验不过会返回错误清单，修正后整份重交。",
    parameters: SUBMIT_SCHEMA,
    execute(args) {
      // 超时后晚到的提交一律丢弃：那一轮的结果已经作废，收下等于让墙钟形同虚设
      if (state.abandoned) return "Error: 本轮立意已超时作废，不要再调用任何工具。";
      return captureSubmit(capture, validateAngles(args, brief, ownMaterial), SUBMIT_TOOL_NAME);
    },
  };
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

const DEADLINE = Symbol("deadline");
type LoopOutcome = { ok: true; result: LoopResult } | { ok: false; error: unknown };

/** 墙钟竞速（同 runPerspective）：runLoop 不可中断，到点只能标记作废并丢弃结果 */
async function raceDeadline(
  work: Promise<LoopOutcome>,
  ms: number,
  state: RunState,
): Promise<LoopOutcome | typeof DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => {
      state.abandoned = true;
      resolve(DEADLINE);
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function settle(capture: SubmitCapture<AngleStagePayload>, result: LoopResult): AngleStageResult {
  if (capture.payload) {
    return {
      status: "succeeded",
      cards: capture.payload.cards,
      misconceptions: capture.payload.misconceptions,
      tokensUsed: result.totalTokens,
      ...(result.usedFallback ? { usedFallback: result.usedFallback } : {}),
    };
  }
  if (capture.attempts === 0) {
    return {
      status: "failed",
      errorCode: "no_submit",
      reason: `模型没有调用 ${SUBMIT_TOOL_NAME}（loop ${result.stopReason}，turns=${result.turns}）`,
    };
  }
  return { status: "failed", errorCode: "invalid_output", reason: capture.problems.join("；") };
}

/**
 * 跑一次立意 pass。**不抛**——立意失败只让这份简报没有卡（写稿走无卡路径），
 * 不该把整条调研 job 带走（§5 边界行为）。
 */
export async function runAngleStage(input: RunAngleStageInput): Promise<AngleStageResult> {
  let config: EngineConfig;
  try {
    config = input.engineConfig ?? (await loadEngineConfig(input.dataDir));
  } catch (err) {
    return { status: "failed", errorCode: "engine_failed", reason: `引擎未配置：${errText(err)}` };
  }
  const scout = resolveEngineRoute(config, "scout", config.strongModel);
  const state: RunState = { abandoned: false };
  const capture = newCapture<AngleStagePayload>();
  const deadlineMs = input.deadlineMs ?? DEFAULT_ANGLE_DEADLINE_MS;

  const work: Promise<LoopOutcome> = (input.runLoopImpl ?? runLoop)(scout.config, {
    model: scout.model,
    systemPrompt: buildAngleSystemPrompt(input.profile, input.creativeTask),
    userMessage: buildAngleUserMessage(input),
    tools: [buildSubmitTool(capture, input.brief, input.ownMaterial, state)],
    maxTurns: MAX_TURNS,
    maxTotalTokens: MAX_TOTAL_TOKENS,
    logMeta: { agent: "angle" },
  }).then(
    (result) => ({ ok: true as const, result }),
    (error) => ({ ok: false as const, error }),
  );

  const raced = await raceDeadline(work, deadlineMs, state);
  if (raced === DEADLINE) {
    return {
      status: "failed",
      errorCode: "deadline",
      reason: `立意超时（${Math.round(deadlineMs / 1000)} 秒），本轮结果作废`,
    };
  }
  if (!raced.ok) {
    return { status: "failed", errorCode: "engine_failed", reason: `引擎调用失败：${errText(raced.error)}` };
  }
  return settle(capture, raced.result);
}
