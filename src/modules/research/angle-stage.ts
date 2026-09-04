/**
 * 立意 pass（P1 spec §4.1）：**独立于调研综合**的一次 LLM 运行，产出角度卡 v3。
 *
 * 为什么独立成一 pass（P0 三轮实验的结论）：同一次运行里既做「材料综合」又做「立意」，
 * 立场会在综合阶段就被材料的调子定死——36 篇里 12 篇同选题稿全是「劝你别碰」，0 篇可发。
 * 把立意拆出来单跑（先误区、再主张、再收获），可发率 0/36 → 1/6 → 3/6。
 *
 * 三条纪律：
 * 1. **代码只校形状与引用**：机制是不是因果、payoff 是不是大白话、主张是不是比喻——
 *    这些是语义判断，交审稿的第三类判据（§4.5），立意 pass 只在提示词里要求（codex #20）。
 * 2. **引用不可伪造**：coreEvidenceIds 逐条回简报证据；firsthandAnchor 是结构化引用，
 *    `excerptHash` 由代码算、quote 必须在被引证据里逐字命中（codex #8）。
 * 3. **打分不选卡**：分数只用于展示与排序，永远不写 `selectedAngle`——选哪张是创始人的
 *    品味闸口，代码替他选就等于把这个闸口拆了（codex #7）。
 */
import crypto from "node:crypto";
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import type { EngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopResult, LoopTool } from "../../engine/loop.js";
import type { CreatorProfile } from "../profile/creator-profile.js";
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
import { PERSONA_KEYS, renderPersonas, type PersonaKey } from "./personas.js";
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
/** 每路视角进立意 prompt 的洞察条数上限——P0 的 full 档喂的是四视角全文，立意要看到同一份 */
const INSIGHTS_PER_PERSPECTIVE = 6;
const QUOTE_MAX = 300;

/** 身份自嘲词表：嘲行为可以，嘲身份会直接掉可信度（判据 9） */
const SELF_MOCK_IDENTITY = /科班|学历|出身|不是专业/;
/** 劝退词表：反向立场在 P0 里是被否稿的共同点，代码给它扣分（§4.1 打分） */
/**
 * 劝退词表。P0/P0b/P0c 创始人三次否掉的都是同一族：「先别拿它干正事」「别现在上生产」——
 * 带判断框架也否。词表只能挡住直说的，换个说法（「Star 衡量的是围观」）挡不住，
 * 所以这里只影响排序，真正的判断在创始人选卡与审稿。2026-09-05 e2e 又漏了「别现在上生产」，补进来。
 */
const DISCOURAGE = /劝退|劝你|别碰|别用|别拿|先别|不要碰|不要上|别现在|不能上生产|不可以上生产|唱衰/;

/** 结构骨架菜单：立意挑一种，不是模板；措辞与展开留给写手 */
export const STRUCTURE_MENU: Record<AngleStructure, string> = {
  "myth-busting": "反认知纠偏：先立受众信的那个错误说法 → 代价 → 用事实推翻 → 正确判断 → 最小动作",
  story: "亲历复盘：一段具体经历切入 → 当时的判断与转折 → 提炼一个可带走的结论",
  "single-point": "单点打穿：一个论断 → 为什么多数人想不到 → 一个完整案例展开 → 怎么用",
  "claim-case-claim": "观点+案例+观点：先给主张 → 一个第一手案例 → 案例改写后的主张（第二次必须更锋利，不是复述）",
};

// ─── 契约 ────────────────────────────────────────────────────────────────────

export interface RunAngleStageInput {
  /** 只用它的**事实字段**（摘要/张力/证据/缺口）；卡是本 pass 的产出，传进来的一律忽略 */
  brief: ResearchBrief;
  topic: ResearchTopicRef;
  profile: CreatorProfile | null;
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
  | { status: "succeeded"; cards: AngleCardV3[]; misconceptions: Record<PersonaKey, string[]>; tokensUsed: number }
  | { status: "failed"; errorCode: AngleStageErrorCode; reason: string };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── 引用校验（引用不可伪造） ────────────────────────────────────────────────

/** 片段指纹：被引正文的 sha256 前 16。模型算不出也改不动，改写卡时用它验「还是那段材料」 */
export function excerptHashOf(text: string): string {
  return crypto.createHash("sha256").update(text.replace(/\s+/g, " ").trim(), "utf-8").digest("hex").slice(0, 16);
}

/** 逐字命中：只压空白再比子串——中文引文里的空格差异不该算作篡改 */
function verbatimIn(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, "").trim();
  return needle.length > 0 && norm(haystack).includes(norm(needle));
}

/**
 * 锚点校验。**本刀只认 `brief_evidence`**：转写与审定稿要等内部语料（P1b §3.2）落地，
 * 现在放行等于让模型自由编一个 contentId——宁可明确拒绝，也不要一个校验不了的引用。
 */
function anchorEvidence(brief: ResearchBrief, anchor: FirsthandAnchor | undefined) {
  if (!anchor || anchor.kind !== "brief_evidence") return null;
  return evidenceByRef(brief.evidence, anchor.chunkId);
}

/** 锚点是否**当下仍然成立**：引用解得到 + 指纹对得上 + 引文逐字在原证据里 */
export function isAnchorValid(card: AngleCardV3, brief: ResearchBrief): boolean {
  const ev = anchorEvidence(brief, card.firsthandAnchor);
  if (!ev || !card.firsthandAnchor) return false;
  return (
    card.firsthandAnchor.excerptHash === excerptHashOf(ev.quote) && verbatimIn(ev.quote, card.firsthandAnchor.quote)
  );
}

// ─── 打分（代码侧，确定性；只用于展示与排序） ────────────────────────────────

export function scoreAngleCard(card: AngleCardV3, brief: ResearchBrief): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const elements = new Set(card.elements ?? []);
  let score = Math.min(elements.size, 3);
  reasons.push(`元素 ${elements.size}`);
  if (card.evidenceLevel === "grounded") {
    score += 1;
    reasons.push("有简报证据（grounded）");
  } else {
    reasons.push("综述级（overview）");
  }
  if (isAnchorValid(card, brief)) {
    score += 2;
    reasons.push("第一手锚点校验通过");
  } else {
    reasons.push("无可校验的第一手锚点");
  }
  if (card.primaryPersona === "grow") {
    score += 1;
    reasons.push("主画像=涨粉（账号当前目标）");
  }
  if (DISCOURAGE.test(`${card.thesis}${card.hookDraft}`)) {
    score -= 3;
    reasons.push("劝退型立场（P0 被否稿的共同点）");
  }
  return { score, reasons };
}

// ─── 校验（形状 + 引用；语义判断交审稿） ─────────────────────────────────────

function pushLen(value: string, max: number, label: string, tag: string, problems: string[]): void {
  if (!value) problems.push(`${tag}：缺 ${label}`);
  else if (Array.from(value).length > max) problems.push(`${tag}：${label} 超过 ${max} 字，压缩后重交`);
}

function readAnchorArg(
  raw: unknown,
  brief: ResearchBrief,
  tag: string,
  problems: string[],
): FirsthandAnchor | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const kind = str(item.kind) || "brief_evidence";
  if (kind !== "brief_evidence") {
    problems.push(`${tag}：本轮第一手锚点只能引简报证据（kind=brief_evidence）——转写与审定稿还没接进来`);
    return undefined;
  }
  const ref = str(item.chunk_id ?? item.chunkId ?? item.content_id ?? item.contentId);
  const quote = str(item.quote);
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

/** 单张卡的判据（产地与创始人改写共用；`tag` 决定报错口吻挂在哪张卡上） */
export function validateAngleCardV3(card: AngleCardV3, brief: ResearchBrief, tag: string, problems: string[]): void {
  pushLen(card.angle, TEXT_MAX, "angle", tag, problems);
  pushLen(card.thesis, TEXT_MAX, "thesis", tag, problems);
  pushLen(card.antiScope, TEXT_MAX, "antiScope", tag, problems);
  pushLen(card.hookDraft, TEXT_MAX, "hookDraft", tag, problems);
  pushLen(card.misconception, TEXT_MAX, "misconception（他信的那个错的东西）", tag, problems);
  pushLen(card.nextAction, TEXT_MAX, "nextAction（看完能做的一步）", tag, problems);
  pushLen(card.counterResponse, TEXT_MAX, "counterResponse（反方一句话）", tag, problems);
  pushLen(card.mechanism, LONG_TEXT_MAX, "mechanism（为什么会这样的因果）", tag, problems);
  pushLen(card.payoff, LONG_TEXT_MAX, "payoff（大白话 + 一个能做的方案）", tag, problems);
  if (!PERSONA_KEYS.includes(card.primaryPersona)) problems.push(`${tag}：primaryPersona 只能是 grow/trust/convert`);
  for (const k of PERSONA_KEYS) {
    if (!card.personaGains?.[k]?.trim()) problems.push(`${tag}：缺 ${k} 画像的收益——三个都答不上来的立意不能用`);
  }
  const elements = card.elements ?? [];
  if (elements.length < 2) problems.push(`${tag}：网感元素需 ≥2（当前 ${elements.length}）`);
  else if (elements.every((e) => e === "新奇点")) problems.push(`${tag}：不能全靠新奇点，再挑一个别的元素`);
  if (!ANGLE_STRUCTURES.includes(card.structure)) {
    problems.push(`${tag}：structure 只能是 ${ANGLE_STRUCTURES.join(" / ")}`);
  }
  if (SELF_MOCK_IDENTITY.test(`${card.hookDraft}${card.thesis}${card.payoff}`)) {
    problems.push(`${tag}：自嘲只能嘲行为和判断，不能嘲身份/学历/出身/是否科班`);
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
function readCard(item: Record<string, unknown>, index: number, brief: ResearchBrief, problems: string[]): AngleCardV3 {
  const tag = `候选 ${index + 1}`;
  const pick = (snake: string, camel: string): string => str(item[snake] ?? item[camel]);
  const gains = (item.persona_gains ?? item.personaGains) as Record<string, unknown> | undefined;
  const elements = strList(item.elements).filter((e): e is AngleElement =>
    (ANGLE_ELEMENTS as readonly string[]).includes(e),
  );
  const anchor = readAnchorArg(item.firsthand_anchor ?? item.firsthandAnchor, brief, tag, problems);
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

function readMisconceptions(raw: unknown, problems: string[]): Record<PersonaKey, string[]> {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { grow: [] as string[], trust: [] as string[], convert: [] as string[] };
  for (const k of PERSONA_KEYS) {
    out[k] = strList(src[k]);
    if (out[k].length === 0) problems.push(`misconceptions.${k} 至少写 1 条——先答「他信什么错的东西」`);
  }
  return out;
}

export function validateAngles(args: Record<string, unknown>, brief: ResearchBrief): Checked<AngleStagePayload> {
  const problems: string[] = [];
  const misconceptions = readMisconceptions(args.misconceptions, problems);
  const items = objList(args.candidates ?? args.cards).slice(0, CARD_MAX);
  if (items.length < CARD_MIN) problems.push(`候选需 ${CARD_MIN}-${CARD_MAX} 个，当前 ${items.length} 个`);
  const cards = items.map((item, i) => readCard(item, i, brief, problems));
  // 差异性沿用角度卡 spec 的字面粗筛（thesis+antiScope 的 bigram Jaccard）——一套口径，不另起
  if (problems.length === 0) checkDistinct(cards, problems);
  if (problems.length > 0) return { ok: false, problems };
  // 打分是**代码写的**：模型给的 score 一律不看，这里统一算一次
  for (const card of cards) {
    const { score, reasons } = scoreAngleCard(card, brief);
    card.score = score;
    card.scoreReasons = reasons;
  }
  return { ok: true, value: { cards, misconceptions } };
}

// ─── 提示词 ──────────────────────────────────────────────────────────────────

export function buildAngleSystemPrompt(profile: CreatorProfile | null): string {
  return [
    INJECTION_NOTICE,
    "",
    "你是这位创作者内容团队里的策划，本轮只负责短视频口播稿的**立意**，不写稿。",
    "立意 = 对某一个画像成立的、可被反驳的主张 + 他看完能做的一个动作。",
    "",
    "三个受众画像（账号的三项工作：涨粉 / 立信 / 变现）：",
    renderPersonas(profile),
    "",
    "判据：",
    "1. 误区先行：先答「这个画像走进来时信什么错的东西」。先陈述错误认知再反驳，观众才会留下来；讲得顺滑等于看完了可以走了。",
    "2. 三画像收益：主画像有明确动作，另外两个至少不反感、最好各得一点。三个都答不上来的立意不能用。",
    "3. 网感元素 ≥2：新奇点（认知违背）/ 爽点（看穿、走捷径）/ 痛点→理想状态 / 笑点（自我否定式坦白）/ 泪点（真实失败的细节）/ 美点（把混乱理顺）。不能全靠新奇点。",
    "4. 立场站得住：过反方一句话。劝退、唱衰这类反向立场只在给观众一个能拿走的判断框架时成立，否则是对同行说话。",
    "5. 热点走中层：事件本身是表层；观众的社会情绪（怕落后、怕被割、谁在定义下一代做事方式）是中层；立意落在中层。",
    "6. 机制：mechanism 用一句话说清**为什么会这样**的因果——「A 导致 B，因为 C」。比喻不是机制（「像投票箱」不算），复述材料也不算。",
    "7. 收获感：payoff 用大白话讲清「为什么会这样」+ 一个观众今天能做的方案或启发。小白听不懂的术语等于没讲。",
    "8. 证据级别：主张有简报证据撑着就写 evidenceLevel=grounded 并给 coreEvidenceIds（ev-N）；材料里确实没有就写 overview，并在 evidenceNeeds 里写够 2 条「去找什么」——不要为了凑 grounded 硬引一条不相干的证据。",
    "9. 第一手锚点：本轮只能引简报证据（kind=brief_evidence，chunk_id 写 ev-N，quote 从那条证据里**逐字**复制）。没有合适的就不要给锚点——引用会被代码逐字校验，编造必被打回。",
    "10. 自嘲只能嘲行为和判断（「我当时以为」「我走了弯路」），不能嘲身份和资历（学历、出身、是否科班）——那会降低创作者的可信度。",
    "",
    "结构是菜单不是模板，由立意挑一种；措辞、节奏、案例展开留给写手：",
    ...ANGLE_STRUCTURES.map((k) => `- ${k}：${STRUCTURE_MENU[k]}`),
    "",
    `先列三画像各 1-2 条误区，再给 ${CARD_MIN}-${CARD_MAX} 个候选立意，候选之间主画像或主张至少一维不同。`,
    "只通过 submit_angles 提交，不要在正文里写稿；候选由创始人挑，不要替他排序或推荐。",
  ].join("\n");
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
  return clampChars(externalBlock(lines), RESEARCH_BLOCK_MAX);
}

export function buildAngleUserMessage(input: RunAngleStageInput): string {
  return [
    "本次选题（来自我们自己的灵感库，可信）：",
    `标题：${clampChars(input.topic.title.trim(), 120) || "(无标题)"}`,
    `描述：${clampChars(input.topic.description.trim(), 600) || "(无描述)"}`,
    "",
    "调研简报的事实部分：",
    briefFacts(input.brief),
    "",
    "先想清楚三画像各自的误区，再给候选立意，最后调用 submit_angles 一次交齐。",
  ].join("\n");
}

// ─── 工具 schema ─────────────────────────────────────────────────────────────

/** 必填文本字段：`名 → 说明`（required 清单由它派生，别两处各写一遍） */
const CARD_TEXT_FIELDS: Record<string, string> = {
  angle: "切入点一句话",
  thesis: "可被反驳的主张，不是材料复述",
  misconception: "主画像走进来时信的那个错的东西",
  mechanism: "一句话说清为什么会这样的因果，不是比喻",
  payoff: "大白话讲清为什么 + 一个观众能做的方案/启发",
  next_action: "他看完今天就能做的一步",
  counter_response: "反方会说什么，怎么回应",
  hook_draft: "开头钩子草稿",
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
    primary_persona: { type: "string", enum: PERSONA_KEYS },
    evidence_level: { type: "string", enum: ["grounded", "overview"] },
    core_evidence_ids: { type: "array", items: { type: "string" }, description: "grounded 必填：ev-N" },
    tension_id: { type: "string", description: "依托的张力点 tension-N，可省" },
    persona_gains: {
      type: "object",
      required: PERSONA_KEYS,
      properties: Object.fromEntries(PERSONA_KEYS.map((k) => [k, { type: "string" }])),
    },
    elements: { type: "array", items: { type: "string", enum: [...ANGLE_ELEMENTS] }, minItems: 2 },
    firsthand_anchor: {
      type: "object",
      description: "第一手锚点（可省）",
      required: ["kind", "chunk_id", "quote"],
      properties: {
        kind: { type: "string", enum: ["brief_evidence"] },
        chunk_id: { type: "string", description: "被引简报证据的 ev-N" },
        quote: { type: "string", description: "从该条证据里逐字复制的片段" },
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
        PERSONA_KEYS.map((k) => [k, { type: "array", items: { type: "string" }, minItems: 1 }]),
      ),
    },
    candidates: { type: "array", minItems: CARD_MIN, maxItems: CARD_MAX, items: CARD_SCHEMA },
  },
};

const SUBMIT_TOOL_NAME = "submit_angles";

function buildSubmitTool(
  capture: SubmitCapture<AngleStagePayload>,
  brief: ResearchBrief,
  state: RunState,
): LoopTool {
  return {
    name: SUBMIT_TOOL_NAME,
    description: "提交三画像误区清单与候选立意。一次交齐；校验不过会返回错误清单，修正后整份重交。",
    parameters: SUBMIT_SCHEMA,
    execute(args) {
      // 超时后晚到的提交一律丢弃：那一轮的结果已经作废，收下等于让墙钟形同虚设
      if (state.abandoned) return "Error: 本轮立意已超时作废，不要再调用任何工具。";
      return captureSubmit(capture, validateAngles(args, brief), SUBMIT_TOOL_NAME);
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
    systemPrompt: buildAngleSystemPrompt(input.profile),
    userMessage: buildAngleUserMessage(input),
    tools: [buildSubmitTool(capture, input.brief, state)],
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
