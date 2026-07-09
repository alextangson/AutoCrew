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
import { loadEngineConfig } from "../../engine/config.js";
import { loadProfile, goalSummary } from "../profile/creator-profile.js";

export interface RelevanceVerdict {
  index: number;
  /** 0-10:该选题对这个定位的创作者值不值得写 */
  score: number;
  /** 一句「为什么值得写」——直接作为灵感卡入库理由 */
  reason: string;
}

const MAX_CANDIDATES = 24;

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
              score: { type: "number", description: "0-10,值不值得该创作者写" },
              reason: { type: "string", description: "score>=6 时必填:一句为什么值得写,写给创作者看" },
            },
            required: ["index", "score"],
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
        const score = Number(v.score);
        if (!Number.isInteger(index) || index < 0 || index >= poolSize) continue;
        if (!Number.isFinite(score)) continue;
        out.push({ index, score: Math.max(0, Math.min(10, score)), reason: String(v.reason ?? "").trim() });
      }
      captured.verdicts = out;
      return "已收到评分";
    },
  };
}

export async function judgeRelevance(
  positioning: string,
  audience: string,
  candidates: Array<{ title: string; source: string }>,
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

  const list = pool.map((c, i) => `${i}. ${c.title}（${c.source}）`).join("\n");
  try {
    await loopFn(config, {
      model: config.fastModel,
      systemPrompt: [
        "你是一位内容策划。判断每条候选选题对这位创作者值不值得写,逐条打分 0-10。",
        "评分标准:与定位/受众的相关性、可写出差异化观点的空间、时效价值。",
        "宁缺勿滥:只是泛热点、与定位无关的,给低分。score>=6 的必须附 reason(一句「为什么值得你写」,口吻写给创作者)。",
        "完成后调用 submit_relevance 提交全部评分。",
      ].join("\n"),
      userMessage: `创作者定位:${positioning}${audience ? `\n受众:${audience}` : ""}${goal ? `\n创作者目标:${goal}(能推进目标的选题优先)` : ""}\n\n候选:\n${list}`,
      tools: [submitTool],
      maxTurns: 3,
      logMeta: { agent: "scout" },
    });
  } catch {
    return null; // 调用失败 → 回退,不断链
  }
  return captured.verdicts; // 模型没提交 → null → 回退
}
