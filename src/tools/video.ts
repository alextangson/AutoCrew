/**
 * `autocrew_video` —— 剪辑师那张桌上的全部动作（P3c spec §14.2）。
 *
 * 一个工具、动作与门面一一对应，**全部经 `createVideoService`**（spec §11 第 19 条：
 * P3c 不能绕过视频 runner 的租约与 CAS）。这里不碰 store、不碰 runner、不自己判状态——
 * 那些判定住在三道门里，宿主稿与工作台走的是同一份代码，这正是「门禁不因换宿主变松」。
 *
 * 四条纪律：
 * 1. **投递即返回**：start / 各种重跑 / 预览都只把任务排上队就回（runner 本来就是异步的），
 *    宿主轮询 `status`——MCP 宿主 60 秒就掐工具调用（P3a 教训）。
 * 2. **服务与桌面共用一份**（`service-registry.ts`）：一个工作区只能有一条队列在写盘。
 * 3. **冲突是结果不是故障**：`VideoConflictError` → `{ok:false, conflict:true, state}`，
 *    宿主重新读状态再来，不重试同一份提交。
 * 4. **审片通过要盖章**：`confirmReview` 只推 `done/done`，阶段闸认的是 `Content.videoDone`，
 *    所以 approve 之后必须走共用的 `stampVideoReady`（否则稿件永远推不进封面台）。
 */
import { Type } from "@sinclair/typebox";

import { isContentId } from "../storage/entity-id.js";
import { getDataDir } from "../storage/local-store.js";
import { parseArrayArg } from "../modules/video/tool-args.js";
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
import { clearVideoDone, stampVideoReady } from "../modules/video/video-done.js";
import type { VideoService, VideoStatus } from "../modules/video/service.js";
import type { VideoState } from "../modules/video/types.js";
import { editorPlanViewOf, nextHint, transcriptViewOf } from "./video-views.js";
import { gateVideoWrite, videoError, videoFail, videoService, type VideoToolResult } from "./video-gates.js";

const ACTIONS = [
  "status",
  "start",
  "transcript",
  "cut_confirm",
  "transcript_edit",
  "cut_preview",
  "rough_cut_rerun",
  "transcribe_rerun",
  "editor_plan",
  "editor_slot_fill",
  "editor_slot_remove",
  "editor_back_to_cut",
  "editor_confirm",
  "editor_rerun",
  "reassemble",
  "retry",
  "review",
  "asr_status",
] as const;
type VideoAction = (typeof ACTIONS)[number];

/** 只读动作不过令牌门（看不改，别的宿主在剪也该看得见） */
const READ_ONLY = new Set<VideoAction>(["status", "transcript", "editor_plan", "asr_status"]);

export const videoSchema = Type.Object({
  action: Type.Unsafe<VideoAction>({
    type: "string",
    enum: [...ACTIONS],
    description: ACTIONS.join(" | "),
  }),
  content_id: Type.Optional(Type.String({ description: "稿件 id（asr_status 之外都必填）" })),
  full: Type.Optional(Type.Boolean({ description: "transcript：true 才带逐词时间戳（默认紧凑视图）" })),
  keeps: Type.Optional(
    Type.Array(Type.String(), { description: "cut_confirm / cut_preview：留下的分句 id（顺序无关，至少一条）" }),
  ),
  flags: Type.Optional(
    Type.Array(Type.Object({ segment_id: Type.String(), flag: Type.String() }), {
      description: "cut_confirm：给人看的标记，flag 只能是 misread / repeat / offtopic；不影响留不留",
    }),
  ),
  base_transcript_revision: Type.Optional(
    Type.Integer({ description: "cut_confirm / cut_preview / transcript_edit：transcript 读到的版本号（乐观锁）" }),
  ),
  base_cut_revision: Type.Optional(
    Type.Integer({ description: "cut_confirm / cut_preview / transcript_edit：选段版本号（乐观锁）" }),
  ),
  base_clean_revision: Type.Optional(Type.Integer({ description: "transcript_edit：清洗文字版本号（乐观锁）" })),
  unit_id: Type.Optional(Type.String({ description: "transcript_edit：要改哪一句" })),
  text: Type.Optional(Type.String({ description: "transcript_edit：改成什么（只改字，门不动）" })),
  plan_revision: Type.Optional(
    Type.Integer({ description: "editor_* 系列：editor_plan 读到的 plan_revision（乐观锁）" }),
  ),
  overlay_id: Type.Optional(Type.String({ description: "editor_slot_fill / editor_slot_remove：哪一段编排" })),
  library_id: Type.Optional(Type.String({ description: "editor_slot_fill：素材库里那条素材的 id" })),
  kept_overlay_ids: Type.Optional(
    Type.Array(Type.String(), { description: "editor_confirm：留下哪几段（只能删不能改）；[] 合法 = 纯口播" }),
  ),
  rendered_revision: Type.Optional(Type.Integer({ description: "review：审的是哪一版成片（乐观锁）" })),
  verdict: Type.Optional(
    Type.Unsafe<"approve" | "revise" | "reject">({
      type: "string",
      enum: ["approve", "revise", "reject"],
      description: "review：approve 通过（会盖成片戳）｜revise / reject 打回",
    }),
  ),
  target: Type.Optional(
    Type.Unsafe<"edit" | "cut">({
      type: "string",
      enum: ["edit", "cut"],
      description: "review 打回去哪道门：edit 改素材编排｜cut 改选段。不给就按时间戳定位推荐",
    }),
  ),
  timestamp_ms: Type.Optional(Type.Integer({ description: "review：创作者在成片时间轴上停的位置（毫秒）" })),
  note: Type.Optional(Type.String({ description: "review：创作者的原话（落进不可变审片记录）" })),
  claim_token: Type.Optional(
    Type.String({
      description:
        "认领令牌（autocrew_desk claim 给的）。别的宿主认领了这篇时，所有写动作都必须带它；没人认领就不用带，动手会自动认领剪辑师桌。",
    }),
  ),
});

export const VIDEO_DESCRIPTION = [
  "AutoCrew 剪辑台：把一篇定稿的视频稿从口播原片剪成成片。机器步骤你自己跑，**三道门都是创作者的决定**。",
  "1) status{content_id}：状态 + 后台任务 + next（下一步的人话）。所有排队动作都是投递即返回，靠轮询 status 等结果，别重复投递。",
  "2) start{content_id}：开工（导入 → 转写 → AI 粗剪）。转写十几分钟起，轮询 status。",
  "3) transcript{content_id, full?}：读转写与 AI 粗剪建议（紧凑视图：每句 id、起止毫秒、文字、suggested_drop 的标记与引句）。回执里的 base_* 就是下一步要原样带回的版本号。",
  "4) cut_confirm{content_id, keeps, flags?, base_transcript_revision, base_cut_revision}：**创作者点头之后**才确认选段。transcript_edit 改错字、cut_preview 出一版低清预览、rough_cut_rerun 重跑建议。transcribe_rerun 会作废已改的字与这一版选段——先问创作者。",
  "5) editor_plan{content_id}：读素材规划（每段 overlay 的落位、时长、来源；generate 是还不存在的画面）。editor_slot_fill 填库里的素材、editor_slot_remove 删一段、editor_back_to_cut 退回选段、editor_rerun 重排。",
  "6) editor_confirm{content_id, plan_revision, kept_overlay_ids}：逐条问过创作者后确认；kept_overlay_ids 传 [] 是合法的「全删，出纯口播」。确认后自动组装渲染。",
  "7) review{content_id, rendered_revision, verdict, target?, timestamp_ms?, note?}：**把成片路径交给创作者看过**再报裁决。approve = 通过并盖成片戳（阶段闸只认这枚戳）；revise = 打回，target 选 edit / cut，带上创作者的原话。",
  "8) asr_status / retry / reassemble：转写引擎状态、失败重试、渲染死路时回组装重出一份。",
  "冲突：返回 conflict:true 就是别的地方改过——重新读 status / transcript / editor_plan 拿新版本号再来，不要重试同一份提交。",
  "认领：动手会自动认领剪辑师桌（租约 30 分钟）。别的宿主先认领了的稿，写动作要带 claim_token，否则会被拒并告诉你持有者是谁。",
].join("\n");

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 状态型回执：状态在前，人话下一步在后（宿主只看这两样就知道该干什么） */
function stateReply(state: VideoState, extra: VideoToolResult = {}): VideoToolResult {
  return { ok: true, state, next: nextHint({ state, jobs: [] }), ...extra };
}

/**
 * 数组参数归一。中转端点会把工具的数组参数序列化成 JSON 字符串（`tool-args.ts` 开头那段
 * 实机复盘），照 `Array.isArray` 判会把「模型确实传了」当成「没传」。
 */
function normalizeArrays(params: Record<string, unknown>): Record<string, unknown> | string {
  const out = { ...params };
  for (const [field, hint] of [
    ["keeps", "至少留一句"],
    ["kept_overlay_ids", "全删请传 []"],
    ["flags", "没有标记就别传这个字段"],
  ] as const) {
    if (out[field] === undefined || Array.isArray(out[field])) continue;
    const parsed = parseArrayArg(out[field], field, hint);
    if (typeof parsed === "string") return parsed;
    out[field] = parsed;
  }
  return out;
}

/** 打回的两个说法都收：`revise` 是人设里的话，域内只有 approve / reject */
function normalizeVerdict(params: Record<string, unknown>): Record<string, unknown> {
  return params.verdict === "revise" ? { ...params, verdict: "reject" } : params;
}

// ── 只读动作 ────────────────────────────────────────────────────────────────

async function readAction(
  action: VideoAction,
  contentId: string,
  params: Record<string, unknown>,
  service: VideoService,
): Promise<VideoToolResult> {
  if (action === "status") return statusReply(await service.getStatus(contentId));
  if (action === "transcript") return transcriptReply(contentId, params, service);
  return editorPlanReply(contentId, service);
}

function statusReply(status: VideoStatus | null): VideoToolResult {
  return {
    ok: true,
    state: status?.state ?? null,
    jobs: status?.jobs ?? [],
    ...(status?.review ? { review: status.review } : {}),
    next: nextHint(status),
  };
}

async function transcriptReply(
  contentId: string,
  params: Record<string, unknown>,
  service: VideoService,
): Promise<VideoToolResult> {
  const status = await service.getStatus(contentId);
  if (!status) return videoFail("这篇还没开始剪：先 start");
  const view = await service.getTranscript(contentId);
  if (!view) return { ok: true, state: status.state, units: [], next: nextHint(status) };
  return { ok: true, ...transcriptViewOf(view, status.state, params.full === true), next: nextHint(status) };
}

async function editorPlanReply(contentId: string, service: VideoService): Promise<VideoToolResult> {
  const status = await service.getStatus(contentId);
  if (!status) return videoFail("这篇还没开始剪：先 start");
  const view = await service.getEditorPlan(contentId);
  // 还没跑过剪辑师 = 空计划，不是错误（先走完选段那道门）
  if (!view) return { ok: true, plan_revision: 0, overlays: [], note: "剪辑师还没排过素材规划", next: nextHint(status) };
  return { ok: true, ...editorPlanViewOf(view), next: nextHint(status) };
}

// ── 写动作 ──────────────────────────────────────────────────────────────────

/** 参数要解析的那几个（解析失败直接回人话，不进域内） */
type Parsed<T> = T | string;

async function cutConfirm(
  contentId: string,
  params: Record<string, unknown>,
  service: VideoService,
  dataDir: string,
): Promise<VideoToolResult> {
  const args: Parsed<Parameters<VideoService["confirmCut"]>[1]> = parseCutArgs(params);
  if (typeof args === "string") return videoFail(args);
  // done 上确认 = 重开：旧成片当场作废（`videoDone` 的清除点全仓只有这一处）
  const before = await service.getStatus(contentId);
  const state = await service.confirmCut(contentId, args);
  if (before?.state.phase === "done") await clearVideoDone(contentId, dataDir);
  return stateReply(state);
}

async function review(
  contentId: string,
  params: Record<string, unknown>,
  service: VideoService,
  dataDir: string,
): Promise<VideoToolResult> {
  const args = parseReviewArgs(normalizeVerdict(params));
  if (typeof args === "string") return videoFail(args);
  const state = await service.confirmReview(contentId, args);
  if (args.verdict !== "approve") return stateReply(state);
  // 通过之后必须盖章，否则阶段闸永远不放行（§14.1）；盖不上不吞，明写在回执里
  const stamp = await stampVideoReady(contentId, state.revisions.rendered ?? 0, dataDir);
  return stateReply(state, {
    video_ready_at: stamp.videoReadyAt,
    ...(stamp.stampWarning ? { stamp_warning: stamp.stampWarning } : {}),
  });
}

async function editorAction(
  action: VideoAction,
  contentId: string,
  params: Record<string, unknown>,
  service: VideoService,
): Promise<VideoToolResult> {
  if (action === "editor_confirm") {
    const args = parseEditorPlanArgs(params);
    return typeof args === "string" ? videoFail(args) : stateReply(await service.confirmEditorPlan(contentId, args));
  }
  if (action === "editor_slot_fill") {
    const args = parseSlotFillArgs(params);
    if (typeof args === "string") return videoFail(args);
    return { ok: true, ...editorPlanViewOf(await service.fillEditorSlot(contentId, args)) };
  }
  if (action === "editor_slot_remove") {
    const args = parseSlotArgs(params);
    if (typeof args === "string") return videoFail(args);
    return { ok: true, ...editorPlanViewOf(await service.removeEditorSlot(contentId, args)) };
  }
  const planRevision = parseRevision(params.plan_revision, "plan_revision");
  if (typeof planRevision === "string") return videoFail(planRevision);
  return stateReply(await service.editorBackToCut(contentId, { planRevision }));
}

async function writeAction(
  action: VideoAction,
  contentId: string,
  params: Record<string, unknown>,
  service: VideoService,
  dataDir: string,
): Promise<VideoToolResult> {
  if (action === "start") return stateReply(await service.startBuild(contentId));
  if (action === "cut_confirm") return cutConfirm(contentId, params, service, dataDir);
  if (action === "review") return review(contentId, params, service, dataDir);
  if (action.startsWith("editor_") && action !== "editor_rerun") {
    return editorAction(action, contentId, params, service);
  }
  if (action === "cut_preview") {
    const args = parsePreviewArgs(params);
    return typeof args === "string" ? videoFail(args) : stateReply(await service.requestCutPreview(contentId, args));
  }
  if (action === "transcript_edit") {
    const args = parseTextEditArgs(params);
    return typeof args === "string" ? videoFail(args) : stateReply(await service.editTranscriptText(contentId, args));
  }
  if (action === "rough_cut_rerun") return stateReply(await service.rerunRoughCut(contentId));
  if (action === "transcribe_rerun") return stateReply(await service.rerunTranscribe(contentId));
  if (action === "editor_rerun") return stateReply(await service.rerunEditor(contentId));
  if (action === "reassemble") return stateReply(await service.reassemble(contentId));
  return stateReply(await service.retry(contentId));
}

// ── 入口 ────────────────────────────────────────────────────────────────────

export async function executeVideo(raw: Record<string, unknown>): Promise<VideoToolResult> {
  const action = str(raw.action) as VideoAction;
  if (!ACTIONS.includes(action)) {
    return videoFail(`未知 action：${action || "(空)"}。支持：${ACTIONS.join(" | ")}`);
  }
  const params = normalizeArrays(raw);
  if (typeof params === "string") return videoFail(params);
  // 服务与桌面共用同一个实例；没起来就照实说（不在工具进程里另起一条写盘队列）
  const resolved = videoService(params);
  if (!resolved.ok) return videoFail(resolved.error);
  const { service } = resolved;
  const dataDir = resolved.dataDir || getDataDir();

  try {
    if (action === "asr_status") return { ok: true, ...(await service.asrStatus()) };
    const contentId = str(params.content_id);
    if (!isContentId(contentId)) {
      return videoFail("需要合法 content_id（autocrew_desk inbox editor 那张桌上的 content_id）");
    }
    if (!READ_ONLY.has(action)) {
      const denied = await gateVideoWrite(params, contentId, dataDir);
      if (denied) return denied;
    }
    return READ_ONLY.has(action)
      ? await readAction(action, contentId, params, service)
      : await writeAction(action, contentId, params, service, dataDir);
  } catch (err) {
    return videoError(err);
  }
}
