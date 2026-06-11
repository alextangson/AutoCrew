/**
 * IPC contract + handler registry for the Electron desktop shell.
 *
 * Design: `wrapExecute(fn, action)` is the single place that:
 *   1. Guards non-object payloads → {ok:false}
 *   2. Injects the `action` field into the execute fn call — AFTER spreading
 *      the payload, so a renderer-supplied `action` can never override it
 *      (the channel whitelist must hold even against a hostile payload)
 *   3. Catches thrown errors → {ok:false, error}
 *
 * Exported so tests can verify action injection directly without going through
 * the full deps-injection path (deps replaces the whole handler, so it can't
 * observe what action was injected — wrapExecute solves that cleanly).
 *
 * This layer does NOT validate tool return shapes — the wrapped execute*
 * functions conform to {ok, data?/error?} by contract.
 *
 * Per-channel payload keys (passed through verbatim — note the asymmetry:
 * publish channels take `content_id`, content:get takes `id`):
 *   flywheel:report    {}                                  (optional _dataDir in tests)
 *   generate:script    { topic, platform, research? }
 *   style:distill      {}
 *   style:absorb       { samples: string[] }               (1-5 entries)
 *   style:rules        {}
 *   content:list       {}
 *   content:get        { id }
 *   publish:clipboard  { content_id, hashtags? }
 *   publish:confirm    { content_id, publish_url? }
 *   chat:turn          { conversation_id?, message }
 *   settings:get       {}
 *   settings:set       { api_key?, base_url?, strong_model?, fast_model? }
 *   style:update_rule  { index, rule?, disabled? }
 *   onboarding:status  {}
 *   onboarding:init    { industry?, platforms? }
 *   flywheel:import_csv { platform, csv_path, metric_date? }
 *   dialog:pick_file   {}
 *   knowledge:status   {}
 *   radar:status       {}
 *   radar:refresh      {}
 *   profile:update     { industry }
 *   content:update     { id, title?, body?, status?, hashtags? }
 *   content:transition { id, target_status }
 *   content:allowed_transitions { id }
 *   content:versions   { id }
 *   content:revert     { id, version }
 *   draft:rewrite_selection { body, selection, instruction }
 *   style:record_edit  { content_id?, before, after }    (field 固定 body)
 *   conversations:list   {}
 *   conversations:get    { id }
 *   conversations:delete { id }
 */
import { executeFlywheel } from "../tools/flywheel.js";
import { executeGenerate } from "../tools/generate.js";
import { executeStyle } from "../tools/style.js";
import { executeContentSave } from "../tools/content-save.js";
import { executePublish } from "../tools/publish.js";
import { loadProfile, updateWritingRule, updateProfile } from "../modules/profile/creator-profile.js";
import { getOnboardingStatus, completeOnboardingInit } from "./onboarding.js";
import { runPersistedChatTurn } from "./chat-persist.js";
import { listConversations, getConversation, deleteConversation } from "../storage/conversation-store.js";
import { getEngineSettings, setEngineSettings } from "./settings.js";
import { knowledgeStatus } from "../modules/knowledge/knowledge-base.js";
import { getRadarStatus, doRadarRefresh } from "./radar-status.js";
import { listVersions, revertToVersion } from "../storage/local-store.js";
import { rewriteSelection } from "../modules/writing/selection-rewrite.js";
import { recordDiff } from "../modules/learnings/diff-tracker.js";
import type { IpcChannel } from "./channels.js";

// ── Contract ─────────────────────────────────────────────────────────────────
// Channel list lives in channels.ts (dependency-free so the sandboxed preload
// can bundle it without dragging in the engine). Re-exported for consumers.

export { IPC_CHANNELS, type IpcChannel } from "./channels.js";

/** 每个 handler：收 payload（+可选 ctx），返回 {ok,...}，永不 throw。ctx 由 main.ts 注入（推送等主进程能力）。 */
export type IpcHandlerContext = { onProgress?: (e: Record<string, unknown>) => void };
export type IpcHandler = (payload: Record<string, unknown>, ctx?: IpcHandlerContext) => Promise<Record<string, unknown>>;

type ExecuteFn = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Channel→action table for the 8 execute-backed channels (style:rules is
 * loadProfile-based, not action-dispatched). Single source consumed by
 * buildIpcHandlers; exported so tests can assert every binding.
 */
export const CHANNEL_ACTIONS = {
  "flywheel:report": "report",
  "generate:script": "script",
  "style:distill": "distill",
  "style:absorb": "absorb_samples",
  "content:list": "list",
  "content:get": "get",
  "publish:clipboard": "clipboard",
  "publish:confirm": "confirm_published",
  "flywheel:import_csv": "import_csv",
  "content:update": "update",
  "content:transition": "transition",
  "content:allowed_transitions": "allowed_transitions",
} as const satisfies Partial<Record<IpcChannel, string>>;

// ── wrapExecute ───────────────────────────────────────────────────────────────

/**
 * Build a handler that injects `action` into the payload and delegates to `fn`.
 * Guards non-object payloads. Catches all errors. The injected `action` wins
 * over any `action` key in the payload (whitelist enforcement).
 * Exported for action-injection testability.
 */
export function wrapExecute(fn: ExecuteFn, action: string): IpcHandler {
  return async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, error: `Invalid payload: expected object, got ${payload === null ? "null" : typeof payload}` };
    }
    try {
      return await fn({ ...payload, action });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

// ── style:rules — loadProfile-based handler ───────────────────────────────────

async function styleRulesHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: `Invalid payload: expected object` };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const profile = await loadProfile(dataDir);
    return {
      ok: true,
      data: {
        rules: profile?.writingRules ?? [],
        boundaries: profile?.styleBoundaries ?? { never: [], always: [] },
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── chat:turn — Agent 态对话入口 ──────────────────────────────────────────────

async function chatTurnHandler(payload: Record<string, unknown>, ctx?: IpcHandlerContext): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const message = payload.message;
  if (typeof message !== "string" || message.trim() === "") {
    return { ok: false, error: "chat:turn 需要非空 message" };
  }
  const conversationId =
    typeof payload.conversation_id === "string" && payload.conversation_id !== ""
      ? payload.conversation_id
      : undefined;
  try {
    return await runPersistedChatTurn({
      message: message.trim(),
      ...(conversationId ? { conversationId } : {}),
      dataDir: (payload._dataDir as string) || undefined,
      ...(ctx?.onProgress
        ? {
            onEvent: (e: unknown) => {
              try {
                ctx.onProgress!(e as Record<string, unknown>);
              } catch {
                /* 推送失败（窗口已关）不影响生成 */
              }
            },
          }
        : {}),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── style:update_rule — 个性化中心：编辑/停用规则 ─────────────────────────────

// NOTE: index 寻址。单面板使用安全；若对话中 add_style_rule 与面板编辑并发，
// index 可能漂移（越界会报错，移位会改错条目）。稳定 rule ID 是正解，推迟到
// 数据模型演进；renderer 侧通过每次操作后整列表刷新缓解。
async function styleUpdateRuleHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const index = payload.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return { ok: false, error: "需要合法的规则 index（非负整数）" };
  }
  const patch: { rule?: string; disabled?: boolean } = {};
  if (typeof payload.rule === "string") patch.rule = payload.rule;
  if (typeof payload.disabled === "boolean") patch.disabled = payload.disabled;
  if (patch.rule === undefined && patch.disabled === undefined) {
    return { ok: false, error: "rule 或 disabled 至少提供一个" };
  }
  try {
    const profile = await updateWritingRule(index, patch, (payload._dataDir as string) || undefined);
    return { ok: true, data: { rules: profile.writingRules, boundaries: profile.styleBoundaries } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── dialog:pick_file — 默认 stub；desktop/main.ts 用 deps 覆盖真实现 ─────────

async function dialogUnavailableHandler(): Promise<Record<string, unknown>> {
  return { ok: false, error: "文件选择仅在桌面主进程可用" };
}

// ── knowledge:status — 知识库入口状态（设置页展示） ──────────────────────────

async function knowledgeStatusHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    return { ok: true, data: await knowledgeStatus((payload._dataDir as string) || undefined) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── profile:update — 侦察员面板：定位编辑（只许 industry 单字段，YAGNI） ──────

async function profileUpdateHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const industry = payload.industry;
  if (typeof industry !== "string" || industry.trim() === "") {
    return { ok: false, error: "需要非空 industry" };
  }
  try {
    const profile = await updateProfile({ industry: industry.trim() }, (payload._dataDir as string) || undefined);
    return { ok: true, data: { industry: profile.industry } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── 工作台（S2.7）：版本/回滚/选区改写/编辑信号 ───────────────────────────────

async function contentVersionsHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const id = payload.id;
  if (typeof id !== "string" || !id) return { ok: false, error: "需要 id" };
  try {
    const versions = await listVersions(id, (payload._dataDir as string) || undefined);
    return { ok: true, data: { versions } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function contentRevertHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const id = payload.id;
  const version = payload.version;
  if (typeof id !== "string" || !id) return { ok: false, error: "需要 id" };
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: "需要合法 version（正整数）" };
  }
  try {
    const content = await revertToVersion(id, version, (payload._dataDir as string) || undefined);
    if (!content) return { ok: false, error: "回滚失败：稿件或版本不存在" };
    return { ok: true, data: { content } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function rewriteSelectionHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  return rewriteSelection(
    {
      body: String(payload.body ?? ""),
      selection: String(payload.selection ?? ""),
      instruction: String(payload.instruction ?? ""),
    },
    (payload._dataDir as string) || undefined,
  );
}

async function styleRecordEditHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const before = payload.before;
  const after = payload.after;
  if (typeof before !== "string" || !before || typeof after !== "string" || !after) {
    return { ok: false, error: "需要 before 与 after" };
  }
  try {
    // field 固定为 "body"（v1 工作台只改正文；title 编辑信号需求出现再扩 payload）
    await recordDiff(
      String(payload.content_id ?? "workbench"),
      "body",
      before,
      after,
      (payload._dataDir as string) || undefined,
    );
    return { ok: true, data: {} };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── conversations:* — 任务历史（S2.8 对话持久化） ────────────────────────────

async function conversationsListHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    return { ok: true, data: { conversations: await listConversations((payload._dataDir as string) || undefined) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function conversationsGetHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const id = payload.id;
  if (typeof id !== "string" || !id) return { ok: false, error: "需要 id" };
  try {
    const conv = await getConversation(id, (payload._dataDir as string) || undefined);
    if (!conv) return { ok: false, error: "会话不存在或已损坏" };
    return { ok: true, data: { meta: conv.meta, messages: conv.messages } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function conversationsDeleteHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const id = payload.id;
  if (typeof id !== "string" || !id) return { ok: false, error: "需要 id" };
  try {
    const removed = await deleteConversation(id, (payload._dataDir as string) || undefined);
    if (!removed) return { ok: false, error: "会话不存在" };
    return { ok: true, data: {} };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── buildIpcHandlers ──────────────────────────────────────────────────────────

/**
 * Returns a handler per channel. `deps` overrides individual channels (for tests).
 */
export function buildIpcHandlers(
  deps?: Partial<Record<IpcChannel, IpcHandler>>,
): Record<IpcChannel, IpcHandler> {
  const defaults: Record<IpcChannel, IpcHandler> = {
    "flywheel:report": wrapExecute(executeFlywheel as ExecuteFn, CHANNEL_ACTIONS["flywheel:report"]),
    "generate:script": wrapExecute(executeGenerate as ExecuteFn, CHANNEL_ACTIONS["generate:script"]),
    "style:distill": wrapExecute(executeStyle as ExecuteFn, CHANNEL_ACTIONS["style:distill"]),
    "style:absorb": wrapExecute(executeStyle as ExecuteFn, CHANNEL_ACTIONS["style:absorb"]),
    "style:rules": styleRulesHandler,
    "content:list": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:list"]),
    "content:get": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:get"]),
    "publish:clipboard": wrapExecute(executePublish as ExecuteFn, CHANNEL_ACTIONS["publish:clipboard"]),
    "publish:confirm": wrapExecute(executePublish as ExecuteFn, CHANNEL_ACTIONS["publish:confirm"]),
    "chat:turn": chatTurnHandler,
    "settings:get": getEngineSettings,
    "settings:set": setEngineSettings,
    "style:update_rule": styleUpdateRuleHandler,
    "onboarding:status": getOnboardingStatus,
    "onboarding:init": completeOnboardingInit,
    "flywheel:import_csv": wrapExecute(executeFlywheel as ExecuteFn, CHANNEL_ACTIONS["flywheel:import_csv"]),
    "dialog:pick_file": dialogUnavailableHandler,
    "knowledge:status": knowledgeStatusHandler,
    "radar:status": getRadarStatus,
    "radar:refresh": (payload) => doRadarRefresh(payload),
    "profile:update": profileUpdateHandler,
    "content:update": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:update"]),
    "content:transition": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:transition"]),
    "content:allowed_transitions": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:allowed_transitions"]),
    "content:versions": contentVersionsHandler,
    "content:revert": contentRevertHandler,
    "draft:rewrite_selection": rewriteSelectionHandler,
    "style:record_edit": styleRecordEditHandler,
    "conversations:list": conversationsListHandler,
    "conversations:get": conversationsGetHandler,
    "conversations:delete": conversationsDeleteHandler,
  };

  if (!deps) return defaults;
  return { ...defaults, ...deps };
}
