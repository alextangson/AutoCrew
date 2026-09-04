/**
 * 三画像（P1 spec §3.4）：账号的三项工作——涨粉 / 立信 / 变现。
 *
 * 为什么写死在代码里而不是读设置：P0 三轮实验证明「立意」是一阶变量，而立意的第一步是
 * **对谁说**。三段画像是创始人 2026-09-02 认可的既有口径，先固化成带版本的默认模板，
 * 设置页可改是 P2（届时加 `profile.personaRoles`，`PERSONAS_VERSION` 随之 +1）。
 *
 * **现有 `audiencePersona.core` 绝不映射成 convert**（codex #26）：它在代码里的语义只是
 * 「核心受众」，没有任何变现含义；硬映射会让「找我做咨询」这项工作被一个泛受众顶替。
 * 它只作补充上下文出现，标签写明它是补充。
 */
import { personaSummary, type CreatorProfile } from "../profile/creator-profile.js";

/** 模板版本：卡上不落这个号，但改模板等于改立意口径，必须能在 git 里看出来 */
export const PERSONAS_VERSION = 1;

export type PersonaKey = "grow" | "trust" | "convert";

export const PERSONA_KEYS: PersonaKey[] = ["grow", "trust", "convert"];

export interface PersonaTemplate {
  name: string;
  /** 是谁 */
  who: string;
  /** 走进来时的处境 */
  state: string;
  /** 看完要做的那个动作——立意成立与否就看它 */
  action: string;
  /** 什么会让他停下滑动 */
  triggers: string;
}

export const DEFAULT_PERSONAS: Record<PersonaKey, PersonaTemplate> = {
  grow: {
    name: "被 AI 追着跑的职场人（涨粉）",
    who: "25–40 岁，用过 ChatGPT/豆包，没做出过东西，怕被时代甩下、怕被割",
    state: "热点刷到了，名词听不懂，想知道跟自己有什么关系",
    action: "关注：「他讲的我能听懂，下次还想听他讲」",
    triggers: "名词祛魅、反常识、「原来是这样」",
  },
  trust: {
    name: "同行 / 独立开发者（立信）",
    who: "vibecoder、做 agent 的、已经踩过坑",
    state: "知道内情，没时间实测，对空话免疫",
    action: "收藏/转发：「他测了我没空测的，数字对得上」",
    triggers: "具体命令/数字/失败细节、自我否定式开场",
  },
  convert: {
    name: "要落地 AI 的决策者（变现）",
    who: "中型企业技术 VP、传统行业老板；方案商 PPT 看了三十版，前两次 AI 都死了",
    state: "不知道该信谁，怕第三次再失败",
    action: "找我：「这个人在现场，他知道那层看不见的阻力」",
    triggers: "真实企业名 + 失败原因、内部博弈还原",
  },
};

export function personaLabel(key: PersonaKey): string {
  return DEFAULT_PERSONAS[key].name;
}

/**
 * 画像块（进立意 prompt 的唯一口径）。创作者定位与现有核心受众画像都是**可信上下文**
 * （出自我们自己的库），所以不消毒；但它们只是补充，三画像才是判断基准。
 */
export function renderPersonas(profile: CreatorProfile | null): string {
  const lines = PERSONA_KEYS.map((k) => {
    const p = DEFAULT_PERSONAS[k];
    return `- ${k}｜${p.name}：${p.who}。处境：${p.state}。看完要做的动作：${p.action}。停留触发：${p.triggers}`;
  });
  const industry = profile?.industry?.trim();
  if (industry) lines.push(`（创作者定位：${industry}——三画像都落在这个领域里，不要泛化成全网观众）`);
  const core = personaSummary(profile?.audiencePersona);
  // 只作补充：标签说死它是「现有核心受众」，模型才不会拿它当第四个画像或替换 convert
  if (core) lines.push(`「补充：现有核心受众画像」${core}（仅供参考，不是第四个画像，也不等于变现画像）`);
  return lines.join("\n");
}
