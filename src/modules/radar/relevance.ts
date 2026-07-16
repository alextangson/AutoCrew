/**
 * 候选相关性语义评分（IA v4.2 工程线:入库过滤从「关键词子串命中」升级为语义判断）。
 *
 * 为什么:关键词匹配只对「AI」这类会出现在标题里的缩写生效;定位是「职场成长」「母婴育儿」
 * 的创作者,标题里几乎不会出现定位原词——机械过滤直接归零。语义评分对任意定位成立,
 * 且顺手产出真正的入库理由（「为什么值得你写」,取代模板拼接）。
 *
 * 契约:LLM 不可用（无引擎配置/调用失败）返回 null——调用方回退机械过滤,链不断。
 */
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import { loadProfile, goalSummary } from "../profile/creator-profile.js";

export interface RelevanceVerdict {
  index: number;
  /** 0-10:该选题对这个定位的创作者值不值得写 */
  score: number;
  /** 0-100：四个维度相加，服务端重算，不信任模型自报总分。 */
  totalScore: number;
  scoreBreakdown?: TopicScoreBreakdown;
  /** 一句「为什么值得写」——直接作为灵感卡入库理由 */
  reason: string;
  /** 面向中文创作者重写后的选题名，不是生硬直译。 */
  titleZh?: string;
  /** 只基于输入标题/摘要生成的中文事实摘要。 */
  summaryZh?: string;
  /** 可以直接派给写手的差异化内容角度。 */
  angles?: string[];
}

export interface TopicScoreBreakdown {
  audienceFit: number;
  materialRichness: number;
  novelty: number;
  timeliness: number;
}

// 结构化评分字段较多；单批过大会导致模型长思考或漏调工具。8 条兼顾吞吐与交互时延。
// 评判上限压到 4:实测这条模型/线路对「一次性提交多条含中文标题+摘要+角度的富评分」有可靠性墙,
// 8 条常 narrate 到 maxTurns 也提交不了(→null→退化关键词)。4 条稳过。彻底解法见 two-stage(待办)。
const MAX_CANDIDATES = 4;

function buildSubmitTool(captured: { verdicts: RelevanceVerdict[] | null }, poolSize: number): LoopTool {
  return {
    name: "submit_relevance",
    description: "提交每条候选的相关性评分。",
    parameters: {
      type: "object",
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number", description: "候选编号（输入列表中的 index）" },
              title_zh: { type: "string", description: "自然中文选题名，12-30 字；英文原标题要转成可发布的中文选题，不是逐字翻译" },
              summary_zh: { type: "string", description: "80-180 字中文事实摘要：发生了什么、为什么与受众有关；证据不足要明说" },
              angles: { type: "array", items: { type: "string" }, description: "3 个可以直接展开成内容的中文角度" },
              breakdown: {
                type: "object",
                properties: {
                  audience_fit: { type: "number", description: "受众/定位契合度 0-30" },
                  material_richness: { type: "number", description: "现有证据能否支撑成稿 0-25" },
                  novelty: { type: "number", description: "是否有差异化观点空间 0-25" },
                  timeliness: { type: "number", description: "时效价值 0-20" },
                },
                required: ["audience_fit", "material_richness", "novelty", "timeliness"],
              },
              reason: { type: "string", description: "一句为什么值得或不值得这位创作者写" },
            },
            required: ["index", "title_zh", "summary_zh", "angles", "breakdown", "reason"],
          },
        },
      },
      required: ["verdicts"],
    },
    execute(args) {
      if (!Array.isArray(args.verdicts)) return "Error: verdicts 应为数组,请重新调用 submit_relevance";
      const out: RelevanceVerdict[] = [];
      for (const v of args.verdicts as Array<Record<string, unknown>>) {
        const index = Number(v.index);
        if (!Number.isInteger(index) || index < 0 || index >= poolSize) continue;
        const raw = v.breakdown as Record<string, unknown> | undefined;
        const values = raw
          ? {
              audienceFit: Math.max(0, Math.min(30, Number(raw.audience_fit))),
              materialRichness: Math.max(0, Math.min(25, Number(raw.material_richness))),
              novelty: Math.max(0, Math.min(25, Number(raw.novelty))),
              timeliness: Math.max(0, Math.min(20, Number(raw.timeliness))),
            }
          : null;
        const validBreakdown = values && Object.values(values).every(Number.isFinite) ? values : undefined;
        // 兼容旧测试/旧中转返回的 score:没有 breakdown 时仍可消费，但新主路永远以四维总和为准。
        const legacyScore = Number(v.score);
        const totalScore = validBreakdown
          ? Math.round(Object.values(validBreakdown).reduce((sum, n) => sum + n, 0))
          : Number.isFinite(legacyScore)
            ? Math.round(Math.max(0, Math.min(10, legacyScore)) * 10)
            : 0;
        const angles = Array.isArray(v.angles)
          ? v.angles.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 3)
          : [];
        out.push({
          index,
          score: totalScore / 10,
          totalScore,
          ...(validBreakdown ? { scoreBreakdown: validBreakdown } : {}),
          reason: String(v.reason ?? "").trim(),
          ...(String(v.title_zh ?? "").trim() ? { titleZh: String(v.title_zh).trim().slice(0, 60) } : {}),
          ...(String(v.summary_zh ?? "").trim() ? { summaryZh: String(v.summary_zh).trim().slice(0, 500) } : {}),
          ...(angles.length ? { angles } : {}),
        });
      }
      captured.verdicts = out;
      return "已收到评分";
    },
  };
}

export async function judgeRelevance(
  positioning: string,
  audience: string,
  candidates: Array<{ title: string; source: string; description?: string }>,
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<RelevanceVerdict[] | null> {
  if (candidates.length === 0) return [];
  let config;
  try {
    config = await loadEngineConfig(dataDir);
  } catch {
    return null; // 无引擎配置 → 回退机械过滤
  }

  const pool = candidates.slice(0, MAX_CANDIDATES);
  const captured: { verdicts: RelevanceVerdict[] | null } = { verdicts: null };
  const submitTool = buildSubmitTool(captured, pool.length);
  const loopFn = deps?.runLoopImpl ?? runLoop;

  // 目标注入(V5.6 /goal):能推进目标的选题优先——自含加载,零调用方改动
  let goal = "";
  try {
    goal = goalSummary((await loadProfile(dataDir))?.goal);
  } catch {
    /* 无档案照常评分 */
  }

  const list = pool
    .map((c, i) => `${i}. 原标题:${c.title}\n来源:${c.source}\n已有摘要:${c.description?.trim() || "(无摘要，材料支撑度应低分)"}`)
    .join("\n\n");
  try {
    const scout = resolveEngineRoute(config, "scout", config.strongModel);
    await loopFn(scout.config, {
      model: scout.model,
      systemPrompt: [
        "你是中文新媒体选题总监。逐条把原始情报加工成真正能写的中文选题，并做四维评分。",
        "评分必须严格相加为 100 分制：受众/定位契合 0-30；材料支撑度 0-25；差异化空间 0-25；时效价值 0-20。",
        "材料支撑度看输入里是否已有事实、产品能力、数字或事件脉络；只有英文项目名或一句标题、没有摘要的，不能给高分。",
        "title_zh 要像创作者会真的发布的中文选题，保留关键产品/公司专名，但不能整句英文，也不能只是逐字翻译。",
        "summary_zh 与 angles 只能根据输入事实生成；证据不足就写清还需要查什么，禁止脑补功能、数据或结论。",
        "宁缺勿滥：泛热点、与受众无关、没有材料可展开的都应低分。",
        "直接调用 submit_relevance 一次性提交全部候选的评分——不要在工具之外先逐条输出分析文字，那会拖慢并常常导致没提交就结束。评分理由写进每条的 reason 字段即可。",
      ].join("\n"),
      userMessage: `创作者定位:${positioning}${audience ? `\n受众:${audience}` : ""}${goal ? `\n创作者目标:${goal}(能推进目标的选题优先)` : ""}\n\n候选:\n${list}`,
      tools: [submitTool],
      maxTurns: 5,
      logMeta: { agent: "scout" },
    });
  } catch {
    return null; // 调用失败 → 回退,不断链
  }
  return captured.verdicts; // 模型没提交 → null → 回退
}
