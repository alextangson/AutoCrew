/**
 * 输入预算装配（P1 spec §4.3 / codex #14）——一稿的 research 槽只在这里拼一次。
 *
 * 改动前的装配是「用户材料在前 + 简报块 2800 + 知识库补位」，总槽 4000。P1b 之后同一个槽里
 * 要挤进四样新东西（选中卡的核心证据、定向补证块、内部语料锚点、口吻参考），4000 装不下，
 * 而「谁被挤掉」不能靠 join 的先后顺序碰运气——所以预算变成一张**显式优先级表**：
 *
 * | 1 | 选中卡核心证据 + 补证块 | 4000 |  ← 本稿主张的地基，第一个装
 * | 2 | 简报块（去掉已在 1 的证据）| 2800 |
 * | 3 | own-material 锚点片段     | 2000 |  ← 卡上 firsthandAnchor 指的那一段
 * | 4 | 用户 research            | 2000 |
 * | 5 | 口吻参考（其余 own-material）| 1500 |
 * | — | 知识库                    | 剩余 ≥400 才注入 |
 *
 * 总上限 12000。装配产出一份**快照**：写手与审稿读的是同一个字符串（审稿从前自己再按
 * 6000 裁一刀，于是审稿人判「证据支撑住论点了吗」时看到的材料比写手少——判据的基准和
 * 写作的输入不是同一份，这是审出来的假问题的一个来源）。
 *
 * 纯函数 + 一个注入的知识库检索器：不读盘、不认识 knowledge 模块。
 */
import { clampChars, externalBlock, sanitizeExternal } from "../research/research-prompt-kit.js";
import { domainOf } from "../research/brief-inject.js";

// ─── 预算表（测试锁定） ──────────────────────────────────────────────────────

export const INPUT_TOTAL_BUDGET = 12_000;
export const CORE_EVIDENCE_BUDGET = 4_000;
export const BRIEF_SLOT_BUDGET = 2_800;
export const ANCHOR_BUDGET = 2_000;
export const USER_RESEARCH_BUDGET = 2_000;
export const VOICE_REFERENCE_BUDGET = 1_500;
/** 知识库的最小可用预算：剩余不足这个数整块省略（半截知识没意义，沿用 §6 的口径） */
export const KNOWLEDGE_MIN_ROOM = 400;

/** 快照里每一段的名字。落在 `ResearchSnapshot.parts` 上，供日志与测试断言「谁进来了、占多少」 */
export type ResearchPartName =
  | "core_evidence"
  | "brief"
  | "own_anchor"
  | "user_research"
  | "voice_reference"
  | "knowledge";

export interface ResearchPart {
  name: ResearchPartName;
  chars: number;
}

/**
 * 一稿的 research 槽快照。`text` 是**逐字**进写手 prompt 的那一份，
 * 审稿拿到的必须是同一个字符串——不许任何一侧再裁一刀。
 */
export interface ResearchSnapshot {
  text: string;
  parts: ResearchPart[];
}

export const EMPTY_RESEARCH_SNAPSHOT: ResearchSnapshot = Object.freeze({
  text: "",
  parts: [] as ResearchPart[],
}) as ResearchSnapshot;

export interface ResearchInputs {
  /** 优先级 1：选中卡的核心证据 + 定向补证块（调用方拼好，本模块只管预算） */
  coreEvidence?: string;
  /** 优先级 2：简报块（已由调用方去掉在 1 里逐字摆过的证据） */
  brief?: string;
  /** 优先级 3：内部语料锚点片段（卡上 firsthandAnchor 指的那一段） */
  ownAnchor?: string;
  /** 优先级 4：创始人自己贴的材料 */
  userResearch?: string;
  /** 优先级 5：其余内部语料，只供口吻参考 */
  voiceReference?: string;
}

/** 知识库补位：`defaultChars` 是它自己的默认上限，实际给的是它与剩余预算的较小者 */
export interface KnowledgeSlot {
  defaultChars: number;
  retrieve: (maxChars: number) => Promise<string | null>;
}

/** 按 UTF-16 长度截断且不切断代理对（与 brief-inject 同一把尺，预算相减才对得上） */
function hardClamp(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return value.slice(0, end);
}

const ORDER: ReadonlyArray<[ResearchPartName, keyof ResearchInputs, number]> = [
  ["core_evidence", "coreEvidence", CORE_EVIDENCE_BUDGET],
  ["brief", "brief", BRIEF_SLOT_BUDGET],
  ["own_anchor", "ownAnchor", ANCHOR_BUDGET],
  ["user_research", "userResearch", USER_RESEARCH_BUDGET],
  ["voice_reference", "voiceReference", VOICE_REFERENCE_BUDGET],
];

/**
 * 装配。段与段之间用空行分隔（沿用改动前的 `join("\n\n")`——无简报无语料时
 * 输出与老路逐字一致，那条路上只有用户材料与知识库两段）。
 *
 * 知识库放在最后一位取剩余：它是补位材料，任何一份本稿专属的材料都比它优先。
 */
export async function assembleResearchInput(
  inputs: ResearchInputs,
  knowledge?: KnowledgeSlot,
): Promise<ResearchSnapshot> {
  const parts: ResearchPart[] = [];
  const chunks: string[] = [];
  let used = 0;

  for (const [name, key, cap] of ORDER) {
    const raw = inputs[key]?.trim();
    if (!raw) continue;
    const room = Math.min(cap, INPUT_TOTAL_BUDGET - used);
    if (room <= 0) continue;
    const text = hardClamp(raw, room);
    if (!text.trim()) continue;
    chunks.push(text);
    parts.push({ name, chars: text.length });
    used += text.length;
  }

  if (knowledge) {
    const room = INPUT_TOTAL_BUDGET - used;
    if (room >= KNOWLEDGE_MIN_ROOM) {
      const text = (await knowledge.retrieve(Math.min(knowledge.defaultChars, room)))?.trim();
      if (text) {
        const clipped = hardClamp(text, room);
        chunks.push(clipped);
        parts.push({ name: "knowledge", chars: clipped.length });
      }
    }
  }

  return { text: chunks.join("\n\n"), parts };
}

// ─── 核心证据块（优先级 1 的前半段） ────────────────────────────────────────

const CLAIM_MAX = 80;
const QUOTE_MAX = 200;
/**
 * 核心证据块体上限。定得这么紧是为了让「核心证据 + 补证块」两段加起来仍装得进优先级 1 的
 * 4000：补证块自己封顶 3000 块体（`renderTargetedEvidence`），剩下的才是这里能用的。
 * 装不下的整条丢掉，块永远是完整的一对定界符——截半的块等于把外部文本泄进指令区。
 */
const CORE_BLOCK_MAX = 600;

export interface CoreEvidenceItem {
  /** 稳定引用 id（简报的 `ev-N`）——写手引用时要带上它，数字硬门也按它对账 */
  id: string;
  claim?: string;
  quote: string;
  sourceUrl?: string;
}

/**
 * 选中卡核心证据块。为什么单独摆在 research 槽最前面而不是留在角度块里：v3 的角度块要
 * 讲的是「这一稿写什么」（误区/机制/主张/动作），证据是**材料**不是立意；把逐字引文塞进
 * 立意块会让 200 字的字段上限把引文截半，截半的引文既不能引用也不能核验。
 *
 * 走 `externalBlock` + `sanitizeExternal`：引文是外部原文，注入纪律与简报块一致。
 */
export function renderCoreEvidence(items: readonly CoreEvidenceItem[]): string {
  const lines = items
    .filter((e) => e?.quote?.trim())
    .map(
      (e) =>
        `- ${e.id}【${sanitizeExternal(e.claim ?? "", CLAIM_MAX) || "（无主张）"}】` +
        `「${sanitizeExternal(e.quote, QUOTE_MAX)}」——${domainOf(e.sourceUrl)}`,
    );
  if (lines.length === 0) return "";
  const body = [
    "本稿主张的核心证据（逐字引文，引用时带上前面的 ev- id；数字必须与这里对得上）：",
    ...lines,
  ].join("\n");
  return externalBlock([clampChars(body, CORE_BLOCK_MAX)]);
}

/**
 * 两段合成优先级 1 的整块：核心证据在前（论点的地基），补证块在后（为本稿现查的）。
 * 两段各自已经封过顶，这里只负责拼——**不再截断**，截断会切断定界符。
 */
export function joinCoreEvidence(coreBlock: string, targetedBlock: string): string {
  return [coreBlock, targetedBlock].map((s) => s.trim()).filter(Boolean).join("\n\n");
}
