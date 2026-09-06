/**
 * 视频线 IPC handlers（设计 spec §8.2）——桌面端与 `modules/video/service` 之间唯一的一层。
 *
 * 五条纪律：
 * 1. **只调门面**：runner/store/sidecar 一概不碰，全部经 `VideoService`；这层只做
 *    payload 校验、错误翻译、`videoReadyAt` 盖戳。
 * 2. **service 是 server 启动时建的单例**（生命周期在 desktop/server.ts）。没起来 =
 *    人话返回「视频服务未启动」，不是崩溃，也不假装成功。
 * 3. **工作区必须对得上**：service 跟随启动时的工作区；payload 带来的 `_dataDir` 与它
 *    不符时当场拒绝（切工作区后请重启），绝不把 A 工作区的稿件写进 B 的目录。
 * 4. **冲突是一等结果不是故障**（codex #11）：`VideoConflictError` → `{ok:false,
 *    conflict:true, data:{state}}`，前端据此提示「版本过期，已为你重载」而不是红色报错。
 * 5. **videoReadyAt 只盖一次**（publishedAt 同款）：审片通过后若已有值不覆盖；盖戳失败
 *    不吞——确认照样成功，但 warning 明写在返回里。
 */
import { appendAction } from "./recent-actions.js";
import { isContentId } from "../storage/entity-id.js";
import {
  parseCutArgs,
  parseEditorPlanArgs,
  parsePreviewArgs,
  parseReviewArgs,
  parseRevision,
  parseSlotArgs,
  parseSlotFillArgs,
  parseTextEditArgs,
} from "../modules/video/payload.js";
import {
  getVideoRuntimeStatus,
  resolveVideoService,
  setVideoService,
} from "../modules/video/service-registry.js";
import { clearVideoDone, stampVideoReady } from "../modules/video/video-done.js";
import { VideoConflictError, type VideoService } from "../modules/video/service.js";

type Payload = Record<string, unknown>;
type Reply = Record<string, unknown>;

/**
 * 单例与工作区校验搬去了 `modules/video/service-registry.ts`（P3c §14.2）——
 * `autocrew_video` 与桌面必须拿到**同一个** service 实例（进程内队列、启动恢复只能有一份）。
 * 这里原样再导出，server 与既有测试的接线口不变。
 */
export { getVideoRuntimeStatus, setVideoService };
export type { VideoService };

type Resolved = { ok: true; service: VideoService; dataDir: string } | { ok: false; reply: Reply };

/**
 * 取 service 并校验工作区。`_dataDir` 由 server 端注入（default 工作区不注入，
 * 因此缺省即视为命中）——不符不是降级而是拒绝，避免跨工作区写坏状态。
 */
function resolve(payload: Payload): Resolved {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reply: { ok: false, error: "Invalid payload: expected object" } };
  }
  const resolved = resolveVideoService(typeof payload._dataDir === "string" ? payload._dataDir : undefined);
  return resolved.ok ? resolved : { ok: false, reply: { ok: false, error: resolved.error } };
}

function requireContentId(payload: Payload): string | null {
  return isContentId(payload.content_id) ? (payload.content_id as string) : null;
}

/** 冲突单独成形（前端要能区分「版本过期请刷新」与真故障）；其余错误人话原样透传 */
function fail(err: unknown): Reply {
  if (err instanceof VideoConflictError) {
    return { ok: false, conflict: true, error: err.message, data: { state: err.current } };
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

// ── handlers ─────────────────────────────────────────────────────────────────

/** 投递即返回（§0.3）：只落 queued + 入队，ASR/渲染在 runner 里跑 */
export async function videoBuildStartHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  try {
    return { ok: true, data: { state: await ctx.service.startBuild(contentId) } };
  } catch (err) {
    return fail(err);
  }
}

/** 没开始剪 = data:null，不是错误（前端据此显示「开始剪」按钮） */
export async function videoStatusHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  try {
    return { ok: true, data: await ctx.service.getStatus(contentId) };
  } catch (err) {
    return fail(err);
  }
}

export async function videoTranscriptGetHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  try {
    return { ok: true, data: await ctx.service.getTranscript(contentId) };
  } catch (err) {
    return fail(err);
  }
}

export async function videoCutConfirmHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  const args = parseCutArgs(payload);
  if (typeof args === "string") return { ok: false, error: args };
  try {
    // done 上确认 = 重开（改选段再出一版）。这是全仓唯一一条离开 done 的边
    // （video state-machine 的回退白名单里只有 done/done → edit/queued），
    // 所以 `videoDone` 的清除点就这一处：旧成片当场作废，重新审过才能再推进到封面。
    const before = await ctx.service.getStatus(contentId);
    const state = await ctx.service.confirmCut(contentId, args);
    if (before?.state?.phase === "done") await clearVideoDone(contentId, ctx.dataDir);
    void appendAction(ctx.dataDir, { kind: "video_cut", contentId }); // 工作区动作进有界环（设计 §Phase 2）
    return { ok: true, data: { state } };
  } catch (err) {
    return fail(err);
  }
}

/** 成片计划（剪辑师排的 B-roll）；还没跑过 = data:null，不是错误 */
export async function videoEditorPlanGetHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  try {
    return { ok: true, data: await ctx.service.getEditorPlan(contentId) };
  } catch (err) {
    return fail(err);
  }
}

/** 确认成片计划：留下的 overlay 落成覆盖轨槽位，随后自动进组装 */
export async function videoEditorConfirmHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  const args = parseEditorPlanArgs(payload);
  if (typeof args === "string") return { ok: false, error: args };
  try {
    return { ok: true, data: { state: await ctx.service.confirmEditorPlan(contentId, args) } };
  } catch (err) {
    return fail(err);
  }
}

/** 给待生成槽填素材：返回**派生出的新一版 plan**，前端直接换手里那份，不用再拉一次 */
export async function videoEditorSlotFillHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  const args = parseSlotFillArgs(payload);
  if (typeof args === "string") return { ok: false, error: args };
  try {
    return { ok: true, data: await ctx.service.fillEditorSlot(contentId, args) };
  } catch (err) {
    return fail(err);
  }
}

/** 删掉一段编排：与填槽走同一个派生函数，同样返回新一版 plan */
export async function videoEditorSlotRemoveHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  const args = parseSlotArgs(payload);
  if (typeof args === "string") return { ok: false, error: args };
  try {
    return { ok: true, data: await ctx.service.removeEditorSlot(contentId, args) };
  } catch (err) {
    return fail(err);
  }
}

/** 门二退回门一：改选段重来（判定与乐观锁在 service / editor-gate） */
export async function videoEditorBackToCutHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  const planRevision = parseRevision(payload.plan_revision, "plan_revision");
  if (typeof planRevision === "string") return { ok: false, error: planRevision };
  try {
    return { ok: true, data: { state: await ctx.service.editorBackToCut(contentId, { planRevision }) } };
  } catch (err) {
    return fail(err);
  }
}

/** 门内重渲预览：投递即返回，主状态不动，渲完走 SSE 刷新（判定在 service） */
export async function videoCutPreviewHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  const args = parsePreviewArgs(payload);
  if (typeof args === "string") return { ok: false, error: args };
  try {
    return { ok: true, data: { state: await ctx.service.requestCutPreview(contentId, args) } };
  } catch (err) {
    return fail(err);
  }
}

/** 渲染失败的死路出口：回组装重出一份 manifest（判定在 service） */
export async function videoReassembleHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  try {
    return { ok: true, data: { state: await ctx.service.reassemble(contentId) } };
  } catch (err) {
    return fail(err);
  }
}

/** 重跑剪辑师：只在 edit/awaiting_human 上可用（判定在 service） */
export async function videoEditorRerunHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  try {
    return { ok: true, data: { state: await ctx.service.rerunEditor(contentId) } };
  } catch (err) {
    return fail(err);
  }
}

/** 重跑 AI 粗剪：只在 cut/awaiting_human 且没人工终裁时可用（判定在 service） */
export async function videoRoughCutRerunHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  try {
    return { ok: true, data: { state: await ctx.service.rerunRoughCut(contentId) } };
  } catch (err) {
    return fail(err);
  }
}

/** 重跑转写：只在 cut/awaiting_human 上可用，会作废这一版选段与手改（判定在 service） */
export async function videoTranscribeRerunHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  try {
    return { ok: true, data: { state: await ctx.service.rerunTranscribe(contentId) } };
  } catch (err) {
    return fail(err);
  }
}

/**
 * 手工改一句的文字：落新一版清洗文字 + 同号的新 cut/单元表（判定与产物在 cut-gate）。
 * 版本对不上是**冲突不是故障**——`fail` 会把它翻成 `conflict:true`，前端重载后重改。
 */
export async function videoTranscriptTextEditHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  const args = parseTextEditArgs(payload);
  if (typeof args === "string") return { ok: false, error: args };
  try {
    return { ok: true, data: { state: await ctx.service.editTranscriptText(contentId, args) } };
  } catch (err) {
    return fail(err);
  }
}

/**
 * 审片确认。approve → done 并盖 `videoReadyAt`（只盖一次）+ 排收尾清理；
 * reject → 按 target 回门二（改 B-roll）或门一（改选段），备注与定位落不可变记录。
 * 盖戳失败不改变确认结果，但 warning 必须可见（复盘的第四段用时靠这枚戳）。
 */
export async function videoReviewConfirmHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  const args = parseReviewArgs(payload);
  if (typeof args === "string") return { ok: false, error: args };
  try {
    const state = await ctx.service.confirmReview(contentId, args);
    if (args.verdict !== "approve") return { ok: true, data: { state } };
    void appendAction(ctx.dataDir, { kind: "video_reviewed", contentId }); // 工作区动作进有界环（设计 §Phase 2）
    const stamped = await stampVideoReady(contentId, state.revisions.rendered ?? 0, ctx.dataDir);
    return { ok: true, data: { state, ...stamped } };
  } catch (err) {
    return fail(err);
  }
}

/** 重试：failed 重投 failedPhase，blocked 重投当前 phase（判定在 service） */
export async function videoRetryHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  try {
    return { ok: true, data: { state: await ctx.service.retry(contentId) } };
  } catch (err) {
    return fail(err);
  }
}

/** 预热 ASR 模型（首跑约 1GB 下载）——投递即返回，进度轮 video:asr_status */
export async function videoAsrWarmupHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  try {
    return { ok: true, data: await ctx.service.warmupAsr() };
  } catch (err) {
    return fail(err);
  }
}

export async function videoAsrStatusHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  try {
    return { ok: true, data: await ctx.service.asrStatus() };
  } catch (err) {
    return fail(err);
  }
}
