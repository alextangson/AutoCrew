/**
 * 盲评通道 B（cheat-score-blind）：一次独立的后台模型调用，**代码层面只喂稿子全文 + rubric.json**。
 *
 * buildBlindRequest 的签名就是隔离边界：它只收这两样，拿不到 state、预测、复盘、回流数据。
 * 走主线路快模型（engine fastModel）。调用失败照实抛出，由调用方记成 failed 状态，不静默改成自评。
 */
import { loadEngineConfig } from "../../engine/config.js";
import { runLoop, type LoopTool } from "../../engine/loop.js";
import { decodeArg } from "../meetings/meeting-args.js";
import { ALL_DIMS, rubricLeaks, type DimKey, type Rubric } from "./rubric.js";

export type DimConfidence = "high" | "medium" | "low";
export interface BlindDimScore { score: number; confidence: DimConfidence; reason: string }
export type BlindScores = Record<DimKey, BlindDimScore>;

export const BLIND_SYSTEM_PROMPT = [
  "你是盲评打分员，只按给你的评分表给一篇稿子逐维打分。",
  "你看不到也不需要知道这个账号的任何历史、数据或别人打过的分；只看稿子本身给出的证据。",
  "每个维度给 0–5 整数分、置信度（high=稿子里有直接证据 / medium=可推断 / low=信号太弱）、一句不超过 40 字的理由，理由要引用稿子里的具体词或场景。",
  "评分表里列出的所有维度（含候选维度）都要打。不算综合分。完成后调用 submit_blind_scores 提交。",
].join("\n");

/** 隔离边界：只收稿子全文与 rubric（盲评白名单）两样 */
export function buildBlindRequest(scriptText: string, rubric: Rubric): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt: BLIND_SYSTEM_PROMPT,
    userMessage: `评分表（rubric.json）：\n${JSON.stringify(rubric)}\n\n稿子全文：\n${scriptText}`,
  };
}

/** 模型交来的分数：JSON 串照收、逐维校验；坏输入打回让它重交，不当成空分 */
export function parseBlindScores(raw: unknown): { scores?: BlindScores; error?: string } {
  let dims: unknown;
  try { dims = decodeArg(raw); } catch (err) { return { error: (err as Error).message }; }
  if (!dims || typeof dims !== "object" || Array.isArray(dims)) return { error: "dimensions 必须是 {维度: {score, confidence, reason}} 对象" };
  const out: Partial<BlindScores> = {};
  for (const d of ALL_DIMS) {
    let v: unknown;
    try { v = decodeArg((dims as Record<string, unknown>)[d]); } catch { v = undefined; }
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const score = typeof o.score === "string" ? Number(o.score) : o.score;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 5) return { error: `${d}.score 必须是 0–5 整数` };
    if (!["high", "medium", "low"].includes(String(o.confidence))) return { error: `${d}.confidence 只能是 high/medium/low` };
    const reason = typeof o.reason === "string" ? o.reason.trim() : "";
    if (!reason || reason.length > 80) return { error: `${d}.reason 要一句不超过 40 字的理由` };
    out[d] = { score, confidence: o.confidence as DimConfidence, reason };
  }
  return { scores: out as BlindScores };
}

function submitTool(captured: { scores: BlindScores | null }): LoopTool {
  return {
    name: "submit_blind_scores",
    description: "提交逐维盲评分。",
    parameters: { type: "object", properties: { dimensions: { type: "object", description: "{ER:{score,confidence,reason}, …全部维度}" } }, required: ["dimensions"] },
    execute(args) {
      const r = parseBlindScores(args.dimensions);
      if (r.error) return `Error: ${r.error}；改正后重新调用`;
      captured.scores = r.scores!;
      return "已收到盲评分";
    },
  };
}

export interface BlindOutcome { scores: BlindScores; model: string; usedFallback?: string }

export async function runBlindChannel(scriptText: string, rubric: Rubric, dataDir?: string, deps?: { runLoopImpl?: typeof runLoop }): Promise<BlindOutcome> {
  const leaks = rubricLeaks(rubric);
  if (leaks.length) throw new Error(`rubric.json 混进了数据（${leaks[0]}），盲评通道拒绝打分：先清理评分表`);
  const config = await loadEngineConfig(dataDir);
  const captured = { scores: null as BlindScores | null };
  const req = buildBlindRequest(scriptText, rubric);
  const result = await (deps?.runLoopImpl ?? runLoop)(
    { ...config, activeProvider: { id: config.activeProvider?.id ?? "main", role: "calibration_blind" } },
    { model: config.fastModel, ...req, tools: [submitTool(captured)], maxTurns: 3, logMeta: { agent: "calibration_blind" } },
  );
  if (!captured.scores) throw new Error("盲评通道没有交回分数（模型未调用 submit_blind_scores）");
  return { scores: captured.scores, model: result.usedFallback?.to ?? config.fastModel, ...(result.usedFallback ? { usedFallback: result.usedFallback.to } : {}) };
}
