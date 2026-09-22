/**
 * v3 卡保留 grow/trust/convert 字段名兼容存量数据；它们是内容目标，不是三类固定人群。
 * 受众以本次任务及已确认档案为准，未确认画像不能被默认 AI 行业模板顶替。
 */
import { goalSummary, personaSummary, type CreatorProfile } from "../profile/creator-profile.js";

export const PERSONAS_VERSION = 2;

export type PersonaKey = "grow" | "trust" | "convert";
export const PERSONA_KEYS: PersonaKey[] = ["grow", "trust", "convert"];

export interface PersonaTemplate {
  name: string;
  who: string;
  state: string;
  action: string;
  triggers: string;
}

/** 字段名沿用旧版本，内容只解释目标，不声明创作者的实际受众或账号目标。 */
export const DEFAULT_PERSONAS: Record<PersonaKey, PersonaTemplate> = {
  grow: {
    name: "触达与关注（涨粉）",
    who: "受众以本次任务和已确认画像为准",
    state: "需要理解内容与自己的关系，具体处境待材料支持",
    action: "当本次目标是触达时，让合适的读者愿意继续了解",
    triggers: "根据用户规划和实际受众选择，不预设反常识开场",
  },
  trust: {
    name: "理解与信任（立信）",
    who: "受众以本次任务和已确认画像为准",
    state: "需要可信的解释、经历或判断，具体处境待材料支持",
    action: "当本次目标是建立理解或信任时，让读者获得清楚可靠的认识",
    triggers: "材料和表达与读者的真实问题相关，不要求制造冲突",
  },
  convert: {
    name: "行动与转化（变现）",
    who: "受众以本次任务和已确认画像为准",
    state: "需要作出某项决定，具体处境待材料支持",
    action: "仅在本次任务有行动或商业目标时，帮助读者作出合适的决定",
    triggers: "明确帮助和适用边界，不默认咨询、成交或关注口号",
  },
};

export function personaLabel(key: PersonaKey): string {
  return DEFAULT_PERSONAS[key].name;
}

export function renderPersonas(profile: CreatorProfile | null): string {
  const lines = ["本次任务中明确的受众与目的优先于账号默认设置；核心受众不等于转化目标。"];
  const audience = profile?.audiencePersona;
  const core = personaSummary(audience, { allTiers: true });
  if (core && audience?.calibratedAt) {
    lines.push(`已确认的账号受众：${core}`);
  } else if (core) {
    lines.push(`待确认的账号画像提案：${core}。这是工作假设，不能当成用户已确认的人群；本次要求优先。`);
  } else {
    lines.push("账号受众未设置。仅依据本次任务描述识别受众；仍不明确就标注未知，不编造行业、年龄或焦虑。");
  }
  const industry = profile?.industry?.trim();
  if (industry) lines.push(`创作者领域：${industry}（不据此编造受众身份）`);
  const goal = goalSummary(profile?.goal);
  if (goal) lines.push(`账号长期目标：${goal}（与本次目标冲突时以本次任务为准）`);
  lines.push("以下是兼容卡片字段的内容目标标签，并非三个必须同时服务的画像：");
  for (const key of PERSONA_KEYS) {
    const target = DEFAULT_PERSONAS[key];
    lines.push(`- ${key}｜${target.name}：${target.action}`);
  }
  lines.push("每张卡只选择与本次目的最接近的 primaryPersona；没有商业目的不要硬凑转化收益，没有明示目标不要默认涨粉。未指定时可用 trust 表示理解与信任，并注明是工作假设。");
  return lines.join("\n");
}
