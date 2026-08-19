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
import { getContent, updateContent } from "../storage/local-store.js";
import { appendAction } from "./recent-actions.js";
import { isContentId } from "../storage/entity-id.js";
import { VideoConflictError, type ConfirmCutArgs, type VideoService } from "../modules/video/service.js";
import type { OverlaySlot } from "../modules/video/assemble.js";
import type { AssetRef, CutFlag, CutFlagKind } from "../modules/video/types.js";

type Payload = Record<string, unknown>;
type Reply = Record<string, unknown>;

const FLAG_KINDS: readonly CutFlagKind[] = ["misread", "repeat", "offtopic"];
const NOT_RUNNING = "视频服务没在跑（重启 AutoCrew 后重试；ffmpeg/ASR 状态见 autocrew doctor）";

let current: { service: VideoService; dataDir: string } | null = null;

/** server 启动时接线（传 null 解绑，测试与停机都用它）。dataDir = service 实际工作的工作区 */
export function setVideoService(service: VideoService | null, dataDir?: string): void {
  current = service && dataDir ? { service, dataDir } : null;
}

/** doctor / 设置页读：视频服务是否在跑、跟的是哪个工作区 */
export function getVideoRuntimeStatus(): { running: boolean; dataDir?: string } {
  return current ? { running: true, dataDir: current.dataDir } : { running: false };
}

type Resolved = { ok: true; service: VideoService; dataDir: string } | { ok: false; reply: Reply };

/**
 * 取 service 并校验工作区。`_dataDir` 由 server 端注入（default 工作区不注入，
 * 因此缺省即视为命中）——不符不是降级而是拒绝，避免跨工作区写坏状态。
 */
function resolve(payload: Payload): Resolved {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reply: { ok: false, error: "Invalid payload: expected object" } };
  }
  if (!current) return { ok: false, reply: { ok: false, error: NOT_RUNNING } };
  const want = typeof payload._dataDir === "string" && payload._dataDir ? payload._dataDir : null;
  if (want && want !== current.dataDir) {
    return {
      ok: false,
      reply: { ok: false, error: "视频线跟随启动时的工作区——切换工作区后请重启 AutoCrew 再剪片" },
    };
  }
  return { ok: true, ...current };
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

// ── payload 解析（前端 snake_case ↔ 域内 camelCase） ──────────────────────────

function parseRevision(v: unknown, name: string): number | string {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return `${name} 必须是非负整数`;
  return v;
}

function parseKeeps(v: unknown): string[] | string {
  if (!Array.isArray(v)) return "keeps 必须是分句 id 数组";
  const keeps = v.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  if (keeps.length !== v.length) return "keeps 里有非法分句 id";
  return keeps;
}

function parseFlags(v: unknown): CutFlag[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return "flags 必须是数组";
  const out: CutFlag[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "flags 每项必须是对象";
    const item = raw as Record<string, unknown>;
    const segmentId = item.segment_id ?? item.segmentId;
    const flag = item.flag;
    if (typeof segmentId !== "string" || !segmentId) return "flags 缺 segment_id";
    if (typeof flag !== "string" || !FLAG_KINDS.includes(flag as CutFlagKind)) {
      return `flag 只能是 ${FLAG_KINDS.join(" / ")}`;
    }
    out.push({ segmentId, flag: flag as CutFlagKind });
  }
  return out;
}

function parseAssetRef(v: unknown): AssetRef | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const ref = v as Record<string, unknown>;
  if (ref.kind === "library" && typeof ref.id === "string" && ref.id) return { kind: "library", id: ref.id };
  if (ref.kind === "content" && typeof ref.filename === "string" && ref.filename) {
    return { kind: "content", filename: ref.filename };
  }
  if (ref.kind === "video" && typeof ref.file === "string" && ref.file) return { kind: "video", file: ref.file };
  return null;
}

/** 覆盖轨槽位：人工在选段视图上摆的屏录/图片。深校验（不重叠、不越界）在 assemble */
function parseOverlays(v: unknown): OverlaySlot[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return "overlays 必须是数组";
  const out: OverlaySlot[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "overlays 每项必须是对象";
    const item = raw as Record<string, unknown>;
    const ref = parseAssetRef(item.ref);
    const start = item.output_start_ms ?? item.outputStartMs;
    const duration = item.duration_ms ?? item.durationMs;
    const fit = item.fit;
    if (item.kind !== "screen" && item.kind !== "image") return "overlays.kind 只能是 screen / image";
    if (!ref) return "overlays.ref 必须是 {kind:library|content|video, ...}";
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0) return "overlays.output_start_ms 必须是非负数";
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return "overlays.duration_ms 必须是正数";
    if (fit !== undefined && fit !== "cover" && fit !== "contain") return "overlays.fit 只能是 cover / contain";
    out.push({ kind: item.kind, ref, outputStartMs: start, durationMs: duration, ...(fit ? { fit } : {}) });
  }
  return out;
}

/** cut_confirm 的全部入参一次解析完；任一不合法直接回错误串 */
function parseCutArgs(payload: Payload): ConfirmCutArgs | string {
  const keeps = parseKeeps(payload.keeps);
  if (typeof keeps === "string") return keeps;
  const flags = parseFlags(payload.flags);
  if (typeof flags === "string") return flags;
  const overlays = parseOverlays(payload.overlays);
  if (typeof overlays === "string") return overlays;
  const baseTranscript = parseRevision(payload.base_transcript_revision, "base_transcript_revision");
  if (typeof baseTranscript === "string") return baseTranscript;
  const baseCut = parseRevision(payload.base_cut_revision, "base_cut_revision");
  if (typeof baseCut === "string") return baseCut;
  return {
    keeps,
    flags,
    baseTranscriptRevision: baseTranscript,
    baseCutRevision: baseCut,
    ...(overlays.length > 0 ? { overlays } : {}),
  };
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
    const state = await ctx.service.confirmCut(contentId, args);
    void appendAction(ctx.dataDir, { kind: "video_cut", contentId }); // 工作区动作进有界环（设计 §Phase 2）
    return { ok: true, data: { state } };
  } catch (err) {
    return fail(err);
  }
}

/**
 * 审片确认。approve → done 并盖 `videoReadyAt`（只盖一次）；reject → 回选段重剪。
 * 盖戳失败不改变确认结果，但 warning 必须可见（复盘的第四段用时靠这枚戳）。
 */
export async function videoReviewConfirmHandler(payload: Payload): Promise<Reply> {
  const ctx = resolve(payload);
  if (!ctx.ok) return ctx.reply;
  const contentId = requireContentId(payload);
  if (!contentId) return { ok: false, error: "需要合法 content_id" };
  const rendered = parseRevision(payload.rendered_revision, "rendered_revision");
  if (typeof rendered === "string") return { ok: false, error: rendered };
  const verdict = payload.verdict;
  if (verdict !== "approve" && verdict !== "reject") return { ok: false, error: "verdict 只能是 approve / reject" };
  try {
    const state = await ctx.service.confirmReview(contentId, { renderedRevision: rendered, verdict });
    if (verdict !== "approve") return { ok: true, data: { state } };
    void appendAction(ctx.dataDir, { kind: "video_reviewed", contentId }); // 工作区动作进有界环（设计 §Phase 2）
    const stamped = await stampVideoReady(contentId, ctx.dataDir);
    return { ok: true, data: { state, ...stamped } };
  } catch (err) {
    return fail(err);
  }
}

/** 首次达成盖戳，已有值不覆盖（publishedAt 同款纪律） */
async function stampVideoReady(contentId: string, dataDir: string): Promise<Reply> {
  try {
    const content = await getContent(contentId, dataDir);
    if (!content) return { videoReadyAt: null, stampWarning: "稿件读不到，videoReadyAt 未盖" };
    if (content.videoReadyAt) return { videoReadyAt: content.videoReadyAt };
    const updated = await updateContent(contentId, { videoReadyAt: new Date().toISOString() }, dataDir);
    if (!updated?.videoReadyAt) return { videoReadyAt: null, stampWarning: "videoReadyAt 落盘失败（复盘用时会少这一条）" };
    return { videoReadyAt: updated.videoReadyAt };
  } catch (err) {
    return { videoReadyAt: null, stampWarning: `videoReadyAt 落盘失败：${err instanceof Error ? err.message : String(err)}` };
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
