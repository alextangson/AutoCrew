/**
 * 审稿 agent 的 prompt（审稿 spec §2.3/§2.4）——判据表与材料装配都在这儿，
 * 收敛循环在 script-review.ts。分文件只为一件事：判据是会长期演化的内容资产，
 * 状态机不该被它撑到读不动。
 *
 * 判据两类：
 * - **AI 味**：humanizer-zh SKILL 的词表/句式升维而来。正则删词只能删「值得一提的是」这种
 *   字面痕迹，判不了「三段排比 + 总分总 + 每段等长」这种结构病——那正是审稿人存在的理由。
 * - **洞察深度**：只有给了材料才判（§2.4「没给材料的维度不判」）。没有简报的稿子去问
 *   「证据支撑够不够」，等于逼模型编一个不存在的标准。
 */
import type { AngleCard } from "../research/brief-store.js";
import type { SubmitPayload } from "./script-payload.js";
import type { ReviewIssue } from "./script-review.js";

/** 引文长度纪律：短到能定位、长到不含糊；进 prompt 也进校验口径 */
export const QUOTE_MIN_CHARS = 6;
export const QUOTE_MAX_CHARS = 60;

const VOICE_SAMPLE_MAX_CHARS = 300;
const RESEARCH_MAX_CHARS = 6000;

/** AI 味判据（rule 名进 issue，回看时一眼知道被判了哪一条） */
const STYLE_RULES = [
  "排比轰炸：三句以上同构短句连排，气势盖过信息",
  "总分总：开头预告要讲三点、中间编号列举、结尾再总结一遍",
  "空转折：「值得一提的是」「不难发现」「换句话说」这类不带新信息的连接词",
  "段落等长：每段字数齐得反常，读起来像模板填空（人写的段落长短参差）",
  "观点对称摆放：凡事都「一方面…另一方面…」，把判断稀释成两边都对",
  "套话堆砌：赋能/闭环/生态/全方位/多维度这类没有具体所指的词",
  "结尾升华：最后一段脱离本文事实，拔高到时代与趋势",
  "无人称的泛泛而谈：整段没有具体的人、事、数字、场景",
];

/** 洞察深度判据（只在给了调研材料时启用） */
const DEPTH_RULES = [
  "信息罗列无论点：把材料摆了一排，读完不知道作者主张什么",
  "论点只是材料复述：所谓观点就是把调研材料换个说法说一遍，没有作者的判断",
  "证据与论点脱节：引了数字/案例，但它并不支撑上下文那句话",
  "关键主张裸奔：最重要的那句判断没有任何材料或经验支撑",
];

/**
 * 有选定角度卡时**加挂**的判据（角度卡 spec §1.5 / 审稿 §2.4）。
 * 写稿前定了论点与禁区，验收就该按那两样验——「有没有论点」这种通用问法这时候太软了。
 */
const ANGLE_DEPTH_RULES = [
  "thesis 没被论证：全文没有把【本稿切入点】里那句核心论点立住，只是绕着它说了些相关的话",
  "论点被稀释：写着写着回到面面俱到，最后没有一个明确主张——选角度就是为了不这样",
  "闯进禁区：写了 antiScope 里明确说不写的东西（哪怕写得不错，也是跑题）",
  "证据没落到论点上：引了 coreEvidence，但它支撑的不是这个论点",
  "受众痛点落空：全文没有打中 audiencePain 说的那个具体处境",
];

function ruleLines(rules: string[]): string {
  return rules.map((r) => `- ${r}`).join("\n");
}

export function buildReviewSystemPrompt(hasResearch: boolean, hasAngle = false): string {
  return [
    "你是这位创作者内容团队里的审稿人。你的职责不是润色，是**判断这稿能不能发**。",
    "读完全文后给一次结论，逐条指出问题——每条都要能在原文里指到位置，指不到就不要提。",
    "",
    "## 判据一：AI 味（结构与语感）",
    ruleLines(STYLE_RULES),
    "",
    hasResearch
      ? [
          "## 判据二：洞察深度（本稿带了调研材料，这一类要判）",
          ruleLines(DEPTH_RULES),
          ...(hasAngle
            ? [
                "",
                "本稿写作前已经定了切入点（见下方【本稿切入点】），所以深度按它验收——判据加严：",
                ruleLines(ANGLE_DEPTH_RULES),
              ]
            : []),
        ].join("\n")
      : [
          "## 判据二：洞察深度——本轮**不判**",
          "本稿没有调研材料。没有材料就没有「证据是否支撑论点」的判定基准，",
          "不要凭空要求作者补数据、补案例、补出处，也不要因此给出 blocker。只判 AI 味。",
        ].join("\n"),
    "",
    "## 严重程度",
    "- blocker：不改这一处，这稿就不该发。修订轮只处理 blocker，所以别把口味偏好塞进来。",
    "- advisory：改了更好，不改也能发。会原样透给创作者，不会打回重写。",
    "",
    "## 输出",
    "调用 submit_review 一次交齐，不要在普通回复里写评语。",
    `每条 issue 的 quote 必须是从稿件里**逐字复制**的 ${QUOTE_MIN_CHARS}~${QUOTE_MAX_CHARS} 字片段`,
    "（一个字都不能改写、不能拼接跨段的两截），代码会回原文校验，找不到就整条作废。",
    "instruction 写「怎么改」，不是「哪里不好」——写稿的人拿它直接下笔。",
    "全文没有 blocker 就给 verdict=pass；有 blocker 给 verdict=revise。",
  ].join("\n");
}

export interface ReviewUserInput {
  payload: SubmitPayload;
  humanizedText: string;
  researchSlot?: string;
  /** 本稿写作前选定的角度卡；缺席时整块不出现，输出与无角度阶段逐字一致 */
  angle?: AngleCard;
  voiceSamples: string[];
  platform: string;
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

/** 角度材料块：只交判定基准（论点/禁区/受众痛点），不重复贴证据——那在调研材料块里 */
function angleBlock(card: AngleCard): string[] {
  return [
    "【本稿切入点（写作前已选定，深度判据的基准）】",
    `切入点：${card.angle}`,
    `核心论点（全稿必须论证它）：${card.thesis}`,
    `禁区（这一稿明确不写）：${card.antiScope}`,
    `目标受众痛点：${card.audiencePain}`,
    `预期停留触发：${card.holdTrigger}`,
    "",
  ];
}

/**
 * 审稿材料（§2.4）：终稿全文 + 本稿注入过的调研材料 + 选中角度卡 + 声音样本。
 * 角度卡在时，「论点论证了吗、禁区守住了吗」才是深度判据的基准；缺席时整块不出现，
 * 判据表也随之只留通用深度项——没给材料的维度不判。
 */
export function buildReviewUserMessage(input: ReviewUserInput): string {
  const parts = [
    `目标平台：${input.platform}`,
    "",
    "【待审稿件·全文（正则去 AI 味后的终稿形态）】",
    `标题：${input.payload.title}`,
    input.humanizedText,
    "",
  ];
  if (input.angle) parts.push(...angleBlock(input.angle));
  if (input.researchSlot?.trim()) {
    parts.push(
      "【本稿写作时用的调研材料（引文与数据的出处，判「证据是否支撑论点」用它）】",
      clamp(input.researchSlot.trim(), RESEARCH_MAX_CHARS),
      "",
    );
  } else {
    parts.push("【调研材料】无——本稿是没有材料写的，不判证据深度，只判 AI 味。", "");
  }
  const samples = input.voiceSamples.filter((s) => s.trim() !== "");
  if (samples.length > 0) {
    parts.push("【创作者本人写的段落（判「像不像同一个人」的基准，不是判「写得好不好」）】");
    samples.forEach((s, i) => parts.push(`【样本 ${i + 1}】${clamp(s.trim(), VOICE_SAMPLE_MAX_CHARS)}`));
    parts.push("");
  }
  parts.push("读完调用 submit_review 交结论。");
  return parts.join("\n");
}

/**
 * 修订轮的 user message（§2.2）：system 复用写稿那一份（人格、包规则、gate 阈值都在里面），
 * 这里只交待「改哪儿」。advisory 不进来——修订轮只处理 blocker，否则就是无限润色。
 */
export function buildRevisionUserMessage(
  payload: SubmitPayload,
  blockers: ReviewIssue[],
  originalUser: string,
): string {
  const issues = blockers.map(
    (issue, i) => `${i + 1}. 【${issue.rule}】原文：「${issue.quote}」\n   怎么改：${issue.instruction}`,
  );
  return [
    originalUser,
    "",
    "————",
    "上面是这稿的原始任务书。你已经写完一稿，审稿人指出了下面这些**必须修**的问题：",
    "",
    issues.join("\n"),
    "",
    "【当前稿】",
    `标题：${payload.title}`,
    `开篇：${payload.hook}`,
    `正文：\n${payload.body}`,
    `结尾：${payload.cta}`,
    `话题标签：${payload.hashtags.join(" ")}`,
    "",
    "围绕上面这些问题修订，其余部分保持原样——没被点名的段落、事实、数据一律不要改写，",
    "更不要借机重写全篇。修完调用 submit_script 交完整成稿（全文重交，不是只交改动段）。",
  ].join("\n");
}
