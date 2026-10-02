/**
 * 立意卡与选题会的接缝（选题会 spec §7）。
 *
 * 1. payoff 收紧：必须是看完能做的一件事或能下的一个判断。「看懂 / 了解 / 认识 X」式空话
 *    用确定性前缀检查拒掉（另在提示词里讲清）；存量卡不回溯，只在新产出与改写了 payoff 时检查。
 * 2. 可选的 forPersona（档案受众层 core/adjacent/surprise + 名字快照）与 hookType；
 *    缺省照常通过（存量 v3 卡零迁移），名字不和档案现值比对（档案改名不让旧卡改写失败）。
 * 3. 有会议位时：卡要服从会上定的形式与画像，偏离必须在 meetingDeviation 写理由。
 */
import { str } from "./research-prompt-kit.js";

export const PERSONA_TIERS = ["core", "adjacent", "surprise"] as const;
export type PersonaTier = (typeof PERSONA_TIERS)[number];
export const HOOK_TYPES = ["亲历", "观点", "反常识", "教学", "案例"] as const;
export type HookType = (typeof HOOK_TYPES)[number];

export interface ForPersona { key: PersonaTier; name: string }

/** 会议位注入立意的那部分（会议记录里的 slot 摘要） */
export interface MeetingAngleSlot {
  meetingDate: string;
  slotId: string;
  persona: ForPersona;
  payoff: string;
  format: string;
  bet: string;
}

/** 「用一个历史类比看懂 X」「帮你了解 X」「让观众 3 分钟认识 X」——引导语之后紧跟理解类动词 */
const UNDERSTAND_VERBS = ["看懂", "了解", "认识", "搞懂", "弄懂", "看清", "读懂", "明白"];
const EMPTY_PAYOFF = new RegExp(
  `^(?:(?:用|通过|借助|借|从|帮|让|带|一起)[^，。,；;]{0,20}?)?(${UNDERSTAND_VERBS.join("|")})`,
);

/** 空话 payoff 的拒绝理由；合格返回 null */
export function emptyPayoffReason(payoff: string): string | null {
  const text = payoff.trim().replace(/^[「“"]/, "");
  const hit = EMPTY_PAYOFF.exec(text);
  if (!hit) return null;
  return `payoff「${payoff.slice(0, 40)}」是「${hit[1]} X」式空话——写观众看完能做的一件事或能下的一个判断（谁、做什么/判断什么）`;
}

export function readForPersona(raw: unknown, tag: string, problems: string[]): ForPersona | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const obj = (typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const key = str(obj.key);
  const name = str(obj.name);
  if (!(PERSONA_TIERS as readonly string[]).includes(key) || !name) {
    problems.push(`${tag}：forPersona 要 {key: core|adjacent|surprise, name: 档案里该层的名字}`);
    return undefined;
  }
  return { key: key as PersonaTier, name };
}

export function readHookType(raw: unknown, tag: string, problems: string[]): HookType | undefined {
  const value = str(raw);
  if (!value) return undefined;
  if (!(HOOK_TYPES as readonly string[]).includes(value)) {
    problems.push(`${tag}：hookType 只能是 ${HOOK_TYPES.join(" / ")}`);
    return undefined;
  }
  return value as HookType;
}

interface MeetingFields { forPersona?: ForPersona; hookType?: HookType; meetingDeviation?: string }

/** 有会议位：两个字段必填；与会上定的画像/形式不一致时要写偏离理由（形式不在 hookType 枚举里就只比画像） */
export function checkMeetingConformance(card: MeetingFields, slot: MeetingAngleSlot | undefined, tag: string, problems: string[]): void {
  if (!slot) return;
  if (!card.forPersona || !card.hookType) {
    problems.push(`${tag}：这条选题有会议位（${slot.meetingDate} ${slot.slotId}），forPersona 与 hookType 必填`);
    return;
  }
  const personaOff = card.forPersona.key !== slot.persona.key;
  const formatOff = (HOOK_TYPES as readonly string[]).includes(slot.format) && card.hookType !== slot.format;
  if ((personaOff || formatOff) && !card.meetingDeviation?.trim()) {
    problems.push(`${tag}：偏离了会上定的${personaOff ? `画像 ${slot.persona.key}` : ""}${personaOff && formatOff ? "与" : ""}${formatOff ? `形式 ${slot.format}` : ""}——在 meetingDeviation 写明理由，由创始人选`);
  }
}

/** 注入立意 user message 的会议位块；没有会议位返回空串（照旧） */
export function renderMeetingSlotBlock(slot: MeetingAngleSlot | undefined, formatSummary?: string): string {
  if (!slot) return formatSummary ? `【账号形式表现（只作参考，不强制结构）】\n${formatSummary}` : "";
  return [
    `【选题会定的方向（${slot.meetingDate} 会议位 ${slot.slotId}）——卡要服从；偏离写 meetingDeviation 理由】`,
    `给谁看：${slot.persona.key}（${slot.persona.name}）——每张卡的 forPersona 写这一层`,
    `观众拿走什么：${slot.payoff}`,
    `形式：${slot.format}——hookType 对应写`,
    `赌什么：${slot.bet}`,
    ...(formatSummary ? ["【账号形式表现（只作参考，不强制结构）】", formatSummary] : []),
  ].join("\n");
}
