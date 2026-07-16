/**
 * 候选相关性语义评分（两阶段）。
 *
 * 为什么两阶段:让模型一次性对多条候选同时产「中文标题+摘要+角度+四维分」这种富输出,
 * 会撞可靠性墙——模型 narrate 到 maxTurns 也提交不了工具(→null→退化关键词)。拆开:
 *   Stage 1 粗筛——只产四维数字分,输出极轻,可靠覆盖 ~20 条;
 *   Stage 2 精修——只对高分 top N 生成中文文案,富输出但量小,稳定提交。
 *
 * 关键词匹配只对「AI」这类会出现在标题里的缩写生效;定位是「职场成长」「母婴育儿」的创作者,
 * 标题几乎不含定位原词——机械过滤直接归零。语义评分对任意定位成立,顺手产出真正的入库理由。
 *
 * 契约:LLM 不可用/任一阶段没提交 → 返回 null,调用方回退机械过滤,链不断。
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

const STAGE1_MAX = 20; // 粗筛只产数字,可覆盖更多候选
const STAGE2_MAX = 5; // 精修产富文案,只对高分少数,保证可靠提交
// 精修门槛:对齐 radar-intake 的入库阈值(RELEVANCE_THRESHOLD 7 → 70),低于此不值得花精修,也不会入库。
const STAGE2_MIN_SCORE = 70;

interface Stage1Score {
  index: number;
  breakdown: TopicScoreBreakdown;
  totalScore: number;
}

interface Stage2Content {
  index: number;
  titleZh: string;
  summaryZh?: string;
  angles?: string[];
  reason: string;
}

function clamp(value: unknown, max: number): number {
  return Math.max(0, Math.min(max, Number(value)));
}

/** Stage 1 工具:只收四维数字分。输出轻 → 可靠覆盖 ~20 条。 */
function buildScoreTool(captured: { scores: Stage1Score[] | null }, poolSize: number): LoopTool {
  return {
    name: "submit_scores",
    description: "提交每条候选的四维评分（只打分，不写文案）。",
    parameters: {
      type: "object",
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number", description: "候选编号（输入列表中的 index）" },
              audience_fit: { type: "number", description: "受众/定位契合度 0-30" },
              material_richness: { type: "number", description: "现有证据能否支撑成稿 0-25" },
              novelty: { type: "number", description: "是否有差异化观点空间 0-25" },
              timeliness: { type: "number", description: "时效价值 0-20" },
            },
            required: ["index", "audience_fit", "material_richness", "novelty", "timeliness"],
          },
        },
      },
      required: ["scores"],
    },
    execute(args) {
      if (!Array.isArray(args.scores)) return "Error: scores 应为数组,请重新调用 submit_scores";
      const out: Stage1Score[] = [];
      for (const v of args.scores as Array<Record<string, unknown>>) {
        const index = Number(v.index);
        if (!Number.isInteger(index) || index < 0 || index >= poolSize) continue;
        const breakdown: TopicScoreBreakdown = {
          audienceFit: clamp(v.audience_fit, 30),
          materialRichness: clamp(v.material_richness, 25),
          novelty: clamp(v.novelty, 25),
          timeliness: clamp(v.timeliness, 20),
        };
        if (!Object.values(breakdown).every(Number.isFinite)) continue;
        out.push({ index, breakdown, totalScore: Math.round(Object.values(breakdown).reduce((sum, n) => sum + n, 0)) });
      }
      captured.scores = out;
      return "已收到评分";
    },
  };
}

/** Stage 2 工具:给选定候选产中文文案。量小 → 富输出也能稳定提交。 */
function buildContentTool(captured: { content: Stage2Content[] | null }, poolSize: number): LoopTool {
  return {
    name: "submit_content",
    description: "给选定的候选生成可发布的中文选题文案。",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number", description: "候选编号（输入列表中的 index）" },
              title_zh: { type: "string", description: "自然中文选题名，12-30 字；英文原标题要转成可发布的中文选题，不是逐字翻译" },
              summary_zh: { type: "string", description: "80-180 字中文事实摘要：发生了什么、为什么与受众有关；证据不足要明说" },
              angles: { type: "array", items: { type: "string" }, description: "3 个可以直接展开成内容的中文角度" },
              reason: { type: "string", description: "一句为什么值得这位创作者写" },
            },
            required: ["index", "title_zh", "summary_zh", "angles", "reason"],
          },
        },
      },
      required: ["items"],
    },
    execute(args) {
      if (!Array.isArray(args.items)) return "Error: items 应为数组,请重新调用 submit_content";
      const out: Stage2Content[] = [];
      for (const v of args.items as Array<Record<string, unknown>>) {
        const index = Number(v.index);
        if (!Number.isInteger(index) || index < 0 || index >= poolSize) continue;
        const titleZh = String(v.title_zh ?? "").trim().slice(0, 60);
        if (!titleZh) continue; // 没中文标题不入库(英文原标题污染灵感库)
        const angles = Array.isArray(v.angles)
          ? v.angles.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 3)
          : [];
        const summaryZh = String(v.summary_zh ?? "").trim().slice(0, 500);
        out.push({
          index,
          titleZh,
          reason: String(v.reason ?? "").trim(),
          ...(summaryZh ? { summaryZh } : {}),
          ...(angles.length ? { angles } : {}),
        });
      }
      captured.content = out;
      return "已收到文案";
    },
  };
}

function candidateList(items: Array<{ idx: number; title: string; source: string; description?: string }>): string {
  return items
    .map((c) => `${c.idx}. 原标题:${c.title}\n来源:${c.source}\n已有摘要:${c.description?.trim() || "(无摘要，材料支撑度应低分)"}`)
    .join("\n\n");
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

  const pool = candidates.slice(0, STAGE1_MAX);
  const loopFn = deps?.runLoopImpl ?? runLoop;

  // 目标注入(V5.6 /goal):能推进目标的选题优先——自含加载,零调用方改动
  let goal = "";
  try {
    goal = goalSummary((await loadProfile(dataDir))?.goal);
  } catch {
    /* 无档案照常评分 */
  }
  const context = `创作者定位:${positioning}${audience ? `\n受众:${audience}` : ""}${goal ? `\n创作者目标:${goal}(能推进目标的选题优先)` : ""}`;

  let scout;
  try {
    scout = resolveEngineRoute(config, "scout", config.strongModel);
  } catch {
    return null;
  }

  // ── Stage 1:四维数字粗筛 ────────────────────────────────────────────────
  const cap1: { scores: Stage1Score[] | null } = { scores: null };
  const scoreTool = buildScoreTool(cap1, pool.length);
  const stage1List = candidateList(pool.map((c, i) => ({ idx: i, ...c })));
  try {
    await loopFn(scout.config, {
      model: scout.model,
      systemPrompt: [
        "你是中文新媒体选题总监。为每条候选做四维评分,判断它对这个定位的创作者值不值得写。",
        "100 分制:受众/定位契合 0-30;材料支撑度 0-25(只有英文项目名或一句话、没有摘要的给低分);差异化空间 0-25;时效价值 0-20。",
        "宁缺勿滥:泛热点、与受众无关、没有材料可展开的都给低分。",
        "直接调用 submit_scores 一次性提交全部候选的四维数字分,不要输出任何分析文字。",
      ].join("\n"),
      userMessage: `${context}\n\n候选:\n${stage1List}`,
      tools: [scoreTool],
      maxTurns: 4,
      logMeta: { agent: "scout" },
    });
  } catch {
    return null;
  }
  if (!cap1.scores) return null; // 粗筛没提交 → 回退
  const selected = cap1.scores
    .filter((s) => s.totalScore >= STAGE2_MIN_SCORE)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, STAGE2_MAX);
  if (selected.length === 0) return []; // 没有够格的 → 正常空结果,不是失败

  // ── Stage 2:高分候选精修中文文案 ────────────────────────────────────────
  const cap2: { content: Stage2Content[] | null } = { content: null };
  const contentTool = buildContentTool(cap2, pool.length);
  const stage2List = candidateList(selected.map((s) => ({ idx: s.index, ...pool[s.index] })));
  try {
    await loopFn(scout.config, {
      model: scout.model,
      systemPrompt: [
        "你是中文新媒体选题总监。把选定的高相关候选加工成能直接发布的中文选题。",
        "title_zh 12-30 字,像创作者会真发的中文选题,保留关键产品/公司专名;英文原标题转成中文,不逐字翻译。",
        "summary_zh 80-180 字,只根据输入事实;证据不足写清还需查什么,禁止脑补功能、数据或结论。",
        "angles 给 3 个可直接展开成内容的中文角度。",
        "直接调用 submit_content 一次性提交全部文案,不要输出工具之外的文字。",
      ].join("\n"),
      userMessage: `${context}\n\n要加工的候选:\n${stage2List}`,
      tools: [contentTool],
      maxTurns: 4,
      logMeta: { agent: "scout" },
    });
  } catch {
    return null;
  }
  if (!cap2.content) return null; // 精修没提交 → 回退

  const contentByIndex = new Map(cap2.content.map((c) => [c.index, c]));
  return selected
    .map((s): RelevanceVerdict | null => {
      const c = contentByIndex.get(s.index);
      if (!c) return null; // 精修漏了这条 → 丢弃,不存半成品
      return {
        index: s.index,
        score: s.totalScore / 10,
        totalScore: s.totalScore,
        scoreBreakdown: s.breakdown,
        reason: c.reason,
        titleZh: c.titleZh,
        ...(c.summaryZh ? { summaryZh: c.summaryZh } : {}),
        ...(c.angles ? { angles: c.angles } : {}),
      };
    })
    .filter((v): v is RelevanceVerdict => v !== null);
}
