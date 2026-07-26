/**
 * 目标与复盘频道 handlers(V5.6 /goal):goal:get/set + retro:generate/list/get。
 * retro:generate 是一次 LLM 调用(~1 分钟),同步返回(本地 server 无超时),
 * 事件透出走任务动态。
 */
import { getGoal, setGoal } from "../modules/profile/goal.js";
import { generateRetro, listRetros, readRetro, type RetroMode } from "../modules/retro/retro.js";
import { emitEngineEvent } from "./event-hub.js";

type Payload = Record<string, unknown>;

function badPayload(payload: Payload): { ok: false; error: string } | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  return null;
}

export async function goalGetHandler(payload: Payload): Promise<Record<string, unknown>> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    return { ok: true, data: { goal: await getGoal((payload._dataDir as string) || undefined) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function goalSetHandler(payload: Payload): Promise<Record<string, unknown>> {
  const bad = badPayload(payload);
  if (bad) return bad;
  if (typeof payload.statement !== "string" || !payload.statement.trim()) {
    return { ok: false, error: "statement(目标一句话)必填" };
  }
  try {
    const goal = await setGoal(
      {
        statement: payload.statement,
        horizon: typeof payload.horizon === "string" ? payload.horizon : undefined,
        metrics: Array.isArray(payload.metrics)
          ? payload.metrics.filter((m): m is string => typeof m === "string")
          : undefined,
      },
      (payload._dataDir as string) || undefined,
    );
    return { ok: true, data: { goal } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function retroGenerateHandler(payload: Payload): Promise<Record<string, unknown>> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const mode = payload.mode;
  if (mode !== "weekly" && mode !== "monthly") return { ok: false, error: "mode 必须是 weekly 或 monthly" };
  const dataDir = (payload._dataDir as string) || undefined;
  const runId = `run-retro-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const label = mode === "weekly" ? "周复盘" : "月度深盘";
  void emitEngineEvent({ role: "analyst", kind: "work", label: `分析师在写${label}…`, runId }, dataDir).catch(() => {});
  try {
    const result = await generateRetro(mode as RetroMode, dataDir);
    void emitEngineEvent({ role: "analyst", kind: "run_done", label: `${label}已生成——数据回流页可看全文`, runId }, dataDir).catch(() => {});
    return {
      ok: true,
      data: {
        file: result.file, mode: result.mode, from: result.from, to: result.to,
        markdown: result.markdown,
        // 生产用时随产物一起回:调用方要读数,不该去 markdown 里正则抠
        timing: result.timing,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void emitEngineEvent({ role: "analyst", kind: "run_failed", label: `${label}生成失败:${msg.slice(0, 60)}`, runId }, dataDir).catch(() => {});
    return { ok: false, error: msg };
  }
}

export async function retroListHandler(payload: Payload): Promise<Record<string, unknown>> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    return { ok: true, data: { retros: await listRetros((payload._dataDir as string) || undefined) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function retroGetHandler(payload: Payload): Promise<Record<string, unknown>> {
  const bad = badPayload(payload);
  if (bad) return bad;
  if (typeof payload.file !== "string" || !payload.file) return { ok: false, error: "file 必填" };
  try {
    const markdown = await readRetro((payload._dataDir as string) || undefined, payload.file);
    if (markdown === null) return { ok: false, error: "报告不存在或文件名不合法" };
    return { ok: true, data: { file: payload.file, markdown } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
