/**
 * 封面频道 handlers(V5.6 封面设计师转正)。
 * create/revise 是分钟级生图任务 → 后台化:立即返回 runId,进度经引擎事件走 SSE
 * 任务动态;前端轮询 cover:get 取结果。get/approve/ratios 同步。
 * Gemini key 由 cover-settings 在 server 端解析注入(renderer 永远拿不到原文)。
 */
import { executeCoverReview } from "../tools/cover-review.js";
import { loadCoverSettings, saveCoverSettings, resolveCoverGemini, type CoverGeminiModel } from "./cover-settings.js";
import { emitEngineEvent } from "./event-hub.js";

type Payload = Record<string, unknown>;
type HandlerResult = Record<string, unknown>;

const KEY_HINT = "免费获取:https://aistudio.google.com/apikey → 设置页「封面生成(Gemini)」填入";

function badPayload(payload: Payload): HandlerResult | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  return null;
}

function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export interface StartedCoverJob {
  response: HandlerResult;
  /** 后台执行句柄——生产忽略,测试 await 用 */
  completion: Promise<void>;
}

/** 后台化生图任务:立即返回 runId,完成/失败经引擎事件透出(观测层吞错)。 */
export async function startCoverJob(
  payload: Payload,
  action: "create_candidates" | "revise",
  labels: { work: string; done: string },
): Promise<StartedCoverJob> {
  const dataDir = (payload._dataDir as string) || undefined;
  const { apiKey, model } = await resolveCoverGemini(dataDir);
  if (!apiKey) {
    return {
      response: { ok: false, error: "未配置 Gemini Key(封面生成需要)", hint: KEY_HINT },
      completion: Promise.resolve(),
    };
  }
  const contentId = String(payload.content_id ?? "");
  const runId = `run-cover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const emit = (kind: "work" | "run_done" | "run_failed", label: string) =>
    void emitEngineEvent({ role: "publisher", kind, label, contentId, runId }, dataDir).catch(() => {});

  emit("work", labels.work);
  const completion = (async () => {
    try {
      const result = (await executeCoverReview({
        ...payload,
        action,
        _dataDir: dataDir,
        _geminiApiKey: apiKey,
        _geminiModel: model,
      })) as { ok?: boolean; error?: string };
      if (result.ok) emit("run_done", labels.done);
      else emit("run_failed", `封面任务失败:${(result.error ?? "未知错误").slice(0, 60)}`);
    } catch (err) {
      emit("run_failed", `封面任务失败:${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`);
    }
  })();
  return { response: { ok: true, pending: true, runId }, completion };
}

export async function coverCreateHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const job = await startCoverJob(payload, "create_candidates", {
    work: "封面设计师在出 3 张候选…",
    done: "封面候选已出——去编辑器选用或提意见",
  });
  return job.response;
}

export async function coverReviseHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const job = await startCoverJob(payload, "revise", {
    work: "封面设计师按你的意见重做…",
    done: "封面已按意见重做——去编辑器看新方案",
  });
  return job.response;
}

export async function coverGetHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    return (await executeCoverReview({
      action: "get",
      content_id: payload.content_id,
      _dataDir: (payload._dataDir as string) || undefined,
    })) as HandlerResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function coverApproveHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    return (await executeCoverReview({
      action: "approve",
      content_id: payload.content_id,
      label: payload.label,
      _dataDir: (payload._dataDir as string) || undefined,
    })) as HandlerResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function coverRatiosHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const { apiKey, model } = await resolveCoverGemini(dataDir);
    if (!apiKey) return { ok: false, error: "未配置 Gemini Key(封面生成需要)", hint: KEY_HINT };
    return (await executeCoverReview({
      action: "platform_ratios",
      content_id: payload.content_id,
      ratios: payload.ratios,
      _dataDir: dataDir,
      _geminiApiKey: apiKey,
      _geminiModel: model,
    })) as HandlerResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function coverSettingsGetHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const { apiKey, model, source } = await resolveCoverGemini(dataDir);
    return {
      ok: true,
      data: { configured: Boolean(apiKey), apiKeyMasked: apiKey ? maskKey(apiKey) : null, source, model },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function coverSettingsSetHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const updates: { geminiApiKey?: string; geminiModel?: CoverGeminiModel } = {};
  if (payload.gemini_api_key !== undefined) {
    if (typeof payload.gemini_api_key !== "string" || payload.gemini_api_key.trim() === "") {
      return { ok: false, error: "gemini_api_key 必须是非空字符串" };
    }
    updates.geminiApiKey = payload.gemini_api_key.trim();
  }
  if (payload.gemini_model !== undefined) {
    const m = payload.gemini_model;
    if (m !== "auto" && m !== "gemini-native" && m !== "imagen-4") {
      return { ok: false, error: "gemini_model 必须是 auto / gemini-native / imagen-4" };
    }
    updates.geminiModel = m;
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "没有可写入的字段(gemini_api_key / gemini_model)" };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    await saveCoverSettings(updates, dataDir);
    return coverSettingsGetHandler({ _dataDir: dataDir });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export { loadCoverSettings };
