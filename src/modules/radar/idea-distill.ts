/**
 * 碎片灵感提炼（「＋新想法」）——用户丢来一段几百字的碎碎念，提炼成【一个】能直接用的选题。
 *
 * 为什么不复用 judgeRelevance:输入语义不同。雷达是「一堆外部候选里挑哪条值得写」，会淘汰；
 * 这里是「用户已经想写了，帮他把话说清楚」——只提炼不淘汰，只忠于原文不脑补，永远只出一个选题
 * （拆成多个等于把用户的一个想法打碎，看板上更难用）。
 *
 * 契约同 judgeRelevance:引擎不可用/模型没提交工具 → 返回 null，调用方照原文落库。
 * 提炼失败绝不能吃掉用户的灵感——这是这条链上最不能丢的东西。
 */
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import { loadProfile, personaSummary, goalSummary } from "../profile/creator-profile.js";
import type { TopicScoreBreakdown } from "./relevance.js";

/** 原文进 prompt 前的截断上限:几百字是常态，超出的多半是整篇粘贴的材料，前 4000 字足够提炼 */
const RAW_TEXT_MAX = 4000;

export interface DistilledIdea {
  /** 提炼出的可直接用的选题标题 */
  title: string;
  /** 忠于原文的核心提炼，80-180 字 */
  summary: string;
  angles: string[];
  scoreBreakdown: TopicScoreBreakdown;
  /** 四维相加，服务端重算，不信任模型自报总分 */
  totalScore: number;
}

const SYSTEM_PROMPT = [
  "你是中文新媒体选题总监。用户丢来一段自己的碎片化想法，把它提炼成【一个】能直接用的爆款选题——不是拆成多个，也不是复述原文。",
  "title 12-30 字，具体、有钩子，保留原文里的产品/公司/人名等专名；不夸张、不加原文里没有的结论或数据。",
  "summary 80-180 字，提炼 TA 真正想说的核心和手上已有的材料；忠于原文，不脑补。",
  "angles 给 3 个可以直接展开成内容的中文角度。",
  "四维评分 100 分制:受众/定位契合 0-30;材料支撑度 0-25;差异化空间 0-25;时效价值 0-20。",
  "注意:这是用户自己的想法，评分只作参考、不做淘汰——分低也照样提交，不要因为分低就不调工具。",
  "直接调用 submit_topic 一次提交，不要输出工具之外的文字。",
].join("\n");

function clamp(value: unknown, max: number): number {
  return Math.max(0, Math.min(max, Number(value)));
}

/** 提炼工具:一次只收一个选题。防御风格同 relevance 的 buildContentTool——空标题宁可退回重试。 */
function buildDistillTool(captured: { idea: DistilledIdea | null }): LoopTool {
  return {
    name: "submit_topic",
    description: "提交从用户碎片想法里提炼出的那一个选题。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "选题标题，12-30 字，具体有钩子，保留产品/公司专名" },
        summary: { type: "string", description: "80-180 字，提炼用户想说的核心与已有材料；忠于原文，不脑补" },
        angles: { type: "array", items: { type: "string" }, description: "3 个可以直接展开成内容的中文角度" },
        audience_fit: { type: "number", description: "受众/定位契合度 0-30" },
        material_richness: { type: "number", description: "原文材料能否支撑成稿 0-25" },
        novelty: { type: "number", description: "是否有差异化观点空间 0-25" },
        timeliness: { type: "number", description: "时效价值 0-20" },
      },
      required: ["title", "summary", "angles", "audience_fit", "material_richness", "novelty", "timeliness"],
    },
    execute(args) {
      const title = String(args.title ?? "").trim().slice(0, 60);
      if (!title) return "Error: title 不能为空,请重新调用 submit_topic";
      const breakdown: TopicScoreBreakdown = {
        audienceFit: clamp(args.audience_fit, 30),
        materialRichness: clamp(args.material_richness, 25),
        novelty: clamp(args.novelty, 25),
        timeliness: clamp(args.timeliness, 20),
      };
      if (!Object.values(breakdown).every(Number.isFinite)) return "Error: 四维分必须是数字,请重新调用 submit_topic";
      captured.idea = {
        title,
        summary: String(args.summary ?? "").trim().slice(0, 500),
        angles: Array.isArray(args.angles)
          ? args.angles.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 3)
          : [],
        scoreBreakdown: breakdown,
        totalScore: Math.round(Object.values(breakdown).reduce((sum, n) => sum + n, 0)),
      };
      return "已收到选题";
    },
  };
}

/** 定位/受众/目标注入:同一段想法，对不同定位的创作者该提炼出不同的钩子。无档案照常提炼。 */
async function profileContext(dataDir?: string): Promise<string> {
  try {
    const profile = await loadProfile(dataDir);
    const audience = personaSummary(profile?.audiencePersona);
    const goal = goalSummary(profile?.goal);
    return [
      profile?.industry?.trim() ? `创作者定位:${profile.industry.trim()}` : "",
      audience ? `受众:${audience}` : "",
      goal ? `创作者目标:${goal}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

export async function distillIdeaTopic(
  rawText: string,
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<DistilledIdea | null> {
  const raw = rawText.trim().slice(0, RAW_TEXT_MAX);
  if (!raw) return null;

  let scout;
  try {
    const config = await loadEngineConfig(dataDir);
    scout = resolveEngineRoute(config, "scout", config.strongModel);
  } catch {
    return null; // 无引擎配置/路由 → 调用方照原文落库
  }

  const context = await profileContext(dataDir);
  const captured: { idea: DistilledIdea | null } = { idea: null };
  try {
    await (deps?.runLoopImpl ?? runLoop)(scout.config, {
      model: scout.model,
      systemPrompt: SYSTEM_PROMPT,
      userMessage: `${context ? `${context}\n\n` : ""}用户的碎片想法原文:\n${raw}`,
      tools: [buildDistillTool(captured)],
      maxTurns: 4,
      logMeta: { agent: "scout" },
    });
  } catch {
    return null;
  }
  return captured.idea; // 没提交 → null,契约同 judgeRelevance
}
