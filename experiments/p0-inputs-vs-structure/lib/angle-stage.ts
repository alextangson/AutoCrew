/**
 * 立意阶段（angle-stage spec v3 §7）的最小实现，供 P0b 的 `angle` 格用。
 *
 * 独立于调研综合的一次 LLM pass：误区清单 → 3–4 个候选立意 → 代码侧打分选一 → 渲染成
 * `direction` 文本注入现有写手（direction 是写手提示里优先级最高的一块，不改生产代码）。
 *
 * 结构方法论的立场（创始人 2026-09-02 之问「要不要给模型结构」）：**给菜单，不给模板**。
 * 结构由立意决定——先选主画像和误区，再从四种骨架里挑一种；措辞、节奏、案例展开交给模型。
 * 模板硬套出来的就是 P0 里那批「有结构没洞察」。
 */
import type { runLoop as RunLoop, LoopTool } from "../../../src/engine/loop.js";
import type { EngineConfig } from "../../../src/engine/config.js";

export type PersonaKey = "grow" | "trust" | "convert";

/** 三画像 = 账号的三项工作（spec v3 §7.1，创始人 2026-09-02 认可） */
export const PERSONAS: Record<PersonaKey, { name: string; who: string; state: string; action: string; triggers: string }> = {
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

export const ELEMENTS = ["新奇点", "爽点", "痛点→理想状态", "笑点", "泪点", "美点"] as const;
export type Element = (typeof ELEMENTS)[number];

/** 结构骨架菜单：由立意挑一种，不是模板。前三种对应口播赛道包已有的 structureModes。 */
export const STRUCTURES = {
  "myth-busting": "反认知纠偏：先立受众信的那个错误说法 → 代价 → 用事实推翻 → 正确判断 → 最小动作",
  story: "亲历复盘：一段具体经历切入 → 当时的判断与转折 → 提炼一个可带走的结论",
  "single-point": "单点打穿：一个论断 → 为什么多数人想不到 → 一个完整案例展开 → 怎么用",
  "claim-case-claim": "观点+案例+观点：先给主张 → 一个第一手案例 → 案例改写后的主张（第二次的观点必须比第一次更锋利，不是复述）",
} as const;
export type StructureKey = keyof typeof STRUCTURES;

export interface AngleCandidate {
  id: string;
  primaryPersona: PersonaKey;
  misconception: string;
  thesis: string;
  nextAction: string;
  elements: Element[];
  counterResponse: string;
  firsthandAnchor: string;
  personaGains: Record<PersonaKey, string>;
  structure: StructureKey;
  hookDraft: string;
  antiScope: string;
}

export interface AngleResult {
  misconceptions: Record<PersonaKey, string[]>;
  candidates: AngleCandidate[];
  /** 代码侧打分（不是模型自评） */
  scores: Array<{ id: string; score: number; reasons: string[] }>;
  picked: AngleCandidate;
  direction: string;
}

const PERSONA_KEYS: PersonaKey[] = ["grow", "trust", "convert"];

function systemPrompt(): string {
  const personas = PERSONA_KEYS.map(
    (k) => `- ${k}｜${PERSONAS[k].name}：${PERSONAS[k].who}。处境：${PERSONAS[k].state}。看完要做的动作：${PERSONAS[k].action}。停留触发：${PERSONAS[k].triggers}`,
  ).join("\n");
  const structures = Object.entries(STRUCTURES)
    .map(([k, v]) => `- ${k}：${v}`)
    .join("\n");
  return [
    "你是一个 AI 一线实践者（FDE 部署 + vibecoding）账号的策划，负责短视频口播稿的**立意**，不写稿。",
    "立意 = 对某一个画像成立的、可被反驳的主张 + 他看完能做的一个动作。",
    "",
    "三个受众画像（账号的三项工作：涨粉 / 立信 / 变现）：",
    personas,
    "",
    "判据：",
    "1. 误区先行：先答「这个画像走进来时信什么错的东西」。先陈述受众的错误认知再反驳，观众才会留下来；讲得顺滑等于看完了可以走了。",
    "2. 三画像收益：主画像有明确动作，另外两个至少不反感、最好各得一点。三个都答不上来的立意不能用。",
    "3. 网感元素 ≥2：新奇点（认知违背）/ 爽点（看穿、走捷径）/ 痛点→理想状态 / 笑点（自我否定式坦白）/ 泪点（真实失败的细节）/ 美点（把混乱理顺）。不能全靠新奇点。",
    "4. 立场站得住：过反方一句话。劝退、唱衰这类反向立场只在给观众一个能拿走的判断框架时成立，否则是对同行说话。",
    "5. 热点走中层：事件本身是表层；观众的社会情绪（怕落后、怕被割、谁在定义下一代做事方式）是中层；立意落在中层。",
    "6. 第一手锚点：优先用「创作者本人说过/审定过」的材料做案例；没有第一手锚点的立意最高只能算综述级。",
    "",
    "结构是菜单不是模板，由立意挑一种；措辞、节奏、案例展开留给写手：",
    structures,
    "",
    "先列三画像各 1–2 条误区，再给 3–4 个候选立意（主画像、主张、动作、元素、反方一句话、第一手锚点、三画像各一句收益、结构、开头钩子、不写什么），候选之间主画像或主张至少一维不同。",
    "只通过 submit_angles 工具提交，不要在正文里写稿。",
  ].join("\n");
}

function schema(): Record<string, unknown> {
  const str = { type: "string" };
  const persona = { type: "string", enum: PERSONA_KEYS };
  return {
    type: "object",
    required: ["misconceptions", "candidates"],
    properties: {
      misconceptions: {
        type: "object",
        required: PERSONA_KEYS,
        properties: Object.fromEntries(PERSONA_KEYS.map((k) => [k, { type: "array", items: str, minItems: 1 }])),
      },
      candidates: {
        type: "array",
        minItems: 3,
        maxItems: 4,
        items: {
          type: "object",
          required: [
            "id",
            "primaryPersona",
            "misconception",
            "thesis",
            "nextAction",
            "elements",
            "counterResponse",
            "firsthandAnchor",
            "personaGains",
            "structure",
            "hookDraft",
            "antiScope",
          ],
          properties: {
            id: str,
            primaryPersona: persona,
            misconception: str,
            thesis: str,
            nextAction: str,
            elements: { type: "array", items: { type: "string", enum: [...ELEMENTS] }, minItems: 1 },
            counterResponse: str,
            firsthandAnchor: { type: "string", description: "引用的创作者原话/审定稿片段或简报证据 id；没有就写「无」" },
            personaGains: {
              type: "object",
              required: PERSONA_KEYS,
              properties: Object.fromEntries(PERSONA_KEYS.map((k) => [k, str])),
            },
            structure: { type: "string", enum: Object.keys(STRUCTURES) },
            hookDraft: str,
            antiScope: str,
          },
        },
      },
    },
  };
}

/** 契约校验：形状之外再查判据能查的部分。返回错误列表，空 = 通过。 */
export function validateAngles(args: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const cands = Array.isArray(args.candidates) ? (args.candidates as AngleCandidate[]) : [];
  if (cands.length < 3) errs.push(`候选至少 3 个，当前 ${cands.length}`);
  const theses = new Set<string>();
  for (const c of cands) {
    if (!c || typeof c !== "object") continue;
    const tag = `候选 ${c.id ?? "?"}`;
    if (!Array.isArray(c.elements) || c.elements.length < 2) errs.push(`${tag}：网感元素需 ≥2`);
    if (Array.isArray(c.elements) && c.elements.length >= 2 && c.elements.every((e) => e === "新奇点")) errs.push(`${tag}：不能全靠新奇点`);
    for (const k of PERSONA_KEYS) if (!c.personaGains?.[k]?.trim()) errs.push(`${tag}：缺 ${k} 画像的收益`);
    if (!c.misconception?.trim()) errs.push(`${tag}：缺误区`);
    if (!c.nextAction?.trim()) errs.push(`${tag}：缺最小动作`);
    if (!c.counterResponse?.trim()) errs.push(`${tag}：缺反方回应`);
    if (c.thesis && theses.has(c.thesis.trim())) errs.push(`${tag}：主张与另一候选重复`);
    if (c.thesis) theses.add(c.thesis.trim());
  }
  return errs;
}

/** 代码侧打分：不用模型自评。 */
export function scoreCandidate(c: AngleCandidate): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const elements = new Set(c.elements);
  score += Math.min(elements.size, 3);
  reasons.push(`元素 ${elements.size}`);
  const anchored = c.firsthandAnchor && !/^无|^没有|^none$/i.test(c.firsthandAnchor.trim());
  if (anchored) {
    score += 2;
    reasons.push("有第一手锚点");
  } else reasons.push("无第一手锚点（综述级）");
  if (/劝|别碰|不要|唱衰|别用/.test(c.thesis) && !/框架|判断|标准|怎么判|什么时候/.test(c.thesis + c.nextAction)) {
    score -= 2;
    reasons.push("反向立场且未给判断框架");
  }
  if (c.primaryPersona === "grow") {
    score += 1;
    reasons.push("主画像=涨粉（账号当前目标）");
  }
  return { score, reasons };
}

export function renderDirection(c: AngleCandidate): string {
  const p = PERSONAS[c.primaryPersona];
  return [
    `【立意】主画像：${p.name}。他走进来时信的错误认知：${c.misconception}`,
    `主张（必须论证，不是复述材料）：${c.thesis}`,
    `他看完要做的动作：${c.nextAction}`,
    `三画像收益：涨粉画像——${c.personaGains.grow}；立信画像——${c.personaGains.trust}；变现画像——${c.personaGains.convert}`,
    `要命中的网感元素：${c.elements.join("、")}`,
    `反方会说：${c.counterResponse}——正文里要正面回应。`,
    `第一手锚点：${c.firsthandAnchor}`,
    `结构骨架：${STRUCTURES[c.structure]}。只用这一种骨架；措辞、节奏、案例展开你自己定。`,
    `开头钩子草稿（可改写）：${c.hookDraft}`,
    `不写：${c.antiScope}`,
    "前 3 秒必须点出误区或反常识并提问，不要「今天聊聊」；全篇只讲这一个主张；结尾给观众今天就能做的一步。",
  ].join("\n");
}

export interface AngleStageInput {
  topicTitle: string;
  topicDescription?: string;
  /** 简报全文 + 内部语料（与 full 档写手拿到的同一份） */
  research: string;
}

export async function runAngleStage(
  runLoopImpl: typeof RunLoop,
  config: EngineConfig,
  model: string,
  input: AngleStageInput,
): Promise<AngleResult> {
  let captured: { misconceptions: AngleResult["misconceptions"]; candidates: AngleCandidate[] } | null = null;
  let repairs = 0;
  const tool: LoopTool = {
    name: "submit_angles",
    description: "提交误区清单与候选立意。校验不过会返回错误清单，修正后重新提交。",
    parameters: schema(),
    execute: (args) => {
      const errs = validateAngles(args);
      if (errs.length) {
        repairs++;
        if (repairs > 2) return "Error: 校验仍未通过，修复轮已用尽，本次提交作废。\n- " + errs.join("\n- ");
        return "Error: 输出契约校验未通过：\n- " + errs.join("\n- ") + "\n逐项修复后重新调用 submit_angles。";
      }
      captured = args as unknown as typeof captured;
      return "已收到立意。";
    },
  };
  const user = [
    `选题：${input.topicTitle}`,
    input.topicDescription ? `选题说明：${input.topicDescription}` : "",
    "",
    "调研材料（简报全文 + 创作者本人说过/审定过的材料）：",
    input.research,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await runLoopImpl(config, {
    model,
    systemPrompt: systemPrompt(),
    userMessage: user,
    tools: [tool],
    maxTurns: 5,
    maxTotalTokens: 60000,
    logMeta: { runId: `p0b-angle-${Date.now()}`, agent: "angle" },
  });
  if (!captured) {
    throw new Error(`立意阶段没有产出合法候选（loop ${result.stopReason}，turns=${result.turns}，repairs=${repairs}）`);
  }
  const { misconceptions, candidates } = captured as { misconceptions: AngleResult["misconceptions"]; candidates: AngleCandidate[] };
  const scores = candidates.map((c) => ({ id: c.id, ...scoreCandidate(c) }));
  const best = [...scores].sort((a, b) => b.score - a.score)[0];
  const picked = candidates.find((c) => c.id === best.id) ?? candidates[0];
  return { misconceptions, candidates, scores, picked, direction: renderDirection(picked) };
}
