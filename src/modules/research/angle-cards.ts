/**
 * 角度卡的规则本（角度卡 spec §1.2/§1.3）——形状定义在 brief-store（它是简报 schema 的
 * 一部分），**关于它的判断**全都住在这里：产地校验、改写校验、选择是否还作数。
 *
 * 为什么单独一个文件：这些规矩有五个消费方（综合产地、写稿注入、聊天闸口、选卡通道、
 * 回收豁免），抄五遍就会在某次改动里分叉，然后出现「工作台说过期、聊天照旧注入」
 * 这种两套事实。
 *
 * 全是纯函数、不读盘：简报与选题由调用方各自取好再传进来。
 */
import type { SelectedAngle } from "../../storage/local-store.js";
import { isAnchorValid, scoreAngleCard, validateAngleCardV3 } from "./angle-stage.js";
import {
  ANGLE_ELEMENTS,
  evidenceByRef,
  evidenceRefId,
  isAngleCardV3,
  tensionByRef,
  type AngleCard,
  type AngleCardV2,
  type AngleCardV3,
  type AngleElement,
  type AngleStructure,
  type BriefEvidence,
  type FirsthandAnchor,
  type ResearchBrief,
} from "./brief-store.js";
import { DEFAULT_PERSONAS, type PersonaKey } from "./personas.js";
import { objList, str, strList } from "./research-prompt-kit.js";

/** 候选张数（§1.2）：少于 2 张等于没得选，多于 4 张是让人做阅读理解 */
export const ANGLE_CARD_MIN = 2;
export const ANGLE_CARD_MAX = 4;

/**
 * 差异性粗筛阈值（§1.2 P2-2）：两张卡的 thesis+antiScope 拼串做字符 bigram Jaccard，
 * 超过它就当同一个角度换皮，打回自纠。**故意只做字面粗筛**——校验是防「五卡一角度」，
 * 不是学术查重，不引入 embedding。
 */
const ANGLE_SIMILARITY_MAX = 0.6;

/** 简报里的角度卡（旧简报没有这个字段 = 空数组，读侧不分支） */
export function angleCardsOf(brief: ResearchBrief | null | undefined): AngleCard[] {
  return brief?.angleCards ?? [];
}

export function findAngleCard(brief: ResearchBrief | null | undefined, angleId: string): AngleCard | null {
  return angleCardsOf(brief).find((c) => c.id === angleId) ?? null;
}

/**
 * 这份选择现在还生效吗？三个条件缺一即过期，按「没选」处理：
 * 1. 有简报（简报都没有，选择无从谈起）；
 * 2. 选的是**最新那版**简报（重跑过 = 候选换了一批，旧指针指的卡可能已不存在）；
 * 3. 简报没有因为选题被改而过期（topicHash 现算比对，同 §2 的现算纪律）。
 *
 * 返回的是选择时钉住的卡快照（改写版就是改写版），不是回简报里现找的原卡。
 */
export function activeAngleCard(
  selected: SelectedAngle | undefined,
  brief: ResearchBrief | null | undefined,
  currentTopicHash: string,
): AngleCard | null {
  if (!selected || !brief) return null;
  if (selected.briefRevision !== brief.revision) return null;
  if (brief.topicHash !== currentTopicHash) return null;
  return selected.card ?? null;
}

/**
 * v2 展示字段的兼容读法。v3 把「对谁说」拆成了主画像 + 误区 + 收获感，不再有
 * `audiencePain / holdTrigger`；而角度块的 v3 渲染要等 P1b（spec §4.4）。
 * 在那之前，既有消费方（写稿注入、审稿材料、聊天回执）用这两个函数拿语义最近的一句——
 * 好过让它们各自 `if (cardVersion === 3)` 分叉出三套说法。
 */
export function cardAudiencePain(card: AngleCard): string {
  if (!isAngleCardV3(card)) return card.audiencePain;
  return `${DEFAULT_PERSONAS[card.primaryPersona].name}｜他信的是：${card.misconception}`;
}

export function cardHoldTrigger(card: AngleCard): string {
  if (!isAngleCardV3(card)) return card.holdTrigger;
  return `${DEFAULT_PERSONAS[card.primaryPersona].triggers}｜网感元素：${card.elements.join("、")}`;
}

/**
 * 校验一张**外部传进来的**角度卡（选择 UI 的「改写」动作走这条）。
 * 创始人可以改写任何文字，但不能改 id、也不能凭空造证据引用——那两样是这份卡与简报的接榫。
 * 返回 string = 人话拒绝原因。
 *
 * 走哪一版由**简报里的原卡**决定（客户端自称的 cardVersion 只作兜底）：改写是在原卡上改，
 * 版本由产地钉死，不能靠提交方声明——否则改一张 v3 卡时少交几个字段就「降级」成 v2 了。
 */
export function parseAngleCard(raw: unknown, brief: ResearchBrief, angleId: string): AngleCard | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "card 必须是一个对象";
  const src = raw as Record<string, unknown>;
  const text = (key: string): string => (typeof src[key] === "string" ? (src[key] as string).trim() : "");
  if (typeof src.id === "string" && src.id.trim() && src.id.trim() !== angleId) {
    return `card.id（${src.id}）与 angle_id（${angleId}）不一致——改写不能换一张卡`;
  }
  const original = findAngleCard(brief, angleId);
  if (isAngleCardV3(original)) return parseRewrittenV3(src, brief, original);
  if (src.cardVersion === 3 || src.card_version === 3) {
    return `简报里的 ${angleId} 是旧版（v2）卡——改写不能顺手升级卡版本，要 v3 请重跑立意`;
  }
  const missing = ["angle", "thesis", "antiScope", "audiencePain", "holdTrigger", "hookDraft"].filter(
    (k) => !text(k),
  );
  if (missing.length > 0) return `card 缺少必填字段：${missing.join("、")}`;

  const refs = Array.isArray(src.coreEvidenceIds) ? src.coreEvidenceIds.filter((v) => typeof v === "string") : [];
  if (refs.length === 0) return "card.coreEvidenceIds 至少要有一条——没有证据的论点是臆测";
  const bad = refs.filter((id) => !evidenceByRef(brief.evidence, id));
  if (bad.length > 0) return `card.coreEvidenceIds 指向不存在的证据：${bad.join("、")}`;

  const tensionId = typeof src.tensionId === "string" ? src.tensionId.trim() : "";
  // 引了就必须引得到：解析不到的张力点在注入时会被静默省略，等于把创始人的意图悄悄吃掉
  if (tensionId && !tensionByRef(brief.tensions, tensionId)) {
    return `card.tensionId 指向不存在的张力点：${tensionId}`;
  }
  return {
    id: angleId,
    angle: text("angle"),
    thesis: text("thesis"),
    coreEvidenceIds: refs as string[],
    ...(tensionId ? { tensionId } : {}),
    antiScope: text("antiScope"),
    audiencePain: text("audiencePain"),
    holdTrigger: text("holdTrigger"),
    hookDraft: text("hookDraft"),
  };
}

/**
 * 改写一张 v3 卡（P1 spec §3.1）。**可改所有文字，不可改接榫**：
 * `id / cardVersion / coreEvidenceIds / firsthandAnchor.excerptHash` 是这张卡与简报的
 * 引用关系，改了就不再是「同一张卡的改写版」，归因与补证会跟着错。
 * 客户端提交的 `score` 一律丢弃、服务端重算（codex #7：分数是代码写的）。
 */
function parseRewrittenV3(
  src: Record<string, unknown>,
  brief: ResearchBrief,
  original: AngleCardV3,
): AngleCardV3 | string {
  const text = (key: string): string => (typeof src[key] === "string" ? (src[key] as string).trim() : "");
  if (src.cardVersion !== undefined && src.cardVersion !== 3) return "card.cardVersion 不可改（这是一张 v3 卡）";
  if (src.coreEvidenceIds !== undefined) {
    const refs = strList(src.coreEvidenceIds);
    const same =
      refs.length === original.coreEvidenceIds.length && refs.every((id, i) => id === original.coreEvidenceIds[i]);
    if (!same) return "card.coreEvidenceIds 不可改——要换证据请重跑立意，不要在改写里换地基";
  }
  const anchor = rewriteAnchor(src.firsthandAnchor, original.firsthandAnchor);
  if (typeof anchor === "string") return anchor;
  const gains = (src.personaGains ?? {}) as Record<string, unknown>;
  const card: AngleCardV3 = {
    ...original,
    angle: text("angle"),
    thesis: text("thesis"),
    antiScope: text("antiScope"),
    hookDraft: text("hookDraft"),
    misconception: text("misconception"),
    mechanism: text("mechanism"),
    payoff: text("payoff"),
    nextAction: text("nextAction"),
    counterResponse: text("counterResponse"),
    evidenceLevel: (text("evidenceLevel") || original.evidenceLevel) as AngleCardV3["evidenceLevel"],
    primaryPersona: (text("primaryPersona") || original.primaryPersona) as PersonaKey,
    structure: (text("structure") || original.structure) as AngleStructure,
    personaGains: {
      grow: str(gains.grow) || original.personaGains.grow,
      trust: str(gains.trust) || original.personaGains.trust,
      convert: str(gains.convert) || original.personaGains.convert,
    },
    elements: src.elements === undefined ? original.elements : readElements(src.elements),
    evidenceNeeds: src.evidenceNeeds === undefined ? original.evidenceNeeds : strList(src.evidenceNeeds),
    ...(anchor ? { firsthandAnchor: anchor } : {}),
  };
  const tensionId = text("tensionId");
  if (tensionId) card.tensionId = tensionId;
  else delete card.tensionId;
  // 分数不是创始人能填的字段：先抹掉，校验通过后由代码重算
  delete card.score;
  delete card.scoreReasons;

  const problems: string[] = [];
  validateAngleCardV3(card, brief, "card", problems);
  if (problems.length > 0) return problems.join("；");
  if (card.firsthandAnchor && !isAnchorValid(card, brief)) {
    return "card.firsthandAnchor.quote 必须仍是被引证据里的逐字片段——改了引文就得重新命中";
  }
  const { score, reasons } = scoreAngleCard(card, brief);
  return { ...card, score, scoreReasons: reasons };
}

/** 锚点：kind/引用/指纹原样继承，只有 quote 可改（改了在上层重新逐字命中） */
function rewriteAnchor(raw: unknown, original: FirsthandAnchor | undefined): FirsthandAnchor | undefined | string {
  if (!original) {
    // 原卡没锚点就不能在改写里新造一个：新锚点没有产地那一步的引用校验，等于凭空声明第一手材料
    if (raw && typeof raw === "object") return "card.firsthandAnchor 不能在改写里新增——重跑立意才会产生第一手锚点";
    return undefined;
  }
  if (raw === undefined || raw === null) return original;
  if (typeof raw !== "object" || Array.isArray(raw)) return "card.firsthandAnchor 必须是一个对象";
  const item = raw as Record<string, unknown>;
  const hash = str(item.excerptHash);
  if (hash && hash !== original.excerptHash) return "card.firsthandAnchor.excerptHash 不可改——它是引文出处的凭据";
  return { ...original, quote: str(item.quote) || original.quote };
}

function readElements(raw: unknown): AngleElement[] {
  return strList(raw).filter((e): e is AngleElement => (ANGLE_ELEMENTS as readonly string[]).includes(e));
}

// ─── 产地校验（综合子运行的 submit_brief 走这条） ─────────────────────────────

/** 字符 bigram 集合（空白不计）——中文没有词边界，bigram 是最省事的字面近似度底座 */
function bigrams(text: string): Set<string> {
  const chars = Array.from(text.replace(/\s+/g, ""));
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** 单张卡：字段齐全 + 证据引用指得到。指不到就是编的，打回让它自己改 */
function readAngleCard(
  item: Record<string, unknown>,
  index: number,
  evidence: BriefEvidence[],
  tensions: string[],
  problems: string[],
): AngleCardV2 | null {
  const at = `angle_cards[${index}]`;
  // 只看**本张**新增的问题：problems 是全卡共用的收集器，用长度快照才不会被上一张连坐
  const before = problems.length;
  const pick = (snake: string, camel: string): string => str(item[snake] ?? item[camel]);
  const angle = pick("angle", "angle");
  const thesis = pick("thesis", "thesis");
  const antiScope = pick("anti_scope", "antiScope");
  const audiencePain = pick("audience_pain", "audiencePain");
  const holdTrigger = pick("hold_trigger", "holdTrigger");
  const hookDraft = pick("hook_draft", "hookDraft");
  if (!angle || !thesis || !antiScope || !audiencePain || !holdTrigger || !hookDraft) {
    problems.push(`${at} 需要 angle / thesis / anti_scope / audience_pain / hold_trigger / hook_draft 六项都有`);
    return null;
  }
  const refs = strList(item.core_evidence_ids ?? item.coreEvidenceIds);
  const bad = refs.filter((id) => !evidenceByRef(evidence, id));
  if (refs.length === 0) {
    problems.push(`${at}.core_evidence_ids 至少要引 1 条证据——引不到证据的论点不要交`);
  } else if (bad.length > 0) {
    problems.push(
      `${at}.core_evidence_ids 指向不存在的证据：${bad.join("、")}（本份简报只有 ${evidence.length} 条证据，编号 ${evidenceRefId(0)}…${evidenceRefId(evidence.length - 1)}）`,
    );
  }
  const tensionId = pick("tension_id", "tensionId");
  if (tensionId && !tensionByRef(tensions, tensionId)) {
    problems.push(`${at}.tension_id「${tensionId}」不存在——张力点为空就别给这个字段`);
  }
  if (problems.length > before) return null;
  return {
    id: `angle-${index + 1}`,
    angle,
    thesis,
    coreEvidenceIds: refs,
    ...(tensionId ? { tensionId } : {}),
    antiScope,
    audiencePain,
    holdTrigger,
    hookDraft,
  };
}

/**
 * 任意两张卡的 thesis+antiScope 太像 = 同角度换皮，打回（§1.2 差异性校验）。
 * 立意 pass（v3 卡）复用同一把尺：两处各写一套差异标准，迟早分叉成两种「像」。
 */
export function checkDistinct(cards: AngleCard[], problems: string[]): void {
  const grams = cards.map((c) => bigrams(`${c.thesis}${c.antiScope}`));
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      if (jaccard(grams[i], grams[j]) > ANGLE_SIMILARITY_MAX) {
        problems.push(
          `angle_cards 第 ${i + 1} 张与第 ${j + 1} 张是同一个角度换套说法（论点与禁区高度重合）——` +
            "论点、受众痛点、叙事结构至少换一维，或者干脆少交一张",
        );
      }
    }
  }
}

/**
 * 收一批角度卡（tool args → 落盘形状）。id 由代码按位置编，模型说了不算。
 *
 * **证据为空时整块跳过**（§1.8 的同一条纪律）：一条证据都没挑出来的简报硬要 2-4 张
 * 带证据引用的卡，模型只能编——那时候宁可这份简报没有角度卡，也好过整轮综合被卡死、
 * 连摘要和洞察都拿不到。缺席这件事写进 `dropped`（并入 gaps），不静默。
 */
export function readAngleCards(
  raw: unknown,
  evidence: BriefEvidence[],
  tensions: string[],
  problems: string[],
  dropped: string[],
): AngleCard[] {
  if (evidence.length === 0) {
    dropped.push("本轮没挑出可引用的证据，未产出角度卡——写这条前请手写一句角度，或直接写");
    return [];
  }
  const items = objList(raw).slice(0, ANGLE_CARD_MAX);
  if (items.length < ANGLE_CARD_MIN) {
    problems.push(`angle_cards 需 ${ANGLE_CARD_MIN}-${ANGLE_CARD_MAX} 张，当前 ${items.length} 张`);
    return [];
  }
  const cards = items
    .map((item, i) => readAngleCard(item, i, evidence, tensions, problems))
    .filter((c): c is AngleCardV2 => c !== null);
  if (problems.length > 0) return [];
  checkDistinct(cards, problems);
  return problems.length > 0 ? [] : cards;
}
