/**
 * 审稿 agent 的 prompt（审稿 spec §2.3/§2.4）——判据表与材料装配都在这儿，
 * 收敛循环在 script-review.ts。分文件只为一件事：判据是会长期演化的内容资产，
 * 状态机不该被它撑到读不动。
 *
 * 判据两类：
 * - **表达**：结合用户规划、语境与声音样本判断；humanizer 只清理空白，不替审稿做语义改写。
 * - **洞察深度**：只有给了材料才判（§2.4「没给材料的维度不判」）。没有简报的稿子去问
 *   「证据支撑够不够」，等于逼模型编一个不存在的标准。
 */
import { isAngleCardV3, type AngleCard, type AngleCardV3 } from "../research/brief-store.js";
// v2/v3 联合卡的兼容读法（v3 判据是 P1c 的审稿第三类判据）
import { cardAudiencePain, cardHoldTrigger } from "../research/angle-cards.js";
import { DEFAULT_PERSONAS } from "../research/personas.js";
import { STRUCTURE_MENU } from "../research/angle-stage.js";
import type { SubmitPayload } from "./script-payload.js";
import { WRITING_PRIORITY } from "./script-prompt.js";
import type { ReviewIssue } from "./script-review.js";

/** 引文长度纪律：短到能定位、长到不含糊；进 prompt 也进校验口径 */
export const QUOTE_MIN_CHARS = 6;
export const QUOTE_MAX_CHARS = 60;

const VOICE_SAMPLE_MAX_CHARS = 300;

/** AI 味判据（rule 名进 issue，回看时一眼知道被判了哪一条） */
const STYLE_RULES = [
  "排比盖过信息：重复句式没有带来内容增量；有目的的排比不单凭句式判错",
  "重复预告与总结：开头、正文和结尾反复说同一内容；用户选定的清单或总分结构本身不是问题",
  "空转折：「值得一提的是」「不难发现」「换句话说」这类不带新信息的连接词",
  "模板填充：为维持段落形式加入重复或无关内容；不以段落是否等长作为判错依据",
  "观点对称摆放：凡事都「一方面…另一方面…」，把判断稀释成两边都对",
  "套话堆砌：赋能/闭环/生态/全方位/多维度这类没有具体所指的词",
  "结尾升华：最后一段脱离本文事实，拔高到时代与趋势",
  "泛泛而谈：抽象判断缺少必要的解释或相关材料，读者无法理解具体所指；不强制第一人称或数字",
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

/** 主画像那一行：审稿人要「代入这个人」读一遍，所以画像给全（是谁 / 处境 / 要做的动作） */
function personaLine(card: AngleCardV3): string {
  const p = DEFAULT_PERSONAS[card.primaryPersona];
  return `${p.name}——${p.who}。他走进来时的处境：${p.state}。他看完该做的动作：${p.action}`;
}

/**
 * 判据三「立意执行」（P1 §4.5 / 角度卡 spec §7.5），**只在 v3 立意卡在场时启用**。
 *
 * 为什么它不能写成一张通用判据表：这一类判的全是「稿子有没有兑现这张卡」——
 * 主画像、误区、机制、收获感、最小动作都是**这一张卡上的具体文字**，
 * 抽象成「有没有打中受众」就退回成判据二那种软问法，而 P0c 的分水岭恰恰在这几条上：
 * 可发的三稿都把机制的因果讲透了，被否的都断在「只剩比喻」。
 */
function angleExecutionSection(card: AngleCardV3, needsHumanNumbers: string[]): string[] {
  const blockers = [
    `主张没有落实：全文没有解释或论证「${card.thesis}」，或擅自换成另一个主张`,
    `收获感没兑现：读完没有获得卡上承诺的理解或判断「${card.payoff}」；收获不等于必须立即行动`,
    `机制解释不足：「${card.mechanism}」只剩比喻，相关因果没有解释清楚，或因果说法与材料相矛盾`,
    `闯进禁区：写了卡上 antiScope 明说不写的东西「${card.antiScope}」（哪怕写得不错，也是跑题）`,
    ...(card.structure === "myth-busting"
      ? [`纠偏没有成立：选定结构要讨论误区「${card.misconception}」，却没有按材料解释它为何不成立；不规定开头位置、不要求反问`] : []),
  ];
  const advisories = [
    `表达参考（不按数量验收）：${card.elements.join("、")}；不为命中元素要求添加转折或数据`,
    `可选行动建议：${card.nextAction}；用户未要求时，不因缺少 CTA 或最小动作扣分`,
    "稿里出现「[未证实]」——这不是事实证据，该删的删、该找证据的找，不能靠标注放行错误主张",
    ...(needsHumanNumbers.length > 0
      ? [`稿里有需人工过目的模糊数量词：${needsHumanNumbers.join("、")}——提醒创作者核一下，不要自己改写成精确数字`]
      : []),
    "身份表述：没有来源支持的创作者身份、学历、出身或亲历须指出证据缺口；不得为塑造人设编造事实。",
  ];
  return [
    "",
    "## 判据三：立意执行（本稿写作前定了一张立意卡，见下方【立意卡】，按卡验收）",
    `先把自己代入这个人——主画像：${personaLine(card)}`,
    `已选结构：${STRUCTURE_MENU[card.structure]}。按它的叙事或论证逻辑验收；本次写作约定优先。`,
    "读完先回答「这篇让我理解或判断了什么」。不把所有结构都改成反常识开头、反问、固定转折和行动号召。",
    "数字硬门只确认数值能在材料中找到，不能证明引用成立；仍须核查数字的对象、时间、范围、单位和上下文是否支撑原句。",
    "",
    "blocker（任一成立，这稿不该发）：",
    ruleLines(blockers),
    "",
    "advisory（提醒，不打回）：",
    ruleLines(advisories),
  ];
}

export interface ReviewPromptOptions {
  /** 本稿注入过调研材料吗——没有材料就没有「证据是否支撑论点」的判定基准（§2.4） */
  hasResearch: boolean;
  /** 创作者规划独立于调研材料：即使无调研，也要检查明确方向是否落实。 */
  hasWritingContract?: boolean;
  /** 本稿生效的角度卡：v2 走判据二加严，v3 另开判据三「立意执行」 */
  angle?: AngleCard;
  /**
   * 修订轮手上有没有 `find_evidence`（P1 §4.5 / codex #21）。
   * 有工具时「去补个数据」是可执行的指令；没工具时它只是在逼作者编——所以那条
   * 「不要凭空要求补数据」的禁令只在**没有**工具时才成立，两侧必须一致。
   */
  canFindEvidence?: boolean;
  /** 数字硬门归一不了、放行但要人工过目的量词（§4.4）：进判据三的 advisory 清单 */
  needsHumanNumbers?: string[];
}

export function buildReviewSystemPrompt(opts: ReviewPromptOptions): string {
  const { hasResearch, angle, canFindEvidence = false, needsHumanNumbers = [] } = opts;
  const hasAngle = Boolean(angle);
  const cardV3 = isAngleCardV3(angle) ? angle : null;
  return [
    "你是这位创作者内容团队里的审稿人。你的职责不是润色，是**判断这稿能不能发**。",
    "读完全文后给一次结论，逐条指出问题——每条都要能在原文里指到位置，指不到就不要提。",
    ...(opts.hasWritingContract ? [
      "",
      "## 判据零：创作者规划遵循",
      "先对照【本稿写作约定】核查受众、核心主张、必须包含/避免的内容与明确要求的篇幅和结构。",
      "遗漏明确要求、违背禁区、把本次方向改成泛泛科普，属于 blocker；quote 引用能体现偏离的原稿短句，instruction 指明对应的约定及修改方式。",
      WRITING_PRIORITY,
      "用户明确选择的结构不能仅因不符合通用模板被打回；自动提炼偏好不可升级成新的强制要求。",
      "写作约定是创作意图，不是事实证据：不得把定位、受众、修辞示例写成创作者亲身经历，也不得为兑现方向编造案例或数字。",
    ] : []),
    "",
    "## 判据一：AI 味（结构与语感）",
    "按已选结构、创作者要求和具体语境判断；词语命中、段落长度、没有提问或 CTA 本身不是缺陷。风格建议不得改变叙述者、事实主体、引文或专业术语的意思。",
    "事实纪律独立于风格：检查与现有材料矛盾、夸大或无来源的事实性归因；材料不足时说明缺口，不凭印象认可，也不要求为风格凑数字。",
    ruleLines(STYLE_RULES),
    "",
    hasResearch
      ? [
          "## 判据二：洞察深度（本稿带了调研材料，这一类要判）",
          ruleLines(DEPTH_RULES),
          // v3 卡不走这段加严：它的加严在判据三，两处都挂会让同一处毛病被判两遍
          // （「thesis 没被论证」与「主张不可反驳」几乎是同一句），白烧一轮修订。
          ...(hasAngle && !cardV3
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
          canFindEvidence
            ? "仍检查 AI 味与已有的写作约定。修订轮手上有查证工具，所以「这句判断需要一个来源」这类问题可以提，" +
              "但仍然要能在原文里逐字指到位置。"
            : "不要凭空要求作者补数据、补案例、补出处，也不要因此给出 blocker。仍检查 AI 味与已有的写作约定。",
        ].join("\n"),
    ...(cardV3 ? angleExecutionSection(cardV3, needsHumanNumbers) : []),
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
  writingContract?: string;
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

/**
 * 立意卡块 v3（P1 §4.5）：审稿人要按**这张卡**验收，不能凭印象——判据三里每一条都点名了
 * 卡上的具体文字，卡不进材料等于让模型对着自己脑补的标准打分。
 *
 * 只交判定基准，不重复贴证据（证据在调研材料块里）；标题同时含「立意卡」与「本稿切入点」，
 * 因为判据二里的通用深度项仍按同一块材料判。
 */
function angleBlockV3(card: AngleCardV3): string[] {
  return [
    "【立意卡（本稿切入点，写作前已选定；判据二与判据三都按它验收）】",
    `主画像（这一稿写给谁）：${personaLine(card)}`,
    `误区背景（纠偏结构时需回应，不限定开头位置）：${card.misconception}`,
    `核心主张（全稿必须论证它）：${card.thesis}`,
    `机制（为什么会这样，正文要讲透这条因果）：${card.mechanism}`,
    `收获感（正文必须兑现）：${card.payoff}`,
    `可选行动建议：${card.nextAction}`,
    `可参考的表达元素（不按数量验收）：${card.elements.join("、")}`,
    `已选结构：${STRUCTURE_MENU[card.structure]}`,
    `禁区（这一稿明确不写）：${card.antiScope}`,
    "",
  ];
}

/** 角度材料块：只交判定基准（论点/禁区/受众痛点），不重复贴证据——那在调研材料块里 */
function angleBlock(card: AngleCard): string[] {
  if (isAngleCardV3(card)) return angleBlockV3(card);
  return [
    "【本稿切入点（写作前已选定，深度判据的基准）】",
    `切入点：${card.angle}`,
    `核心论点（全稿必须论证它）：${card.thesis}`,
    `禁区（这一稿明确不写）：${card.antiScope}`,
    `目标受众痛点：${cardAudiencePain(card)}`,
    `预期停留触发：${cardHoldTrigger(card)}`,
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
    "【待审稿件·全文（仅清理空白，保留原文语义）】",
    `标题：${input.payload.title}`,
    input.humanizedText,
    "",
  ];
  if (input.writingContract?.trim()) {
    parts.push("【本稿写作约定（与写手收到的同一份规划，审稿按此验收）】", input.writingContract.trim(), "");
  }
  if (input.angle) parts.push(...angleBlock(input.angle));
  if (input.researchSlot?.trim()) {
    // 逐字照搬写手拿到的那份快照（P1 §4.3）：审稿从前在这里按 6000 再裁一刀，
    // 于是审稿人看到的材料比写手少，判「证据支撑住论点了吗」的基准和写作的输入
    // 不是同一份——预算已经在装配层收过口，这里不许再收一次。
    parts.push(
      "【本稿写作时用的调研材料（引文与数据的出处，判「证据是否支撑论点」用它）】",
      input.researchSlot.trim(),
      "",
    );
  } else {
    parts.push("【调研材料】无——本稿是没有材料写的，不判证据深度；已有的写作约定仍需验收。", "");
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
  writingContract?: string,
): string {
  const issues = blockers.map(
    (issue, i) => `${i + 1}. 【${issue.rule}】原文：「${issue.quote}」\n   怎么改：${issue.instruction}`,
  );
  return [
    originalUser,
    ...(writingContract?.trim() ? ["", "【本稿写作约定（修订仍须遵守）】", writingContract.trim(),
      "审稿建议不得改变创作者已经明确的方向、受众、禁区与结构；写作约定不是事实证据，不得为达成约定编造经历。"] : []),
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
