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
import {
  evidenceByRef,
  evidenceRefId,
  tensionByRef,
  type AngleCard,
  type BriefEvidence,
  type ResearchBrief,
} from "./brief-store.js";
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
 * 校验一张**外部传进来的**角度卡（选择 UI 的「改写」动作走这条）。
 * 创始人可以改写任何文字，但不能改 id、也不能凭空造证据引用——那两样是这份卡与简报的接榫。
 * 返回 string = 人话拒绝原因。
 */
export function parseAngleCard(raw: unknown, brief: ResearchBrief, angleId: string): AngleCard | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "card 必须是一个对象";
  const src = raw as Record<string, unknown>;
  const text = (key: string): string => (typeof src[key] === "string" ? (src[key] as string).trim() : "");
  if (typeof src.id === "string" && src.id.trim() && src.id.trim() !== angleId) {
    return `card.id（${src.id}）与 angle_id（${angleId}）不一致——改写不能换一张卡`;
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
): AngleCard | null {
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

/** 任意两张卡的 thesis+antiScope 太像 = 同角度换皮，打回（§1.2 差异性校验） */
function checkDistinct(cards: AngleCard[], problems: string[]): void {
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
    .filter((c): c is AngleCard => c !== null);
  if (problems.length > 0) return [];
  checkDistinct(cards, problems);
  return problems.length > 0 ? [] : cards;
}
