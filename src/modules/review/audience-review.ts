/**
 * 受众停留审（IA v5 V5.1）——审核员的新维度:以受众画像为标准,判断目标受众
 * 会不会为这篇稿停下滑动。顾问性质,不阻断流转(与违禁词硬门并列,性质不同):
 * 停留是编辑判断,最终裁决权在人。
 *
 * 画像未校准(calibratedAt 缺省)时拒绝执行——未经用户确认的画像不能当审稿标准。
 */
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { loadProfile, personaSummary } from "../profile/creator-profile.js";
import { TS_LENS_HINT } from "../calibration/ts-lens.js";
import type { AudiencePersona } from "../profile/creator-profile.js";

export interface TierStayVerdict {
  /** core | adjacent | surprise */
  tier: string;
  name: string;
  wouldStop: boolean;
  why: string;
  /** 会让 TA 划走的具体位置/表述(引用原文短句) */
  losesAt: string[];
}

export interface AudienceReviewResult {
  /** 三层里核心受众是否停留(总判定) */
  coreStops: boolean;
  verdicts: TierStayVerdict[];
  /** 面向修改的建议(具体到段落/表述) */
  suggestions: string[];
  /** 用的哪份画像(渲染一行,让审核透明) */
  personaUsed: string;
  /** 实际采用的受众依据；本次任务覆盖长期画像时保留逐字依据。 */
  audienceBasis?: { source: "profile" | "current_task"; quote: string };
}

function buildSubmitTool(captured: { result: Omit<AudienceReviewResult, "personaUsed"> | null }, body: string, expectedTiers: string[], writingContract: string): LoopTool {
  return {
    name: "submit_audience_review",
    description: "提交受众停留审结果。",
    parameters: {
      type: "object",
      properties: {
        audienceBasis: { type: "object", properties: { source: { type: "string", enum: ["profile", "current_task"] }, quote: { type: "string", description: "采用本次任务受众时逐字引用任务中指明受众的短句；采用档案可留空" } }, required: ["source", "quote"] },
        verdicts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tier: { type: "string", description: "core|adjacent|surprise" },
              name: { type: "string" },
              wouldStop: { type: "boolean", description: "TA 会不会停下来读完" },
              why: { type: "string", description: "一句话依据,引用画像的焦虑/触发器" },
              losesAt: { type: "array", items: { type: "string" }, description: "会让 TA 划走的原文短句(0-3 处)" },
            },
            required: ["tier", "name", "wouldStop", "why"],
          },
        },
        suggestions: { type: "array", items: { type: "string" }, description: "0-4 条修改建议,具体到位置" },
      },
      required: ["verdicts", "audienceBasis"],
    },
    execute(args) {
      const basis = args.audienceBasis as { source?: unknown; quote?: unknown } | undefined;
      if (!basis || !["profile", "current_task"].includes(String(basis.source)) || typeof basis.quote !== "string" ||
        (basis.source === "current_task" && (!basis.quote.trim() || !writingContract.includes(basis.quote)))) return "Error: 提交真实受众依据；使用本次受众须逐字引用任务中的受众说明";
      const requiredTiers = basis.source === "current_task" ? ["core"] : expectedTiers;
      const verdicts = Array.isArray(args.verdicts) ? (args.verdicts as TierStayVerdict[]) : [];
      const core = verdicts.find((v) => v.tier === "core");
      if (!core) return "Error: verdicts 必须包含 tier=core 的判定,请补全后重新调用";
      if (verdicts.length !== requiredTiers.length || new Set(verdicts.map(v => v.tier)).size !== verdicts.length || verdicts.some(v =>
        !requiredTiers.includes(v.tier) || typeof v.wouldStop !== "boolean" || typeof v.name !== "string" || !v.name.trim() || typeof v.why !== "string" || !v.why.trim() ||
        (v.losesAt !== undefined && (!Array.isArray(v.losesAt) || v.losesAt.length > 3 || v.losesAt.some(q => typeof q !== "string" || !q.trim() || !body.includes(q))))
      )) return "Error: 每个实际画像层必须有且仅有一条判定，wouldStop须为布尔值，losesAt须逐字引用稿件";
      if (args.suggestions !== undefined && (!Array.isArray(args.suggestions) || args.suggestions.length > 4 || args.suggestions.some(v => typeof v !== "string"))) return "Error: suggestions须为最多4条文字建议";
      captured.result = {
        audienceBasis: { source: basis.source as "profile" | "current_task", quote: basis.quote },
        coreStops: Boolean(core.wouldStop),
        verdicts: verdicts.map((v) => ({
          tier: String(v.tier),
          name: String(v.name ?? ""),
          wouldStop: Boolean(v.wouldStop),
          why: String(v.why ?? ""),
          losesAt: Array.isArray(v.losesAt) ? v.losesAt.map(String).slice(0, 3) : [],
        })),
        suggestions: Array.isArray(args.suggestions) ? (args.suggestions as unknown[]).map(String).slice(0, 4) : [],
      };
      return "已收到停留审结果";
    },
  };
}

export async function reviewAudienceStay(
  input: { title: string; body: string; platform?: string; writingContract?: string },
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<AudienceReviewResult> {
  const [config, profile] = await Promise.all([loadEngineConfig(dataDir), loadProfile(dataDir)]);
  const persona: AudiencePersona | null = profile?.audiencePersona ?? null;
  if (!persona?.core) {
    throw new Error("还没有受众画像——先让总编辑生成并校准画像(对话里说「校准受众画像」)");
  }
  if (!persona.calibratedAt) {
    throw new Error("画像还是提案态,未经你确认——先在对话里完成画像校准,再用它审稿");
  }

  const captured = { result: null as Omit<AudienceReviewResult, "personaUsed"> | null };
  const loopFn = deps?.runLoopImpl ?? runLoop;
  const tiers = [
    { tier: "core", t: persona.core },
    ...(persona.adjacent ? [{ tier: "adjacent", t: persona.adjacent }] : []),
    ...(persona.surprise ? [{ tier: "surprise", t: persona.surprise }] : []),
  ]
    .map(({ tier, t }) =>
      `${tier}:${t.name}${t.job ? `(${t.job})` : ""}` +
      `${t.coreAnxiety ? ` 核心焦虑:${t.coreAnxiety}` : ""}` +
      `${t.scrollStopTriggers?.length ? ` 停留触发:${t.scrollStopTriggers.join("、")}` : ""}`)
    .join("\n");

  const reviewer = resolveEngineRoute(config, "reviewer", config.strongModel);
  await loopFn(reviewer.config, {
    model: reviewer.model,
    systemPrompt:
      "你是内容审核员,专职「受众停留审」:代入给定的受众画像逐层判断——刷到这篇内容,TA 会停下来读完吗?" +
      "判断必须锚定画像的焦虑与停留触发器,不允许泛泛而谈;指出会让 TA 划走的具体原文位置。" +
      "本次创作任务优先于长期画像；若任务明确指定了不同受众，应说明差异并按本次受众点评。观点是编辑建议，不是假装实际观众测试或预测爆款。" +
      "必须提交audienceBasis。按本次任务指定的新受众审时source=current_task并逐字引用任务受众说明，只返回core判定；按档案审时source=profile并覆盖档案实际各层。" +
      TS_LENS_HINT + // 判断要对账 §七：转发尴尬尺子，只提醒
      "完成后调用 submit_audience_review 提交。",
    userMessage: `${input.writingContract ? `本次创作任务（最高优先级）:\n${input.writingContract}\n\n` : ""}受众画像:\n${tiers}\n\n待审稿件${input.platform ? `(${input.platform})` : ""}:\n标题:${input.title}\n\n${input.body}`,
    tools: [buildSubmitTool(captured, `${input.title}\n${input.body}`, ["core", ...(persona.adjacent ? ["adjacent"] : []), ...(persona.surprise ? ["surprise"] : [])], input.writingContract ?? "")],
    maxTurns: 3,
    logMeta: { agent: "review" },
  });

  if (!captured.result) {
    throw new Error("停留审失败:模型未调用 submit_audience_review 提交结果");
  }
  return { ...captured.result, personaUsed: captured.result.audienceBasis?.source === "current_task" ? `本次任务指定受众：${captured.result.audienceBasis.quote}` : personaSummary(persona, { allTiers: true }) };
}
