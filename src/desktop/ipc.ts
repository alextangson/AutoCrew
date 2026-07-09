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
 *   settings:search_get {}
 *   settings:search_set { provider, api_key, base_url? }
 *   settings:publish_get {}
 *   settings:publish_set { image_api_key?, image_base_url?, image_model?, theme?, author? }
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
 *   library:list         { folder_id? }
 *   library:add          { paths: string[], folder_id? }
 *   library:update       { id, name?, tags?, description?, folder_id?, path? }
 *   library:remove       { id }
 *   library:folder_create { name }
 *   library:folder_remove { id }
 *   dialog:pick_media    {}
 *   content:asset_add    { content_id, library_id }
 *   content:asset_remove { content_id, filename }
 *   today:summary       {}
 */
import { buildTodaySummary } from "./today-summary.js";
import { buildDashboardSummary } from "./dashboard-summary.js";
import { executeFlywheel } from "../tools/flywheel.js";
import { startGenerateScript } from "../modules/writing/generate-script.js";
import { listWorkspaces, createWorkspace, switchWorkspace } from "./workspace-store.js";
import { executeStyle } from "../tools/style.js";
import { executeContentSave } from "../tools/content-save.js";
import { executePublish } from "../tools/publish.js";
import { loadProfile, updateWritingRule, updateProfile, personaSummary } from "../modules/profile/creator-profile.js";
import { generateAudiencePersonaProposal, savePersonaCalibrated } from "../modules/profile/persona.js";
import {
  coverCreateHandler,
  coverGetHandler,
  coverApproveHandler,
  coverReviseHandler,
  coverRatiosHandler,
  coverSettingsGetHandler,
  coverSettingsSetHandler,
} from "./cover-handlers.js";
import { logsListHandler, logsGetRunHandler, skillsListHandler } from "./log-handlers.js";
import { goalGetHandler, goalSetHandler, retroGenerateHandler, retroListHandler, retroGetHandler } from "./goal-retro-handlers.js";
import { getOnboardingStatus, completeOnboardingInit } from "./onboarding.js";
import { runPersistedChatTurn } from "./chat-persist.js";
import { listConversations, getConversation, deleteConversation } from "../storage/conversation-store.js";
import { getEngineSettings, setEngineSettings, getSearchSettings, setSearchSettings, getPublishSettings, setPublishSettings } from "./settings.js";
import { emitEngineEvent, readRecentEvents } from "./event-hub.js";
import { CHANNEL_EVENT_MAP } from "./event-map.js";
import { knowledgeStatus } from "../modules/knowledge/knowledge-base.js";
import { getRadarStatus, doRadarRefresh, setRadarSources } from "./radar-status.js";
import { listVersions, revertToVersion, addAsset as addContentAsset, removeAsset as removeContentAsset, getContent, listTopics, saveTopic, softDeleteTopic, restoreTopic, listTrash } from "../storage/local-store.js";
import { rewriteSelection } from "../modules/writing/selection-rewrite.js";
import { recordDiff } from "../modules/learnings/diff-tracker.js";
import type { IpcChannel } from "./channels.js";
import {
  listLibrary,
  addAssets as addLibraryAssets,
  updateAsset as updateLibraryAsset,
  removeAsset as removeLibraryAsset,
  createFolder as createLibraryFolder,
  removeFolder as removeLibraryFolder,
  getAsset as getLibraryAsset,
} from "../storage/library-store.js";
import nodePath from "node:path";
import { access as fsAccess } from "node:fs/promises";

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
  "style:distill": "distill",
  "style:absorb": "absorb_samples",
  "content:list": "list",
  "content:get": "get",
  "publish:clipboard": "clipboard",
  "publish:confirm": "confirm_published",
  "publish:wechat_draft": "wechat_mp_draft",
  "flywheel:import_csv": "import_csv",
  "flywheel:record": "record",
  "content:update": "update",
  "content:transition": "transition",
  "content:allowed_transitions": "allowed_transitions",
  "content:adoption": "adoption",
  "content:delete": "delete",
  "content:restore": "restore",
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
        // V5.5:校准中心要展示画像状态(画像=审稿标准,不可见就不可信)
        // V5.6:tiers 全量透出——画像面板要能看全三层、能改、能确认
        persona: {
          summary: personaSummary(profile?.audiencePersona, { allTiers: true }),
          calibrated: Boolean(profile?.audiencePersona?.calibratedAt),
          tiers: profile?.audiencePersona ?? null,
        },
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── persona:* — 受众画像一等 GUI 入口(V5.6:确认环节从聊天流搬进校准中心) ─────

async function personaGenerateHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const { proposal, basis } = await generateAudiencePersonaProposal(dataDir);
    return { ok: true, data: { proposal, basis } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function personaSaveHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const profile = await savePersonaCalibrated(payload.persona, dataDir);
    return {
      ok: true,
      data: {
        persona: profile.audiencePersona,
        summary: personaSummary(profile.audiencePersona, { allTiers: true }),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── generate:script — 后台化写稿（契约 P1:任务生命周期与 HTTP 请求解耦） ─────

async function generateBackgroundHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const dataDir = (payload._dataDir as string) || undefined;
  try {
    const started = await startGenerateScript(
      {
        topic: String(payload.topic ?? ""),
        platform: payload.platform as never,
        research: typeof payload.research === "string" ? payload.research : undefined,
        topicId: typeof payload.topic_id === "string" && payload.topic_id ? payload.topic_id : undefined,
      },
      dataDir,
      { onEvent: (e) => void emitEngineEvent(e, dataDir).catch(() => {}) },
    );
    return { ok: true, pending: true, contentId: started.contentId, runId: started.runId };
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
  // 上下文感知（IA v4.2 §C1）：renderer 报告用户正看着哪篇稿
  const rawCtx = payload.context;
  const viewContext =
    rawCtx && typeof rawCtx === "object" && !Array.isArray(rawCtx) && typeof (rawCtx as Record<string, unknown>).content_id === "string"
      ? {
          contentId: (rawCtx as Record<string, unknown>).content_id as string,
          contentTitle: String((rawCtx as Record<string, unknown>).content_title ?? ""),
          platform: String((rawCtx as Record<string, unknown>).platform ?? ""),
        }
      : undefined;
  // 任务动态带（IA v4.2）:每个 chat turn = 一个 run,事件按 runId 聚合成任务卡
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const dataDir = (payload._dataDir as string) || undefined;
  try {
    const result = await runPersistedChatTurn({
      message: message.trim(),
      ...(conversationId ? { conversationId } : {}),
      ...(viewContext ? { viewContext } : {}),
      dataDir,
      runId,
      ...(ctx?.onProgress
        ? {
            onEvent: (e: unknown) => {
              try {
                ctx.onProgress!({ ...(e as Record<string, unknown>), runId });
              } catch {
                /* 推送失败（窗口已关）不影响生成 */
              }
            },
          }
        : {}),
    });
    // run 收尾:成功有产出发 run_done;失败发 run_failed——任务带上的 run 不许悬空「进行中」
    if (result.ok !== false) {
      const data = result.data as { cards?: unknown[] } | undefined;
      const cardCount = Array.isArray(data?.cards) ? data.cards.length : 0;
      if (cardCount > 0) {
        void emitEngineEvent(
          { role: "system", kind: "run_done", runId, label: `任务完成 · 产出 ${cardCount} 张卡片` },
          dataDir,
        );
      }
    } else {
      void emitEngineEvent(
        { role: "system", kind: "run_failed", runId, label: `任务中断：${String((result as { error?: unknown }).error ?? "未知错误").slice(0, 60)}` },
        dataDir,
      );
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void emitEngineEvent({ role: "system", kind: "run_failed", runId, label: `任务中断：${msg.slice(0, 60)}` }, dataDir);
    return { ok: false, error: msg };
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
  // industry 与 platforms 均可选，至少给一个（席位编辑不必带定位，反之亦然）
  const updates: { industry?: string; platforms?: string[] } = {};
  if (typeof payload.industry === "string" && payload.industry.trim() !== "") {
    updates.industry = payload.industry.trim();
  }
  if (Array.isArray(payload.platforms)) {
    updates.platforms = (payload.platforms as unknown[]).filter(
      (p): p is string => typeof p === "string" && p.trim() !== "",
    );
  }
  if (updates.industry === undefined && updates.platforms === undefined) {
    return { ok: false, error: "需要 industry 或 platforms 至少其一" };
  }
  try {
    const profile = await updateProfile(updates, (payload._dataDir as string) || undefined);
    return { ok: true, data: { industry: profile.industry, platforms: profile.platforms } };
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
    const dataDir = (payload._dataDir as string) || undefined;
    const contentId = String(payload.content_id ?? "workbench");
    // 纠正路由需要平台归属（PRD-v4 §4.3）——按 content_id 反查，查不到不阻断记录
    const content = await getContent(contentId, dataDir).catch(() => null);
    // field 固定为 "body"（v1 工作台只改正文；title 编辑信号需求出现再扩 payload）
    await recordDiff(contentId, "body", before, after, dataDir, undefined, content?.platform);
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

// ── library:* / content:asset_* — 素材库（S2.9 引用式媒体仓库） ───────────────

const CONTENT_ID_RE = /^content-\d+-[a-z0-9]+$/;

function guardPayload(payload: Record<string, unknown>): { ok: false; error: string } | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  return null;
}

async function libraryListHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bad = guardPayload(payload);
  if (bad) return bad;
  try {
    return { ok: true, data: await listLibrary((payload._dataDir as string) || undefined) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function libraryAddHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bad = guardPayload(payload);
  if (bad) return bad;
  const paths = payload.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p)) {
    return { ok: false, error: "需要非空 paths 数组" };
  }
  const folderId = typeof payload.folder_id === "string" && payload.folder_id ? payload.folder_id : null;
  try {
    const result = await addLibraryAssets(paths as string[], folderId, (payload._dataDir as string) || undefined);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function libraryUpdateHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bad = guardPayload(payload);
  if (bad) return bad;
  const id = payload.id;
  if (typeof id !== "string" || !id) return { ok: false, error: "需要 id" };
  const patch: { name?: string; tags?: string[]; description?: string; folderId?: string | null; path?: string } = {};
  if (typeof payload.name === "string") patch.name = payload.name;
  if (Array.isArray(payload.tags)) patch.tags = (payload.tags as unknown[]).map(String);
  if (typeof payload.description === "string") patch.description = payload.description;
  if (payload.folder_id !== undefined) patch.folderId = typeof payload.folder_id === "string" && payload.folder_id ? payload.folder_id : null;
  if (typeof payload.path === "string") patch.path = payload.path;
  if (Object.keys(patch).length === 0) return { ok: false, error: "至少提供一个可更新字段" };
  try {
    const asset = await updateLibraryAsset(id, patch, (payload._dataDir as string) || undefined);
    if (!asset) return { ok: false, error: "素材不存在或重定位目标不可读" };
    return { ok: true, data: { asset } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function libraryRemoveHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bad = guardPayload(payload);
  if (bad) return bad;
  const id = payload.id;
  if (typeof id !== "string" || !id) return { ok: false, error: "需要 id" };
  try {
    const removed = await removeLibraryAsset(id, (payload._dataDir as string) || undefined);
    if (!removed) return { ok: false, error: "素材不存在" };
    return { ok: true, data: {} };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function libraryFolderCreateHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bad = guardPayload(payload);
  if (bad) return bad;
  const name = payload.name;
  if (typeof name !== "string" || !name.trim()) return { ok: false, error: "需要非空 name" };
  try {
    return { ok: true, data: { folder: await createLibraryFolder(name, (payload._dataDir as string) || undefined) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function libraryFolderRemoveHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bad = guardPayload(payload);
  if (bad) return bad;
  const id = payload.id;
  if (typeof id !== "string" || !id) return { ok: false, error: "需要 id" };
  try {
    const removed = await removeLibraryFolder(id, (payload._dataDir as string) || undefined);
    if (!removed) return { ok: false, error: "文件夹不存在" };
    return { ok: true, data: {} };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function dialogPickMediaUnavailableHandler(): Promise<Record<string, unknown>> {
  return { ok: false, error: "文件选择仅在桌面主进程可用" };
}

async function contentAssetAddHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bad = guardPayload(payload);
  if (bad) return bad;
  const contentId = payload.content_id;
  const libraryId = payload.library_id;
  if (typeof contentId !== "string" || !CONTENT_ID_RE.test(contentId)) return { ok: false, error: "需要合法 content_id" };
  if (typeof libraryId !== "string" || !libraryId) return { ok: false, error: "需要 library_id" };
  const dataDir = (payload._dataDir as string) || undefined;
  try {
    const asset = await getLibraryAsset(libraryId, dataDir);
    if (!asset) return { ok: false, error: "素材不存在" };
    try {
      await fsAccess(asset.path);
    } catch {
      return { ok: false, error: "原文件已移动或删除，请先在素材库重新定位" };
    }
    const filename = nodePath.basename(asset.path);
    // 同名拒绝：addContentAsset 复制无排他且 meta 不去重——同名二次挂接会覆盖字节
    // 并双登记，detach 时一次删两条（评审 fix 2026-06-11）
    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false, error: "稿件不存在" };
    if (content.assets.some((a) => a.filename === filename)) {
      return { ok: false, error: "同名素材已挂接：" + filename };
    }
    const result = await addContentAsset(
      contentId,
      {
        filename,
        type: asset.type,
        description: asset.name !== filename ? asset.name : undefined,
        sourcePath: asset.path,
      },
      dataDir,
    );
    if (!result.ok) return { ok: false, error: result.error || "挂接失败" };
    return { ok: true, data: { asset: result.asset } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function contentAssetRemoveHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bad = guardPayload(payload);
  if (bad) return bad;
  const contentId = payload.content_id;
  const filename = payload.filename;
  if (typeof contentId !== "string" || !CONTENT_ID_RE.test(contentId)) return { ok: false, error: "需要合法 content_id" };
  if (
    typeof filename !== "string" ||
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    return { ok: false, error: "需要合法 filename" };
  }
  try {
    const removed = await removeContentAsset(contentId, filename, (payload._dataDir as string) || undefined);
    if (!removed) return { ok: false, error: "挂接素材不存在" };
    return { ok: true, data: {} };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── today:summary — 今日工作台聚合（S3.0） ──────────────────────────────────

async function todaySummaryHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    return { ok: true, data: await buildTodaySummary((payload._dataDir as string) || undefined) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Dashboard 经营层首屏（IA v4.2 §2）——一次调用返回第一批组件全部数据 */
async function dashboardSummaryHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    return { ok: true, data: await buildDashboardSummary((payload._dataDir as string) || undefined) };
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
    "generate:script": generateBackgroundHandler,
    "style:distill": wrapExecute(executeStyle as ExecuteFn, CHANNEL_ACTIONS["style:distill"]),
    "style:absorb": wrapExecute(executeStyle as ExecuteFn, CHANNEL_ACTIONS["style:absorb"]),
    "style:rules": styleRulesHandler,
    "content:list": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:list"]),
    "content:get": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:get"]),
    "publish:clipboard": wrapExecute(executePublish as ExecuteFn, CHANNEL_ACTIONS["publish:clipboard"]),
    "publish:confirm": wrapExecute(executePublish as ExecuteFn, CHANNEL_ACTIONS["publish:confirm"]),
    "publish:wechat_draft": wrapExecute(executePublish as ExecuteFn, CHANNEL_ACTIONS["publish:wechat_draft"]),
    "chat:turn": chatTurnHandler,
    "settings:get": getEngineSettings,
    "settings:set": setEngineSettings,
    "settings:search_get": getSearchSettings,
    "settings:search_set": setSearchSettings,
    "settings:publish_get": getPublishSettings,
    "settings:publish_set": setPublishSettings,
    "style:update_rule": styleUpdateRuleHandler,
    "persona:generate": personaGenerateHandler,
    "persona:save": personaSaveHandler,
    "cover:create": coverCreateHandler,
    "cover:get": coverGetHandler,
    "cover:approve": coverApproveHandler,
    "cover:revise": coverReviseHandler,
    "cover:ratios": coverRatiosHandler,
    "settings:cover_get": coverSettingsGetHandler,
    "settings:cover_set": coverSettingsSetHandler,
    "logs:list": logsListHandler,
    "logs:get_run": logsGetRunHandler,
    "skills:list": skillsListHandler,
    "goal:get": goalGetHandler,
    "goal:set": goalSetHandler,
    "retro:generate": retroGenerateHandler,
    "retro:list": retroListHandler,
    "retro:get": retroGetHandler,
    "onboarding:status": getOnboardingStatus,
    "onboarding:init": completeOnboardingInit,
    "flywheel:import_csv": wrapExecute(executeFlywheel as ExecuteFn, CHANNEL_ACTIONS["flywheel:import_csv"]),
    "flywheel:record": wrapExecute(executeFlywheel as ExecuteFn, CHANNEL_ACTIONS["flywheel:record"]),
    "dialog:pick_file": dialogUnavailableHandler,
    "knowledge:status": knowledgeStatusHandler,
    "radar:status": getRadarStatus,
    "radar:refresh": (payload) => doRadarRefresh(payload),
    "radar:sources_set": setRadarSources,
    "profile:update": profileUpdateHandler,
    "content:update": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:update"]),
    "content:transition": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:transition"]),
    "content:allowed_transitions": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:allowed_transitions"]),
    "content:adoption": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:adoption"]),
    "content:delete": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:delete"]),
    "content:restore": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:restore"]),
    "topics:list": topicsListHandler,
    "topic:create": topicCreateHandler,
    "topic:delete": topicDeleteHandler,
    "topic:restore": topicRestoreHandler,
    "trash:list": trashListHandler,
    "content:versions": contentVersionsHandler,
    "content:revert": contentRevertHandler,
    "draft:rewrite_selection": rewriteSelectionHandler,
    "style:record_edit": styleRecordEditHandler,
    "conversations:list": conversationsListHandler,
    "conversations:get": conversationsGetHandler,
    "conversations:delete": conversationsDeleteHandler,
    "library:list": libraryListHandler,
    "library:add": libraryAddHandler,
    "library:update": libraryUpdateHandler,
    "library:remove": libraryRemoveHandler,
    "library:folder_create": libraryFolderCreateHandler,
    "library:folder_remove": libraryFolderRemoveHandler,
    "dialog:pick_media": dialogPickMediaUnavailableHandler,
    "content:asset_add": contentAssetAddHandler,
    "content:asset_remove": contentAssetRemoveHandler,
    "today:summary": todaySummaryHandler,
    "dashboard:summary": dashboardSummaryHandler,
    "events:recent": eventsRecentHandler,
    "workspace:list": workspaceListHandler,
    "workspace:create": workspaceCreateHandler,
    "workspace:switch": workspaceSwitchHandler,
  };

  // 引擎事件桥（P1 一期）：把值得进工作日志的结果映射为事件。
  // 观测层：映射/落盘失败全部吞掉，绝不影响执行层的返回值。
  for (const ch of Object.keys(CHANNEL_EVENT_MAP) as IpcChannel[]) {
    const mapper = CHANNEL_EVENT_MAP[ch];
    const inner = defaults[ch];
    if (!mapper || !inner) continue;
    defaults[ch] = async (payload, ctx) => {
      const result = await inner(payload, ctx);
      try {
        const mapped = mapper({ payload, result });
        if (mapped) void emitEngineEvent(mapped, (payload._dataDir as string) || undefined);
      } catch {
        /* 观测层吞错 */
      }
      return result;
    };
  }

  if (!deps) return defaults;
  return { ...defaults, ...deps };
}

// ── workspace:* — 多工作区（一人多 IP,dataDir 只由 server 端从注册表解析） ────

async function workspaceListHandler(): Promise<Record<string, unknown>> {
  try {
    return { ok: true, data: await listWorkspaces() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function workspaceCreateHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const ws = await createWorkspace(String(payload.name ?? ""));
    return { ok: true, workspace: { id: ws.id, name: ws.name } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function workspaceSwitchHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const ws = await switchWorkspace(String(payload.id ?? ""));
    return { ok: true, workspace: { id: ws.id, name: ws.name } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── events:recent — 工作日志回放（P1 一期） ───────────────────────────────────

async function eventsRecentHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dataDir = (payload._dataDir as string) || undefined;
  const limit = typeof payload.limit === "number" ? payload.limit : 50;
  return { ok: true, events: await readRecentEvents(dataDir, limit) };
}

// ── 灵感库 / 回收站（qingmo 设计细节:软删除 + 恢复） ─────────────────────────

async function topicsListHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return { ok: true, topics: await listTopics((payload._dataDir as string) || undefined) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 手动/对话入库（IA v4.2 §A2）——「＋新想法」与候选卡按钮的落库通道 */
async function topicCreateHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title) return { ok: false, error: "title is required" };
  try {
    const topic = await saveTopic(
      {
        title,
        description: typeof payload.description === "string" && payload.description ? payload.description : title,
        tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : [],
        source: typeof payload.source === "string" && payload.source ? payload.source : "manual",
        ...(typeof payload.reason === "string" && payload.reason ? { reason: payload.reason } : {}),
        ...(typeof payload.link === "string" && payload.link ? { link: payload.link } : {}),
      },
      (payload._dataDir as string) || undefined,
    );
    return { ok: true, topic };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function topicDeleteHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = payload.id as string;
  if (!id) return { ok: false, error: "id is required" };
  try {
    const topic = await softDeleteTopic(id, (payload._dataDir as string) || undefined);
    if (!topic) return { ok: false, error: `Topic ${id} not found` };
    return { ok: true, topic };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function topicRestoreHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = payload.id as string;
  if (!id) return { ok: false, error: "id is required" };
  try {
    const topic = await restoreTopic(id, (payload._dataDir as string) || undefined);
    if (!topic) return { ok: false, error: `Topic ${id} not found` };
    return { ok: true, topic };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function trashListHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const trash = await listTrash((payload._dataDir as string) || undefined);
    return { ok: true, topics: trash.topics, contents: trash.contents };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
