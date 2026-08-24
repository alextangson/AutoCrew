/**
 * 封面频道 handlers(V5.6 封面设计师转正;V5.6.1 生图默认切中转 image2)。
 * create/revise 是分钟级生图任务 → 后台化:立即返回 runId,进度经引擎事件走 SSE
 * 任务动态;前端轮询 cover:get 取结果。get/approve/ratios 同步。
 * provider 解析在 server 端(cover.json + publish.json);gemini 分支注入 key
 * (renderer 永远拿不到原文),relay 分支工具自行解析凭证。
 */
import { executeCoverReview } from "../tools/cover-review.js";
import {
  loadCoverSettings,
  saveCoverSettings,
  resolveCoverProvider,
  type CoverGeminiModel,
  type CoverProvider,
} from "../modules/cover/provider.js";
import { emitEngineEvent } from "./event-hub.js";
import { appendAction } from "./recent-actions.js";
import { coverRatiosForPlatform } from "../modules/cover/platform-ratios.js";

type Payload = Record<string, unknown>;
type HandlerResult = Record<string, unknown>;

function badPayload(payload: Payload): HandlerResult | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  return null;
}

function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** provider 可用性检查 + gemini 分支的 key 注入参数 */
async function providerInjection(
  dataDir?: string,
): Promise<{ inject: Record<string, unknown> } | { error: string; hint: string }> {
  const resolved = await resolveCoverProvider(dataDir);
  if (!resolved.ok) {
    return {
      error: resolved.provider === "relay" ? "中转生图未配置(封面生成需要)" : "未配置 Gemini Key(封面生成需要)",
      hint: resolved.hint ?? "",
    };
  }
  return {
    inject:
      resolved.provider === "gemini"
        ? { _geminiApiKey: resolved.gemini.apiKey, _geminiModel: resolved.gemini.model }
        : {},
  };
}

export interface StartedCoverJob {
  response: HandlerResult;
  /** 后台执行句柄——生产忽略,测试 await 用 */
  completion: Promise<void>;
}

/** 后台化生图任务:立即返回 runId,完成/失败经引擎事件透出(观测层吞错)。 */
export async function startCoverJob(
  payload: Payload,
  action: "create_candidates" | "revise" | "platform_ratios",
  labels: { work: string; done: string },
): Promise<StartedCoverJob> {
  const dataDir = (payload._dataDir as string) || undefined;
  const prep = await providerInjection(dataDir);
  if ("error" in prep) {
    return { response: { ok: false, error: prep.error, hint: prep.hint }, completion: Promise.resolve() };
  }
  const contentId = String(payload.content_id ?? "");
  const runId = `run-cover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const emit = (kind: "work" | "run_done" | "run_failed", label: string) =>
    void emitEngineEvent({ role: "publisher", kind, label, contentId, runId }, dataDir).catch(() => {});

  emit("work", labels.work);
  // 进度事件:设计→出图交接报一声 + 每出完一张报 n/总,生成期不再是静默黑箱(消掉"卡死"体感)。
  const onPhase = (label: string) => emit("work", label);
  const onVariant = (p: { done: number; total: number; label: string; ok: boolean }) =>
    emit("work", `封面 ${p.label.toUpperCase()} ${p.ok ? "已出" : "失败"}（${p.done}/${p.total}）`);
  const completion = (async () => {
    try {
      const result = (await executeCoverReview({
        ...payload,
        action,
        _dataDir: dataDir,
        _onVariant: onVariant,
        _onPhase: onPhase,
        ...prep.inject,
      })) as { ok?: boolean; error?: string; warnings?: string[]; details?: string[]; designSource?: string; generated?: number; failed?: number; statusNote?: string };
      if (result.ok) {
        const warn = result.warnings?.length ? `(${result.warnings[0].slice(0, 40)})` : "";
        // 系统顺手改了稿件阶段（撤销封面批准 → 退回封面设计）必须说出来,不许静默降级
        const staged = result.statusNote ? ` · ${result.statusNote}` : "";
        // 静默降级要有声:LLM 设计师没跑成时,创始人得知道拿到的是规则版
        const fallback = result.designSource === "rules"
          ? "(规则版兜底——LLM 设计师未跑成,详见运行日志)"
          : result.designSource === "hybrid"
            ? "(已保留模型成功方案,缺位由本地创意补齐)"
            : "";
        const partial = result.failed ? `(生图 ${result.generated ?? 0}/3 成功,失败项可重试)` : "";
        emit("run_done", labels.done + partial + warn + fallback + staged);
      } else {
        // 观测盲区修复:全败时把第一条 per-variant 真实报错透进事件,别只剩一句 All failed
        const detail = result.details?.length ? `——${String(result.details[0]).slice(0, 160)}` : "";
        emit("run_failed", `封面任务失败:${(result.error ?? "未知错误").slice(0, 60)}${detail}`);
      }
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

/**
 * 选用即自动补齐平台比例(创始人裁决 2026-07-12:短视频封面同时要 3:4 与 4:3)。
 * 只补选中那张——候选阶段不多花一分生图钱;缺啥补啥,已齐不动。
 */
export async function approveCoverJob(payload: Payload): Promise<StartedCoverJob> {
  const bad = badPayload(payload);
  if (bad) return { response: bad, completion: Promise.resolve() };
  const dataDir = (payload._dataDir as string) || undefined;
  let result: {
    ok?: boolean;
    review?: { platform?: string; approvedLabel?: string; variants?: Array<{ label: string; imagePaths?: Record<string, string | undefined> }> };
  };
  try {
    result = (await executeCoverReview({
      action: "approve",
      content_id: payload.content_id,
      label: payload.label,
      _dataDir: dataDir,
    })) as typeof result;
  } catch (err) {
    return { response: { ok: false, error: err instanceof Error ? err.message : String(err) }, completion: Promise.resolve() };
  }
  if (!result.ok) return { response: result as HandlerResult, completion: Promise.resolve() };
  // 工作区动作进有界环（设计 §Phase 2）：下一轮对话里总编辑要知道封面已经定稿了
  void appendAction(dataDir, {
    kind: "cover_approved",
    contentId: String(payload.content_id ?? ""),
    detail: String(payload.label ?? "").toUpperCase(),
  });

  const review = result.review;
  const approved = review?.variants?.find((v) => v.label === review?.approvedLabel);
  const have = Object.keys(approved?.imagePaths ?? {});
  const missing = coverRatiosForPlatform(review?.platform).filter((r) => !have.includes(r));
  if (missing.length === 0) return { response: result as HandlerResult, completion: Promise.resolve() };

  const job = await startCoverJob({ content_id: payload.content_id, ratios: missing, _dataDir: dataDir }, "platform_ratios", {
    work: `按平台补齐封面比例(${missing.join("/")})…`,
    done: `封面比例已补齐(${missing.join("/")})——稿件文件夹里直接拿`,
  });
  const response: HandlerResult = { ...(result as HandlerResult), autoRatios: missing };
  if (job.response.ok) response.autoRatioRunId = job.response.runId;
  return { response, completion: job.completion };
}

export async function coverApproveHandler(payload: Payload): Promise<HandlerResult> {
  const job = await approveCoverJob(payload);
  return job.response;
}

export async function coverRatiosHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const prep = await providerInjection(dataDir);
    if ("error" in prep) return { ok: false, error: prep.error, hint: prep.hint };
    return (await executeCoverReview({
      action: "platform_ratios",
      content_id: payload.content_id,
      ratios: payload.ratios,
      _dataDir: dataDir,
      ...prep.inject,
    })) as HandlerResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function coverSettingsGetHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    const r = await resolveCoverProvider((payload._dataDir as string) || undefined);
    return {
      ok: true,
      data: {
        provider: r.provider,
        relay: { configured: r.relay !== null, model: r.relay?.model ?? null },
        gemini: {
          configured: r.gemini.apiKey !== null,
          apiKeyMasked: r.gemini.apiKey ? maskKey(r.gemini.apiKey) : null,
          source: r.gemini.source,
          model: r.gemini.model,
        },
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function coverSettingsSetHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const updates: { provider?: CoverProvider; relayModel?: string; geminiApiKey?: string; geminiModel?: CoverGeminiModel } = {};
  if (payload.provider !== undefined) {
    if (payload.provider !== "relay" && payload.provider !== "gemini") {
      return { ok: false, error: "provider 必须是 relay(中转) 或 gemini" };
    }
    updates.provider = payload.provider;
  }
  if (payload.relay_model !== undefined) {
    if (typeof payload.relay_model !== "string" || payload.relay_model.trim() === "") {
      return { ok: false, error: "relay_model 必须是非空字符串" };
    }
    updates.relayModel = payload.relay_model.trim();
  }
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
    return { ok: false, error: "没有可写入的字段(provider / relay_model / gemini_api_key / gemini_model)" };
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
