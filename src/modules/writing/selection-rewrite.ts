/**
 * 选区改写（S2.7 框选→改写）— 单轮 LLM 无工具，带风格规则与全文上下文。
 * strongModel（核心生成档）；上下文截断防爆预算。
 * V5.2:上下文以选区为中心开窗（前后各半预算）——旧实现从头部截断,选区在长稿
 * 后部时上下文完全不含选区周边,改写会脱离语境。选区不在 body 里(极端编辑竞态)
 * 时回退头部截断。
 */
import { loadEngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import { loadProfile } from "../profile/creator-profile.js";

export interface RewriteSelectionParams {
  body: string;
  selection: string;
  instruction: string;
}

const CONTEXT_BUDGET = 3_000;

/** 以选区为中心的上下文窗口;超界侧用省略号标注截断 */
function contextWindow(body: string, selection: string, budget: number): string {
  const idx = selection ? body.indexOf(selection) : -1;
  if (idx < 0) return body.slice(0, budget);
  const half = Math.max(0, Math.floor((budget - selection.length) / 2));
  const start = Math.max(0, idx - half);
  const end = Math.min(body.length, idx + selection.length + half);
  return (start > 0 ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
}

export async function rewriteSelection(
  params: RewriteSelectionParams,
  dataDir?: string,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
  const selection = (params.selection ?? "").trim();
  const instruction = (params.instruction ?? "").trim();
  if (!selection) return { ok: false, error: "选区为空" };
  if (!instruction) return { ok: false, error: "缺少修改指令" };

  let config;
  try {
    config = await loadEngineConfig(dataDir);
  } catch (err) {
    return { ok: false, needsSetup: true, error: err instanceof Error ? err.message : String(err) };
  }

  let rules: string[] = [];
  try {
    const profile = await loadProfile(dataDir);
    rules = (profile?.writingRules ?? []).filter((r) => !r.disabled).map((r) => r.rule);
  } catch {
    /* 无档案不阻断 */
  }

  const body = contextWindow(params.body ?? "", selection, CONTEXT_BUDGET);
  const system = [
    "你是内容编辑。只改写用户选中的片段，保持与全文语气连贯。",
    "只输出改写后的片段本身——不解释、不加引号、不输出全文。",
    rules.length > 0 ? `遵守创作者写作规则：\n${rules.map((r) => `- ${r}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const user = `全文（上下文）：\n${body}\n\n选中片段：\n${selection}\n\n修改要求：${instruction}`;

  try {
    const result = await runLoop(config, {
      model: config.strongModel,
      systemPrompt: system,
      userMessage: user,
      maxTurns: 1,
      logMeta: { agent: "writer" },
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    const rewritten = result.finalMessage.trim();
    if (!rewritten || rewritten === "(no content)") {
      return { ok: false, error: "模型未返回改写结果，请重试" };
    }
    return { ok: true, data: { rewritten, tokensUsed: result.totalTokens } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
