/**
 * 角度选择的判断层(角度卡 spec §1.3/§1.4/§1.6)——**纯函数,不碰 DOM 不碰 IPC**。
 * 组件里只做接线,判断全在这里,才测得动。
 *
 * 与后端 src/modules/research/angle-cards.ts 的 `activeAngleCard` 同一套口径:
 * 界面说「这份选择还作数」的条件,必须和写稿时真正注入的条件逐条一致——
 * 两套事实会长成「工作台说已选、写出来却没带角度」。
 */
import type { AngleCard, SelectedAngle } from "../lib";

/** 简报元信息(research:status / brief_get 都给这三样) */
export interface BriefMetaLike {
  revision: number;
  stale: boolean;
}

/**
 * 三态:
 * - `none`  没选过——写稿会走「未经角度点选」;
 * - `active` 选择生效中,写稿会注入这张卡;
 * - `stale` 选过但已作废(选的不是最新那版简报,或简报因选题被改而过期)——写稿按没选处理,
 *   所以界面必须显眼地说出来,不能让人以为自己的品味还在管线里。
 */
export type AngleChoiceState = "none" | "active" | "stale";

/**
 * 这份选择现在还作数吗。没有简报时**算过期而不是没选**:选择还躺在盘上、却一定不会被注入,
 * 「没选」会把这个事实抹掉。
 */
export function angleChoiceState(
  selected: SelectedAngle | undefined,
  meta: BriefMetaLike | null | undefined,
): AngleChoiceState {
  if (!selected) return "none";
  if (!meta) return "stale";
  if (selected.briefRevision !== meta.revision) return "stale";
  return meta.stale ? "stale" : "active";
}

/** 平台矩阵「生成」按钮要的那点事实:有几张候选 + 选择三态 */
export interface AngleGate {
  cards: number;
  state: AngleChoiceState;
}

export const NO_ANGLE_GATE: AngleGate = { cards: 0, state: "none" };

/**
 * 派活前要不要先让人拍板(§1.6「工作台写这条」)。
 * 手写 direction 非空 = 已经给了角度(而且是最高优先级),直接放行——这与后端闸口同款判断。
 */
export function needsAnglePick(gate: AngleGate, direction: string): boolean {
  if (direction.trim()) return false;
  return gate.cards > 0 && gate.state !== "active";
}

/** 一条证据引用解出来的样子;`claim` 为 null = 简报里找不到这条(数据坏了,要说出来) */
export interface AngleEvidenceRef {
  id: string;
  claim: string | null;
  sourceUrl: string | null;
}

export interface BriefEvidenceLike {
  claim: string;
  quote: string;
  sourceUrl: string;
}

/** "ev-2" → 下标 1;格式不对返回 null(与后端 refIndex 同规则) */
function evidenceIndex(id: string): number | null {
  const m = /^ev-(\d+)$/.exec(id.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n - 1 : null;
}

/** 角度卡的证据引用 → 可展示的证据。解不出的原样留着标 null,不静默丢 */
export function resolveEvidenceRefs(evidence: BriefEvidenceLike[], ids: string[]): AngleEvidenceRef[] {
  return ids.map((id) => {
    const i = evidenceIndex(id);
    const hit = i !== null && i < evidence.length ? evidence[i] : null;
    return { id, claim: hit ? hit.claim : null, sourceUrl: hit ? hit.sourceUrl : null };
  });
}

/** 卡上可改写的六个文本字段(id 与证据引用是与简报的接榫,不许改——后端也会拒) */
export const ANGLE_EDIT_FIELDS = [
  { key: "angle", label: "切入点" },
  { key: "thesis", label: "核心论点" },
  { key: "antiScope", label: "禁区(不写什么)" },
  { key: "audiencePain", label: "受众痛点" },
  { key: "holdTrigger", label: "停留触发" },
  { key: "hookDraft", label: "钩子草稿" },
] as const;

export type AngleEditKey = (typeof ANGLE_EDIT_FIELDS)[number]["key"];

/** 生效的这张卡是不是被创始人改写过(与简报原卡逐字段比) */
export function isRewritten(original: AngleCard, chosen: AngleCard): boolean {
  return ANGLE_EDIT_FIELDS.some((f) => original[f.key].trim() !== chosen[f.key].trim());
}

/**
 * 界面上该显示哪一版卡:选中且生效时显示**创始人那一版**(改写过就是改写版),
 * 否则显示简报原卡。过期的选择不冒充生效版。
 */
export function displayCard(card: AngleCard, selected: SelectedAngle | undefined, state: AngleChoiceState): AngleCard {
  if (state !== "active" || !selected || selected.angleId !== card.id) return card;
  return selected.card ?? card;
}
