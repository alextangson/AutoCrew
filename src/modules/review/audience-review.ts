/**
 * 受众停留审（IA v5 V5.1）——审核员的新维度:以受众画像为标准,判断目标受众
 * 会不会为这篇稿停下滑动。顾问性质,不阻断流转(与违禁词硬门并列,性质不同):
 * 停留是编辑判断,最终裁决权在人。
 *
 * 画像未校准(calibratedAt 缺省)时拒绝执行——未经用户确认的画像不能当审稿标准。
 */
import { loadEngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { loadProfile, personaSummary } from "../profile/creator-profile.js";
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
}

function buildSubmitTool(captured: { result: Omit<AudienceReviewResult, "personaUsed"> | null }): LoopTool {
  return {
    name: "submit_audience_review",
    description: "提交受众停留审结果。",
    parameters: {
      type: "object",
      properties: {
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
      required: ["verdicts"],
    },
    execute(args) {
      const verdicts = Array.isArray(args.verdicts) ? (args.verdicts as TierStayVerdict[]) : [];
      const core = verdicts.find((v) => v.tier === "core");
      if (!core) return "Error: verdicts 必须包含 tier=core 的判定,请补全后重新调用";
      captured.result = {
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
  input: { title: string; body: string; platform?: string },
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

  await loopFn(config, {
    model: config.strongModel,
    systemPrompt:
      "你是内容审核员,专职「受众停留审」:代入给定的受众画像逐层判断——刷到这篇内容,TA 会停下来读完吗?" +
      "判断必须锚定画像的焦虑与停留触发器,不允许泛泛而谈;指出会让 TA 划走的具体原文位置。" +
      "完成后调用 submit_audience_review 提交。",
    userMessage: `受众画像:\n${tiers}\n\n待审稿件${input.platform ? `(${input.platform})` : ""}:\n标题:${input.title}\n\n${input.body.slice(0, 6000)}`,
    tools: [buildSubmitTool(captured)],
    maxTurns: 3,
  });

  if (!captured.result) {
    throw new Error("停留审失败:模型未调用 submit_audience_review 提交结果");
  }
  return { ...captured.result, personaUsed: personaSummary(persona, { allTiers: true }) };
}
