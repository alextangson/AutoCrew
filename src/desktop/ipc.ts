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
 *   generate:retry     { content_id }                    (中断稿原地重写，不新建稿件)
 *   style:distill      {}
 *   style:absorb       { samples: string[] }               (1-5 entries)
 *   style:rules        {}
 *   content:list       {}
 *   content:get        { id }
 *   publish:clipboard  { content_id, hashtags? }
 *   publish:confirm    { content_id, publish_url? }      (publish_url 省略 = 保留旧链接)
 *   publish:pre_check  { content_id }                    (发布前检查；全过则自动流转 publish_ready)
 *   chat:turn          { conversation_id?, message, turn_id?, client_id?, model_choice? }
 *   chat:abort         { turn_id, client_id }
 *   chat:turn_status   { turn_id }
 *   chat:model_options {}                                  (只读；回模型名+档位，无凭证)
 *   settings:get       {}
 *   settings:set       { api_key?, base_url?, strong_model?, fast_model?, providers? }
 *   settings:open_config {}                                (打开实际生效的 engine.json)
 *   settings:test_route { target }                         (拿已保存的配置真发一次调用)
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
 *   content:asset_add    { content_id, library_id, role?, description? }
 *   content:asset_remove { content_id, filename }
 *   today:summary       {}
 */
import { buildTodaySummary } from "./today-summary.js";
import { buildDashboardSummary } from "./dashboard-summary.js";
import { executeFlywheel } from "../tools/flywheel.js";
import { startGenerateScript, retryGenerateScript } from "../modules/writing/generate-script.js";
import { listWorkspaces, createWorkspace, switchWorkspace } from "./workspace-store.js";
import { executeStyle } from "../tools/style.js";
import { executeContentSave } from "../tools/content-save.js";
import { executePublish } from "../tools/publish.js";
import { executePrePublish } from "../tools/pre-publish.js";
import { preparedArticleImages } from "../modules/publish/article-images.js";
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
import { coverIdentityHandler } from "./cover-identity-handlers.js";
import {
  articleImagesGenerateHandler,
  articleImagesGetHandler,
  articleImagesRegenerateHandler,
  articleImagesRemoveHandler,
  articleImagesSuggestHandler,
  articleImagesAddSlotHandler,
  articleImagesRemoveSlotHandler,
  articleImagesUploadHandler,
} from "./article-image-handlers.js";
import { logsListHandler, logsGetRunHandler, skillsListHandler } from "./log-handlers.js";
import {
  goalGetHandler,
  goalSetHandler,
  retroGenerateHandler,
  retroListHandler,
  retroGetHandler,
  hypothesesListHandler,
} from "./goal-retro-handlers.js";
import { openContentFolder } from "./folder-open.js";
import { getOnboardingStatus, completeOnboardingInit } from "./onboarding.js";
import { runPersistedChatTurn } from "./chat-persist.js";
import { chatModelOptions } from "./chat-router.js";
import { loadEngineConfig } from "../engine/config.js";
import { parseViewContext } from "./chat-view-context.js";
import { registerTurn, abortTurn, settleTurn, getTurnStatus, noteTurnConversation } from "./turn-registry.js";
import { listConversations, getConversation, deleteConversation } from "../storage/conversation-store.js";
import {
  getEngineSettings,
  setEngineSettings,
  getSearchSettings,
  setSearchSettings,
  getPublishSettings,
  setPublishSettings,
  openEngineConfigFile,
} from "./settings.js";
import { testEngineRoute } from "./settings-probe.js";
import { wechatPullHandler } from "./wechat-pull.js";
import {
  pullStatusHandler,
  pullNowHandler,
  pullToggleHandler,
} from "./metrics-pull-handlers.js";
import { emitEngineEvent, readRecentEvents } from "./event-hub.js";
import { makeEnsureBrief } from "./write-research-gate.js";
import { claimJob, releaseJob, holdJobUntilSettled, GENERATE_JOB_KEY } from "./job-claims.js";
import { appendAction } from "./recent-actions.js";
import { CHANNEL_EVENT_MAP } from "./event-map.js";
import { knowledgeStatus } from "../modules/knowledge/knowledge-base.js";
import { distillIdeaTopic } from "../modules/radar/idea-distill.js";
import type { DistilledIdea } from "../modules/radar/idea-distill.js";
import {
  getRadarStatus,
  doRadarRefresh,
  collectMoreRadarTopics,
  rescoreRadarTopics,
  setRadarSources,
} from "./radar-status.js";
import { inboxDoctorHandler } from "./inbox-doctor.js";
import {
  inboxListHandler,
  inboxRetryHandler,
  inboxDeleteHandler,
  inboxReingestHandler,
  inboxStatusHandler,
} from "./inbox-handlers.js";
import { getInboxSettings, setInboxSettings } from "./settings-inbox.js";
import { getVideoSettings, setVideoSettings } from "./settings-video.js";
import {
  videoAsrStatusHandler,
  videoAsrWarmupHandler,
  videoBuildStartHandler,
  videoCutConfirmHandler,
  videoCutPreviewHandler,
  videoEditorBackToCutHandler,
  videoEditorConfirmHandler,
  videoEditorPlanGetHandler,
  videoEditorRerunHandler,
  videoEditorSlotFillHandler,
  videoEditorSlotRemoveHandler,
  videoReassembleHandler,
  videoRetryHandler,
  videoReviewConfirmHandler,
  videoRoughCutRerunHandler,
  videoStatusHandler,
  videoTranscribeRerunHandler,
  videoTranscriptGetHandler,
  videoTranscriptTextEditHandler,
} from "./video-handlers.js";
import { patternsListHandler, patternsUpdateHandler, patternsDeleteHandler } from "./pattern-handlers.js";
import {
  researchDeepDiveHandler,
  researchStatusHandler,
  researchBriefGetHandler,
  researchListAssetsHandler,
  researchImportAssetHandler,
} from "./research-handlers.js";
import {
  listVersions,
  revertToVersion,
  addAsset as addContentAsset,
  removeAsset as removeContentAsset,
  getContent,
  getDataDir,
  getTopic,
  listTopics,
  saveTopic,
  updateTopic,
  softDeleteTopic,
  restoreTopic,
  listTrash,
  updateContent,
} from "../storage/local-store.js";
import { resolveEffectiveBrief } from "../modules/research/brief-snapshot.js";
import { findAngleCard, parseAngleCard } from "../modules/research/angle-cards.js";
import { isContentId, isSafeFilename } from "../storage/entity-id.js";
import { attachLibraryAsset } from "./content-asset-attach.js";
import type { ApprovalBinding } from "./approval-gate.js";
import { rewriteSelection } from "../modules/writing/selection-rewrite.js";
import { recordDiff } from "../modules/learnings/diff-tracker.js";
import { shouldDistillStyle, distillStyleRules } from "../modules/learnings/style-distiller.js";
import type { StyleDistillResult } from "../modules/learnings/style-distiller.js";
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
import { probeImportedAssets, setLibraryReusable } from "../modules/video/library-pool.js";
import nodePath from "node:path";
import { access as fsAccess } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  campaignCreateHandler,
  campaignGetHandler,
  campaignListHandler,
  campaignPlanTeamHandler,
  campaignRunReadyHandler,
  campaignRetryTaskHandler,
  campaignArtifactGetHandler,
  campaignPatchDecideHandler,
  campaignPatchProposeHandler,
  campaignReplanHandler,
  campaignSetAutonomyHandler,
  campaignTransitionHandler,
} from "./campaign-handlers.js";

// ── Contract ─────────────────────────────────────────────────────────────────
// Channel list lives in channels.ts (dependency-free so the sandboxed preload
// can bundle it without dragging in the engine). Re-exported for consumers.

export { IPC_CHANNELS, type IpcChannel } from "./channels.js";

/** 每个 handler：收 payload（+可选 ctx），返回 {ok,...}，永不 throw。ctx 由 main.ts 注入（推送等主进程能力）。 */
export type IpcHandlerContext = {
  onProgress?: (e: Record<string, unknown>) => void;
  /**
   * 流式正文广播（对话控制面设计 §Phase 3）：与 onProgress 同一条 SSE 通道，
   * 但事件名独立（chat_delta），工具进度条不被正文增量污染。
   * seq 由 chatTurnHandler 单调计数（per turn），乱序/重复在前端可判。
   */
  onChatDelta?: (e: { turnId: string; seq: number; ev: "delta" | "reset" | "done"; text?: string }) => void;
  requestApproval?: (binding: ApprovalBinding) => { token: string; expiresAt: string };
  consumeApproval?: (token: string, binding: ApprovalBinding) => { ok: true } | { ok: false; error: string };
};
export type IpcHandler = (
  payload: Record<string, unknown>,
  ctx?: IpcHandlerContext,
) => Promise<Record<string, unknown>>;

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
  "publish:preflight": "check",
  "publish:digest": "digest",
  "publish:confirm": "confirm_published",
  "publish:pre_check": "check",
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
      return {
        ok: false,
        error: `Invalid payload: expected object, got ${payload === null ? "null" : typeof payload}`,
      };
    }
    try {
      return await fn({ ...payload, action });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

// ── 工作区动作 → recent-actions 有界环（对话控制面设计 §Phase 2）────────────────

/**
 * 只在成功路径记一笔，供下一轮 chat:turn 注入模型上下文。
 * appendAction 自吞失败——观测层不得改变执行层的返回，也不得让它变慢到用户有感。
 */
function withActionRecord(inner: IpcHandler, kind: string): IpcHandler {
  return async (payload, ctx) => {
    const res = await inner(payload, ctx);
    if (res.ok !== true) return res;
    const data = (res.data ?? {}) as Record<string, unknown>;
    const subject = (res.content ?? data.content ?? data) as { id?: unknown; title?: unknown; status?: unknown };
    void appendAction((payload._dataDir as string) || undefined, {
      kind,
      contentId: String(subject.id ?? payload.content_id ?? payload.id ?? ""),
      ...(typeof subject.title === "string" ? { title: subject.title } : {}),
      // 流转要说清挪到哪一列；其余动作 kind 本身已经说完了，别再重复一遍状态名
      ...(kind === "transition" && typeof subject.status === "string" ? { detail: subject.status } : {}),
    });
    return res;
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

// ── content:open_folder — 人机协同:稿件文件夹 Finder 直达(V5.6.1) ─────────────

async function contentOpenFolderHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    return (await openContentFolder(
      String(payload.id ?? ""),
      (payload._dataDir as string) || undefined,
    )) as unknown as Record<string, unknown>;
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

// ── publish:* — 服务端发布审批门（UI 确认不是安全边界）─────────────────────

function approvalBinding(
  contentId: string,
  dataDir: string | undefined,
  content: { title: string; body: string; platform?: string },
): ApprovalBinding {
  const contentFingerprint = createHash("sha256")
    .update(JSON.stringify({ title: content.title, body: content.body, platform: content.platform ?? "" }))
    .digest("hex");
  return {
    action: "wechat_mp_draft",
    contentId,
    workspaceDir: getDataDir(dataDir),
    contentFingerprint,
  };
}

async function requestWechatDraftApprovalHandler(
  payload: Record<string, unknown>,
  ctx?: IpcHandlerContext,
): Promise<Record<string, unknown>> {
  const contentId = typeof payload.content_id === "string" ? payload.content_id : "";
  if (!isContentId(contentId)) return { ok: false, error: "需要合法 content_id" };
  if (!ctx?.requestApproval) return { ok: false, error: "发布审批服务不可用" };
  const dataDir = (payload._dataDir as string) || undefined;

  // 先验证目标平台，避免其他平台的稿件在被拒绝前被 preflight 推进状态。
  const initial = await getContent(contentId, dataDir);
  if (!initial) return { ok: false, error: `Content not found: ${contentId}` };
  if (initial.platform !== "wechat_mp") return { ok: false, error: "只有公众号稿件可推送到公众号草稿箱" };

  const bodyImages = await preparedArticleImages(contentId, dataDir);
  if (!bodyImages.ok) return bodyImages;

  // 确认前先跑完整门禁；不合格的稿件不生成可执行凭证。
  const preflight = await executePrePublish({ action: "check", content_id: contentId, _dataDir: dataDir });
  if (!("allPassed" in preflight) || !preflight.allPassed) {
    // 报出具体挂在哪一项——只说「检查未通过」用户不知道改什么,发布流程就成死胡同
    const fails = ((preflight as { checks?: Array<{ name: string; status: string; detail: string }> }).checks ?? [])
      .filter((c) => c.status === "fail")
      .map((c) => `${c.name}: ${c.detail.replace(/\s+/g, " ").trim()}`)
      .join("；");
    return {
      ok: false,
      error: fails ? `发布前检查未通过——${fails.slice(0, 240)}` : "发布前检查未通过，请修复后重新确认",
      ...(preflight && typeof preflight === "object" ? { preflight } : {}),
    };
  }

  // preflight 可能把状态推进到 publish_ready，必须在其后读取版本绑定。
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `Content not found: ${contentId}` };
  const issued = ctx.requestApproval(approvalBinding(contentId, dataDir, content));
  return { ok: true, approvalToken: issued.token, expiresAt: issued.expiresAt, preflight };
}

async function publishWechatDraftApprovedHandler(
  payload: Record<string, unknown>,
  ctx?: IpcHandlerContext,
): Promise<Record<string, unknown>> {
  const contentId = typeof payload.content_id === "string" ? payload.content_id : "";
  const token = typeof payload.approval_token === "string" ? payload.approval_token : "";
  if (!isContentId(contentId) || !token) return { ok: false, error: "需要合法 content_id 与 approval_token" };
  if (!ctx?.consumeApproval) return { ok: false, error: "发布审批服务不可用" };
  const dataDir = (payload._dataDir as string) || undefined;
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `Content not found: ${contentId}` };

  // TOCTOU 防线：执行前再次检查；凭证绑定标题/正文/平台指纹，确认后的编辑会失效。
  const preflight = await executePrePublish({ action: "check", content_id: contentId, _dataDir: dataDir });
  if (!("allPassed" in preflight) || !preflight.allPassed) {
    return { ok: false, error: "发布前检查已失效，请修复后重新确认", preflight };
  }
  const current = await getContent(contentId, dataDir);
  if (!current) return { ok: false, error: `Content not found: ${contentId}` };
  const consumed = ctx.consumeApproval(token, approvalBinding(contentId, dataDir, current));
  if (!consumed.ok) return consumed;

  // HTTP 面只传最小白名单：禁止 renderer 覆盖脚本路径、密钥、force 或 article_path。
  // theme 是纯排版主题名(publish.py --theme),无安全面,允许按篇覆盖全局默认。
  const theme = typeof payload.theme === "string" && payload.theme.trim() ? payload.theme.trim() : undefined;
  return executePublish({
    action: "wechat_mp_draft",
    content_id: contentId,
    ...(theme ? { theme } : {}),
    _dataDir: dataDir,
  });
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
        // 缺省启用；只有显式 false 才关掉对标拆解卡注入（收件箱设计 §3.5）
        ...(payload.use_patterns === false ? { usePatterns: false } : {}),
      },
      dataDir,
      {
        onEvent: (e) => void emitEngineEvent(e, dataDir).catch(() => {}),
        // 带 topicId 开写且这选题没跑过调研 → 先补一轮再写（闸口故障只降级，不阻断）
        ensureBriefImpl: makeEnsureBrief(dataDir),
      },
    );
    return { ok: true, pending: true, contentId: started.contentId, runId: started.runId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * generate:retry — 中断稿原地重写。镜像上面的启动接线（同一套 onEvent/emitEngineEvent），
 * 唯一的区别是**不建新稿**：写崩的那一篇自己重来一次。
 *
 * 防双击：中断徽章上的「重新生成」是个按钮，连点两下就是两条 run 同时改一份 meta。
 * claim 与封面/配图同一套（job-claims），check-and-register 必须在任何 await 之前。
 */
async function generateRetryHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const contentId = typeof payload.content_id === "string" ? payload.content_id.trim() : "";
  if (!contentId) return { ok: false, error: "generate:retry 需要 content_id" };
  const dataDir = (payload._dataDir as string) || undefined;
  const key = GENERATE_JOB_KEY(contentId);
  if (!claimJob(key)) return { ok: false, error: "这篇已经在写了——等它跑完再重试" };
  let held = false;
  try {
    const started = await retryGenerateScript(contentId, dataDir, {
      onEvent: (e) => void emitEngineEvent(e, dataDir).catch(() => {}),
      ensureBriefImpl: makeEnsureBrief(dataDir),
    });
    holdJobUntilSettled(key, started.completion); // claim 持有到后台 settle
    held = true;
    return { ok: true, pending: true, contentId: started.contentId, runId: started.runId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (!held) releaseJob(key);
  }
}

// ── chat:turn — Agent 态对话入口 ──────────────────────────────────────────────

async function chatTurnHandler(
  payload: Record<string, unknown>,
  ctx?: IpcHandlerContext,
): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const message = payload.message;
  if (typeof message !== "string" || message.trim() === "") {
    return { ok: false, error: "chat:turn 需要非空 message" };
  }
  const conversationId =
    typeof payload.conversation_id === "string" && payload.conversation_id !== "" ? payload.conversation_id : undefined;
  const dataDir = (payload._dataDir as string) || undefined;
  // 上下文感知（IA v4.2 §C1 + 设计 §Phase 3）：renderer 报告用户正看着哪——
  // 枚举白名单 + 存在性校验都在 chat-view-context，非法字段静默丢弃，不进 prompt。
  const viewContext = await parseViewContext(payload.context, dataDir);
  // turn 寻址（设计 §Phase 3）:turn_id + client_id 齐全才登记,才可中止。
  // 老前端不传 → 不登记、不可中止,行为与今天完全一致（additive 扩展的代价只落在新能力上）。
  const turnId = typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : undefined;
  const clientId = typeof payload.client_id === "string" && payload.client_id ? payload.client_id : undefined;
  // 模型档位（可选 additive）:不传 = 主端点快档,与今天字面一致;
  // 非法值不在这里兜——runChatTurn 拿到真配置后显式报错,绝不静默换一个模型跑
  const modelChoice =
    typeof payload.model_choice === "string" && payload.model_choice ? payload.model_choice : undefined;
  let signal: AbortSignal | undefined;
  if (turnId && clientId) {
    const reg = registerTurn(turnId, clientId, conversationId ? { conversationId } : undefined);
    if (!reg.ok) return { ok: false, error: reg.error };
    signal = reg.signal;
  }
  // 任务动态带（IA v4.2）:每个 chat turn = 一个 run,事件按 runId 聚合成任务卡
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // 流式 delta（设计 §Phase 3）:只对可寻址的 turn 广播——没有 turnId 的调用（老前端）
  // 收到 delta 也没法判断该不该渲染,不如不发。seq 服务端单调计数,前端据此丢重复/旧帧。
  let deltaSeq = 0;
  const onDelta =
    turnId && ctx?.onChatDelta
      ? (e: { ev: "delta" | "reset" | "done"; text?: string }) => {
          try {
            ctx.onChatDelta!({ turnId, seq: deltaSeq++, ev: e.ev, ...(e.text !== undefined ? { text: e.text } : {}) });
          } catch {
            /* 推送失败（窗口已关）不影响生成 */
          }
        }
      : undefined;
  let settledConversationId = conversationId;
  try {
    const result = await runPersistedChatTurn({
      message: message.trim(),
      ...(conversationId ? { conversationId } : {}),
      ...(viewContext ? { viewContext } : {}),
      ...(modelChoice ? { modelChoice } : {}),
      dataDir,
      runId,
      ...(turnId ? { turnId } : {}),
      ...(signal ? { signal } : {}),
      ...(onDelta ? { onDelta } : {}),
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
      const data = result.data as
        | { cards?: unknown[]; contentIds?: string[]; conversationId?: unknown; stopReason?: unknown }
        | undefined;
      const cardCount = Array.isArray(data?.cards) ? data.cards.length : 0;
      const contentId = Array.isArray(data?.contentIds) ? data.contentIds[0] : undefined;
      if (typeof data?.conversationId === "string" && data.conversationId) {
        settledConversationId = data.conversationId;
        if (turnId) noteTurnConversation(turnId, data.conversationId);
      }
      // 中止的 run 不许在任务带上冒充「完成」（中止 ≠ 取消:已投递的后台任务继续跑）
      const aborted = data?.stopReason === "aborted";
      void emitEngineEvent(
        {
          role: "system",
          kind: "run_done",
          runId,
          label: aborted
            ? "本轮已停（已投递的后台任务继续跑）"
            : cardCount > 0
              ? `任务完成 · 产出 ${cardCount} 张卡片`
              : "任务已受理",
          ...(contentId ? { contentId } : {}),
        },
        dataDir,
      );
    } else {
      void emitEngineEvent(
        {
          role: "system",
          kind: "run_failed",
          runId,
          label: `任务中断：${String((result as { error?: unknown }).error ?? "未知错误").slice(0, 60)}`,
        },
        dataDir,
      );
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void emitEngineEvent(
      { role: "system", kind: "run_failed", runId, label: `任务中断：${msg.slice(0, 60)}` },
      dataDir,
    );
    return { ok: false, error: msg };
  } finally {
    // settle 才解锁:注册表条目从登记一直活到本轮真正收尾（含落盘），
    // 否则用户点完停止立刻再发言,新轮会和上一轮的收尾并行跑（二审 新1）。
    if (turnId) {
      await settleTurn(turnId, {
        ...(settledConversationId ? { conversationId: settledConversationId } : {}),
        ...(dataDir ? { dataDir } : {}),
      });
    }
  }
}

// ── chat:abort / chat:turn_status — 中止链路与断线恢复（设计 §Phase 3）─────────

async function chatAbortHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
  const clientId = typeof payload.client_id === "string" ? payload.client_id : "";
  if (!turnId || !clientId) return { ok: false, error: "chat:abort 需要 turn_id 与 client_id" };
  const outcome = abortTurn(turnId, clientId);
  // 归属不符 = 另一个标签页想停别人的轮:明说拒绝,不假装已完成
  if (outcome === "forbidden") return { ok: false, error: "这一轮不是本页面发起的，请回到发起它的页面停止" };
  // 已完成/未知一律幂等:停止连点、停已经结束的轮,用户视角都该是「停了就是停了」
  if (outcome === "not_found") return { ok: true, already: "done" };
  return { ok: true, settling: true };
}

/**
 * chat:model_options — 右栏模型切换器的数据源（只读）。
 * 回的是「模型名 + 档位字」，**不含 apiKey/baseUrl**：凭证不出主进程。
 * 引擎没配置就回空清单——前端据此隐藏切换器（配 key 的地方是设置页，不在这里喊）。
 */
async function chatModelOptionsHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const config = await loadEngineConfig((payload._dataDir as string) || undefined);
    return { ok: true, data: { options: chatModelOptions(config) } };
  } catch {
    return { ok: true, data: { options: [] } };
  }
}

async function chatTurnStatusHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
  if (!turnId) return { ok: false, error: "chat:turn_status 需要 turn_id" };
  const view = await getTurnStatus(turnId, (payload._dataDir as string) || undefined);
  return { ok: true, data: view };
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
  // industry / platforms / focusKeywords 均可选，至少给一个（席位编辑不必带定位，反之亦然）
  const updates: { industry?: string; platforms?: string[]; focusKeywords?: string[] } = {};
  if (typeof payload.industry === "string" && payload.industry.trim() !== "") {
    updates.industry = payload.industry.trim();
  }
  if (Array.isArray(payload.platforms)) {
    updates.platforms = (payload.platforms as unknown[]).filter(
      (p): p is string => typeof p === "string" && p.trim() !== "",
    );
  }
  // 雷达粗筛关键词:空数组=显式清空(回落定位派生),故按字段存在性而非非空判定
  if (Array.isArray(payload.focusKeywords)) {
    updates.focusKeywords = (payload.focusKeywords as unknown[])
      .map((k) => (typeof k === "string" ? k.trim() : ""))
      .filter((k) => k !== "");
  }
  if (updates.industry === undefined && updates.platforms === undefined && updates.focusKeywords === undefined) {
    return { ok: false, error: "需要 industry、platforms 或 focusKeywords 至少其一" };
  }
  try {
    const profile = await updateProfile(updates, (payload._dataDir as string) || undefined);
    return {
      ok: true,
      data: { industry: profile.industry, platforms: profile.platforms, focusKeywords: profile.focusKeywords ?? [] },
    };
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

/** 收下一版对话式修改：存新版本 + 采纳即学习闸门（有 before+feedback 才沉淀）。 */
async function draftAdoptRevisionHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const contentId = typeof payload.content_id === "string" ? payload.content_id : "";
  if (!isContentId(contentId)) return { ok: false, error: "需要合法 content_id" };
  const body = typeof payload.body === "string" ? payload.body : "";
  if (!body.trim()) return { ok: false, error: "需要 body" };
  const dataDir = (payload._dataDir as string) || undefined;
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : undefined;
  const before = typeof payload.before === "string" ? payload.before : "";
  const feedback = typeof payload.feedback === "string" ? payload.feedback.trim() : "";
  try {
    const note = feedback ? `收下修改：${feedback.replace(/\s+/g, " ").slice(0, 80)}` : "收下修改";
    // revise_focus 的落盘点在这儿（它自己不落库）：收下改稿即审稿结论过期（审稿 spec §2.7）——
    // 改过的稿不得继续顶着「已 AI 审稿」的徽章。没审过的稿不新增字段。
    const before0 = await getContent(contentId, dataDir);
    const updated = await updateContent(
      contentId,
      {
        body,
        ...(title ? { title } : {}),
        _versionNote: note,
        ...(before0?.review ? { review: { ...before0.review, status: "stale" as const } } : {}),
      },
      dataDir,
    );
    if (!updated) return { ok: false, error: `稿件不存在：${contentId}` };
    // 采纳即学习闸门：正文确有变化才把 before→after 喂给蒸馏管线（延迟学习，不确认不学）
    if (!before || before === body) return { ok: true, content: updated };
    try {
      await recordDiff(contentId, "body", before, body, dataDir, feedback || undefined, updated.platform);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: true, content: updated, warning: `diff 记录失败：${msg}，稿件已正常保存` };
    }
    // 采纳时刻即学习时刻（对话式修订设计）：攒够 diff 就当场把规则学出来。
    // best-effort——没配模型/蒸馏出错都不该让「收下这版」失败，稿件早已落盘。
    let styleLearned: StyleDistillResult | undefined;
    try {
      if (await shouldDistillStyle(dataDir)) styleLearned = await distillStyleRules(dataDir);
    } catch {
      /* 蒸馏是附加收益，收稿本身已完成 */
    }
    return styleLearned ? { ok: true, content: updated, styleLearned } : { ok: true, content: updated };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
    // meta 整条直出（含可选 contentId）——右栏靠它判断「这篇稿件名下有没有会话」
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
    const dataDir = (payload._dataDir as string) || undefined;
    const result = await addLibraryAssets(paths as string[], folderId, dataDir);
    // 入库即 ffprobe 并持久化（lifecycle §1）：构目录时同步探等于每跑一次剪辑师就探一遍全库
    await probeImportedAssets(result.added, dataDir);
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
  if (payload.folder_id !== undefined)
    patch.folderId = typeof payload.folder_id === "string" && payload.folder_id ? payload.folder_id : null;
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

/**
 * 常备素材池开关（视频线 lifecycle spec §1）。判定全在 `library-pool`：
 * 说明非空、类型对、文件在、视频探得出时长——**拒绝要给人话**，不是静默不生效。
 */
async function librarySetReusableHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bad = guardPayload(payload);
  if (bad) return bad;
  const id = payload.id;
  if (typeof id !== "string" || !id) return { ok: false, error: "需要 id" };
  if (typeof payload.reusable !== "boolean") return { ok: false, error: "reusable 必须是布尔值" };
  try {
    const result = await setLibraryReusable(id, payload.reusable, (payload._dataDir as string) || undefined);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, data: { asset: result.asset, ...(result.warning ? { warning: result.warning } : {}) } };
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
  if (!isContentId(contentId)) return { ok: false, error: "需要合法 content_id" };
  if (typeof libraryId !== "string" || !libraryId) return { ok: false, error: "需要 library_id" };
  try {
    const result = await attachLibraryAsset({
      contentId,
      libraryId,
      ...((payload._dataDir as string) ? { dataDir: payload._dataDir as string } : {}),
      role: payload.role,
      description: payload.description,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, data: { asset: result.asset, ...(result.warning ? { warning: result.warning } : {}) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function contentAssetRemoveHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bad = guardPayload(payload);
  if (bad) return bad;
  const contentId = payload.content_id;
  const filename = payload.filename;
  if (!isContentId(contentId)) return { ok: false, error: "需要合法 content_id" };
  if (!isSafeFilename(filename)) {
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
export function buildIpcHandlers(deps?: Partial<Record<IpcChannel, IpcHandler>>): Record<IpcChannel, IpcHandler> {
  const defaults: Record<IpcChannel, IpcHandler> = {
    "flywheel:report": wrapExecute(executeFlywheel as ExecuteFn, CHANNEL_ACTIONS["flywheel:report"]),
    "generate:script": generateBackgroundHandler,
    "generate:retry": generateRetryHandler,
    "style:distill": wrapExecute(executeStyle as ExecuteFn, CHANNEL_ACTIONS["style:distill"]),
    "style:absorb": wrapExecute(executeStyle as ExecuteFn, CHANNEL_ACTIONS["style:absorb"]),
    "style:rules": styleRulesHandler,
    "content:list": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:list"]),
    "content:get": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:get"]),
    "publish:clipboard": wrapExecute(executePublish as ExecuteFn, CHANNEL_ACTIONS["publish:clipboard"]),
    "publish:preflight": wrapExecute(executePrePublish as ExecuteFn, CHANNEL_ACTIONS["publish:preflight"]),
    "publish:digest": wrapExecute(executePublish as ExecuteFn, CHANNEL_ACTIONS["publish:digest"]),
    "publish:confirm": withActionRecord(
      wrapExecute(executePublish as ExecuteFn, CHANNEL_ACTIONS["publish:confirm"]),
      "published",
    ),
    // 发布前检查：与公众号推送门（publish:request_wechat）同一套 executePrePublish，
    // 差别是这条不发凭证——它只跑检查，全过由 pre-publish 自己流转到 publish_ready
    "publish:pre_check": wrapExecute(executePrePublish as ExecuteFn, CHANNEL_ACTIONS["publish:pre_check"]),
    "publish:request_wechat": requestWechatDraftApprovalHandler,
    "publish:wechat_draft": publishWechatDraftApprovedHandler,
    "article_images:get": articleImagesGetHandler,
    "article_images:generate": articleImagesGenerateHandler,
    "article_images:regenerate": articleImagesRegenerateHandler,
    "article_images:remove": articleImagesRemoveHandler,
    "article_images:suggest": articleImagesSuggestHandler,
    "article_images:add_slot": articleImagesAddSlotHandler,
    "article_images:remove_slot": articleImagesRemoveSlotHandler,
    "article_images:upload": articleImagesUploadHandler,
    "chat:turn": chatTurnHandler,
    "chat:abort": chatAbortHandler,
    "chat:turn_status": chatTurnStatusHandler,
    "chat:model_options": chatModelOptionsHandler,
    "settings:get": getEngineSettings,
    "settings:set": setEngineSettings,
    "settings:open_config": (payload) => openEngineConfigFile(payload),
    // 第二参显式丢掉:handler 的 ctx 与 testEngineRoute 的测试注入口不是一回事
    "settings:test_route": (payload) => testEngineRoute(payload),
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
    "cover:identity": coverIdentityHandler,
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
    "flywheel:wechat_pull": wechatPullHandler,
    "flywheel:pull_status": pullStatusHandler,
    "flywheel:pull_now": pullNowHandler,
    "flywheel:pull_toggle": pullToggleHandler,
    "flywheel:hypotheses_list": hypothesesListHandler,
    "dialog:pick_file": dialogUnavailableHandler,
    "knowledge:status": knowledgeStatusHandler,
    "radar:status": getRadarStatus,
    "radar:refresh": (payload) => doRadarRefresh(payload),
    "radar:more": (payload) => collectMoreRadarTopics(payload),
    "radar:rescore": (payload) => rescoreRadarTopics(payload),
    "radar:sources_set": setRadarSources,
    "profile:update": profileUpdateHandler,
    "content:update": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:update"]),
    "content:transition": withActionRecord(
      wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:transition"]),
      "transition",
    ),
    "content:allowed_transitions": wrapExecute(
      executeContentSave as ExecuteFn,
      CHANNEL_ACTIONS["content:allowed_transitions"],
    ),
    "content:adoption": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:adoption"]),
    "content:delete": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:delete"]),
    "content:restore": wrapExecute(executeContentSave as ExecuteFn, CHANNEL_ACTIONS["content:restore"]),
    "content:open_folder": contentOpenFolderHandler,
    "topics:list": topicsListHandler,
    "topic:create": topicCreateHandler,
    "topic:update": topicUpdateHandler,
    "topic:delete": topicDeleteHandler,
    "topic:restore": topicRestoreHandler,
    "topic:select_angle": topicSelectAngleHandler,
    "topic:clear_angle": topicClearAngleHandler,
    "trash:list": trashListHandler,
    "content:versions": contentVersionsHandler,
    "content:revert": contentRevertHandler,
    "draft:rewrite_selection": rewriteSelectionHandler,
    "draft:adopt_revision": draftAdoptRevisionHandler,
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
    "library:set_reusable": librarySetReusableHandler,
    "dialog:pick_media": dialogPickMediaUnavailableHandler,
    "content:asset_add": contentAssetAddHandler,
    "content:asset_remove": contentAssetRemoveHandler,
    "today:summary": todaySummaryHandler,
    "dashboard:summary": dashboardSummaryHandler,
    "events:recent": eventsRecentHandler,
    "workspace:list": workspaceListHandler,
    "workspace:create": workspaceCreateHandler,
    "workspace:switch": workspaceSwitchHandler,
    "campaign:list": campaignListHandler,
    "campaign:get": campaignGetHandler,
    "campaign:create": campaignCreateHandler,
    "campaign:plan_team": campaignPlanTeamHandler,
    "campaign:transition": campaignTransitionHandler,
    "campaign:run_ready": campaignRunReadyHandler,
    "campaign:retry_task": campaignRetryTaskHandler,
    "campaign:artifact_get": campaignArtifactGetHandler,
    "campaign:set_autonomy": campaignSetAutonomyHandler,
    "campaign:patch_propose": campaignPatchProposeHandler,
    "campaign:patch_decide": campaignPatchDecideHandler,
    "campaign:replan": campaignReplanHandler,
    "doctor:inbox": (payload) => inboxDoctorHandler(payload),
    "inbox:list": inboxListHandler,
    "inbox:retry": inboxRetryHandler,
    "inbox:delete": inboxDeleteHandler,
    "inbox:reingest": inboxReingestHandler,
    "inbox:settings_get": getInboxSettings,
    "inbox:settings_set": setInboxSettings,
    "inbox:status": inboxStatusHandler,
    "patterns:list": patternsListHandler,
    "patterns:update": patternsUpdateHandler,
    "patterns:delete": patternsDeleteHandler,
    "research:deep_dive": researchDeepDiveHandler,
    "research:status": researchStatusHandler,
    "research:brief_get": researchBriefGetHandler,
    "research:list_assets": researchListAssetsHandler,
    "research:import_asset": researchImportAssetHandler,
    "video:build_start": videoBuildStartHandler,
    "video:status": videoStatusHandler,
    "video:transcript_get": videoTranscriptGetHandler,
    "video:cut_confirm": videoCutConfirmHandler,
    "video:rough_cut_rerun": videoRoughCutRerunHandler,
    "video:transcribe_rerun": videoTranscribeRerunHandler,
    "video:transcript_text_edit": videoTranscriptTextEditHandler,
    "video:editor_plan_get": videoEditorPlanGetHandler,
    "video:editor_confirm": videoEditorConfirmHandler,
    "video:editor_rerun": videoEditorRerunHandler,
    "video:editor_slot_fill": videoEditorSlotFillHandler,
    "video:editor_slot_remove": videoEditorSlotRemoveHandler,
    "video:editor_back_to_cut": videoEditorBackToCutHandler,
    "video:cut_preview": videoCutPreviewHandler,
    "video:reassemble": videoReassembleHandler,
    "video:review_confirm": videoReviewConfirmHandler,
    "video:retry": videoRetryHandler,
    "video:asr_warmup": videoAsrWarmupHandler,
    "video:asr_status": videoAsrStatusHandler,
    "video:settings_get": getVideoSettings,
    "video:settings_set": setVideoSettings,
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

/**
 * 提炼门槛（码点计数,中文一字一码点）:超过这个长度的输入已经不是标题，是一段碎片想法。
 * 短输入照旧直存——用户认真写好的一句话标题不该被 AI 再改一遍。
 */
const IDEA_DISTILL_MIN_CHARS = 30;

/** 引擎抛错等同「没提炼出来」——提炼是增益,不是入库的前置条件,永远不该把异常掀到调用方 */
async function tryDistillIdea(
  title: string,
  dataDir: string | undefined,
  distill: typeof distillIdeaTopic,
): Promise<DistilledIdea | null> {
  try {
    return await distill(title, dataDir);
  } catch {
    return null;
  }
}

/**
 * 手动/对话入库（IA v4.2 §A2）——「＋新想法」与候选卡按钮的落库通道。
 *
 * 手动丢进来的长文本先过一次提炼:看板卡片要的是选题，不是几百字原文。
 * 提炼失败绝不吞灵感——照原文落库并把 warning 带回前端，让用户知道要自己改标题。
 */
export async function topicCreateHandler(
  payload: Record<string, unknown>,
  _ctx?: IpcHandlerContext,
  deps?: { distill?: typeof distillIdeaTopic },
): Promise<Record<string, unknown>> {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title) return { ok: false, error: "title is required" };
  const dataDir = (payload._dataDir as string) || undefined;
  const source = typeof payload.source === "string" && payload.source ? payload.source : "manual";
  const description = typeof payload.description === "string" && payload.description ? payload.description : "";

  const shouldDistill = source === "manual" && [...title].length > IDEA_DISTILL_MIN_CHARS;
  const idea = shouldDistill ? await tryDistillIdea(title, dataDir, deps?.distill ?? distillIdeaTopic) : null;

  try {
    const topic = await saveTopic(
      {
        title: idea ? idea.title : title,
        // 提炼摘要在前、原文垫底:卡片和派活 brief 先看到能读的正文;原文永远留着当材料,
        // 提炼只换了个能用的标题,不该吃掉用户写下的东西
        description: idea
          ? (idea.summary ? `${idea.summary}\n\n——原始灵感——\n\n` : "") +
            (description ? `${description}\n\n${title}` : title)
          : description || title,
        tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : [],
        source,
        ...(typeof payload.reason === "string" && payload.reason ? { reason: payload.reason } : {}),
        ...(typeof payload.link === "string" && payload.link ? { link: payload.link } : {}),
        ...(idea
          ? {
              score: idea.totalScore,
              scoredAt: new Date().toISOString(),
              scoreBreakdown: idea.scoreBreakdown,
              ...(idea.angles.length ? { angles: idea.angles } : {}),
            }
          : {}),
      },
      dataDir,
    );
    if (!shouldDistill) return { ok: true, topic };
    return idea
      ? { ok: true, topic, distilled: true }
      : { ok: true, topic, distilled: false, warning: "标题提炼失败，已按原文保存，可在看板改标题" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function topicUpdateHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = payload.id as string;
  if (!id) return { ok: false, error: "id is required" };
  const updates: { title?: string; description?: string; reason?: string } = {};
  if (typeof payload.title === "string" && payload.title.trim()) updates.title = payload.title.trim();
  if (typeof payload.description === "string") updates.description = payload.description.trim();
  if (typeof payload.reason === "string") updates.reason = payload.reason.trim();
  if (Object.keys(updates).length === 0) return { ok: false, error: "没有可更新的字段" };
  try {
    const topic = await updateTopic(id, updates, (payload._dataDir as string) || undefined);
    if (!topic) return { ok: false, error: `Topic ${id} not found` };
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

// ── 角度点选（角度卡 spec §1.4：点选 / 改写 / 清除） ─────────────────────────

/**
 * 落一张生效角度卡。两道校验缺一不可：
 * 1. `brief_revision` 必须是**当前生效那版**（`job.briefRevision` 指针，P1 §3.0）——对不上
 *    说明用户看的是过期候选（简报重跑过），
 *    这时候照落等于让他在不知情的情况下选了一张已经不存在的卡；
 * 2. `angle_id` 必须在那版简报里；改写版（可选 `card`）还要过一遍字段与证据引用校验，
 *    创始人能改任何文字，但改不出简报里没有的证据。
 */
async function topicSelectAngleHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const topicId = typeof payload.topic_id === "string" ? payload.topic_id.trim() : "";
  const angleId = typeof payload.angle_id === "string" ? payload.angle_id.trim() : "";
  const revision = payload.brief_revision;
  if (!topicId || !angleId) return { ok: false, error: "topic_id 与 angle_id 必填" };
  if (typeof revision !== "number" || !Number.isInteger(revision)) {
    return { ok: false, error: "brief_revision 必须是整数" };
  }
  const dataDir = (payload._dataDir as string) || undefined;
  try {
    const topic = await getTopic(topicId, dataDir);
    if (!topic) return { ok: false, error: `Topic ${topicId} not found` };
    // 唯一「当前有效简报」入口（P1 §3.0）：认 job.briefRevision 指针，不认磁盘最大版——
    // 磁盘上可能躺着一份重跑失败、从未被采纳的 v(N+1)
    const snap = await resolveEffectiveBrief(topicId, getDataDir(dataDir));
    if (!snap) return { ok: false, error: "这条选题还没有可用简报——先跑一轮深调研" };
    if (snap.revision !== revision) {
      return { ok: false, error: `角度候选已更新（当前 v${snap.revision}，你手上是 v${revision}）——刷新后重选` };
    }
    const original = findAngleCard(snap.brief, angleId);
    if (!original) return { ok: false, error: `角度 ${angleId} 不在简报 v${snap.revision} 里` };
    // 没给 card = 点选原卡；给了 = 改写版（§1.4 改写才是创始人观点进管线的口子）
    const card = payload.card === undefined ? original : parseAngleCard(payload.card, snap.brief, angleId);
    if (typeof card === "string") return { ok: false, error: card };
    const updated = await updateTopic(
      topicId,
      { selectedAngle: { briefRevision: snap.revision, angleId, card, selectedAt: new Date().toISOString() } },
      dataDir,
    );
    return { ok: true, topic: updated };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 撤回选择（写稿回到「未经角度点选」）。字段置 undefined 即从盘上消失 */
async function topicClearAngleHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const topicId = typeof payload.topic_id === "string" ? payload.topic_id.trim() : "";
  if (!topicId) return { ok: false, error: "topic_id 必填" };
  try {
    const topic = await updateTopic(topicId, { selectedAngle: undefined }, (payload._dataDir as string) || undefined);
    if (!topic) return { ok: false, error: `Topic ${topicId} not found` };
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
