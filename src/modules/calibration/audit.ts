/**
 * 跨模型审计通道 C（cheat-bump Phase 4），通用：只在升级终局调一次，走与盲评通道 B 不同的模型线路
 * （已配置的 reviewer 线路，即 DeepSeek）。线路没配、和主线路是同一条、中途切到了备用、或没交合规判定，
 * 一律当作审计没过——本地过 + 审计过才放行，不降级成自审。
 */
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import { runLoop, type LoopTool } from "../../engine/loop.js";
import { AUDIT_REASON_MIN_CHARS } from "./constants.js";

export interface AuditVerdict { verdict: "PASS" | "REJECT" | "UNAVAILABLE"; reason: string; risks?: string; model: string | null }

export const AUDIT_SYSTEM_PROMPT = [
  "你是独立审稿人。一个内容创作者准备升级打分公式（或保留/删除一条方法），请独立判定：",
  "1. 排序一致性：新排序与实绩排序是否真的在 ≥80% 样本上一致，且没有把旧排序排对的任一对排反？",
  "2. 解释力：新的相比旧的，是否更好地解释了这些样本的实绩分布？",
  `调用 submit_audit 提交：verdict 为 PASS 或 REJECT，reason 不少于 ${AUDIT_REASON_MIN_CHARS} 字，risks 列潜在问题。`,
].join("\n");

function submitTool(captured: { v: Omit<AuditVerdict, "model"> | null }): LoopTool {
  return {
    name: "submit_audit",
    description: "提交审计判定。",
    parameters: { type: "object", properties: { verdict: { type: "string", enum: ["PASS", "REJECT"] }, reason: { type: "string" }, risks: { type: "string" } }, required: ["verdict", "reason"] },
    execute(args) {
      const verdict = String(args.verdict ?? "").trim().toUpperCase();
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (verdict !== "PASS" && verdict !== "REJECT") return "Error: verdict 只能是 PASS 或 REJECT";
      if (Array.from(reason).length < AUDIT_REASON_MIN_CHARS) return `Error: reason 至少 ${AUDIT_REASON_MIN_CHARS} 字`;
      captured.v = { verdict, reason, ...(typeof args.risks === "string" ? { risks: args.risks } : {}) };
      return "已收到审计判定";
    },
  };
}

export async function runAudit(payload: string, dataDir?: string, deps?: { runLoopImpl?: typeof runLoop }): Promise<AuditVerdict> {
  const config = await loadEngineConfig(dataDir);
  const route = resolveEngineRoute(config, "reviewer", config.strongModel);
  if (!config.assignments?.reviewer || route.config.baseUrl === config.baseUrl) {
    return { verdict: "UNAVAILABLE", reason: "审计通道 C 没有另一条模型线路（reviewer 线路未配置，或与主线路相同）：不能自审代替，本次升级不放行", model: null };
  }
  const captured = { v: null as Omit<AuditVerdict, "model"> | null };
  try {
    const result = await (deps?.runLoopImpl ?? runLoop)(route.config, {
      model: route.model, systemPrompt: AUDIT_SYSTEM_PROMPT, userMessage: payload, tools: [submitTool(captured)], maxTurns: 3, logMeta: { agent: "calibration_audit" },
    });
    if (result.usedFallback) return { verdict: "UNAVAILABLE", reason: `审计中途切到备用线路（${result.usedFallback.to}），不算独立审计：${result.usedFallback.error}`, model: result.usedFallback.to };
  } catch (err) {
    return { verdict: "UNAVAILABLE", reason: `审计通道调用失败：${err instanceof Error ? err.message : String(err)}`, model: route.model };
  }
  if (!captured.v) return { verdict: "UNAVAILABLE", reason: "审计通道没有交回合规判定（未调用 submit_audit）", model: route.model };
  return { ...captured.v, model: route.model };
}
