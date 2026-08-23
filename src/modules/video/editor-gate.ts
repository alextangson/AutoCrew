/**
 * 成片计划人工门的三个入口（横屏 spec §3.1 + v2 spec §4.2）：确认、填槽、读 plan 的公共前置。
 *
 * 从 service 里切出来是因为它们共享同一段前置判定（在门上 + 版本对得上 + plan 读得到），
 * 而那段判定正是这道门的全部纪律所在——挤在门面文件里读不出「三条路走同一道闸」。
 *
 * 本文件不自己开事务：状态读写、串行链、入队都由 service 注入。
 */
import { getAsset } from "../../storage/library-store.js";
import { fillPlanSlot, planToSlots, tolerateLegacyPlan, type SlotFillAsset } from "./editor-plan.js";
import { fingerprintFile } from "./fingerprint.js";
import { probeMedia } from "./ingest.js";
import type { VideoDeps } from "./proc.js";
import { writeOverlaySlots } from "./timeline-build.js";
import { readVersioned, videoDir, writeVersioned } from "./video-store.js";
import { VideoConflictError } from "./errors.js";
import type { EditorPlanOverlay, VideoEditorPlan, VideoState } from "./types.js";

/** 确认成片计划：留下的 overlay 落成覆盖轨槽位，随后进组装 */
export interface ConfirmEditorPlanArgs {
  planRevision: number;
  keptOverlayIds: string[];
}

/** 门内填槽（v2 spec §4.2）：把一个 generate 槽换成素材库里的一条素材 */
export interface FillEditorSlotArgs {
  planRevision: number;
  overlayId: string;
  libraryId: string;
}

/** 成片计划视图：plan 本体 + 它的版本号（提交时当乐观锁的 base） */
export interface EditorPlanView {
  plan: VideoEditorPlan;
  revision: number;
}

/** service 注入的原语——这道门不自己开事务 */
export interface EditorGateDeps {
  dataDir: string;
  deps?: VideoDeps;
  requireState: (contentId: string) => Promise<VideoState>;
  write: (contentId: string, mutate: (cur: VideoState) => VideoState) => Promise<VideoState>;
  enqueue: (contentId: string) => void;
  describe: (state: VideoState) => string;
}

export interface EditorGate {
  confirm(contentId: string, args: ConfirmEditorPlanArgs): Promise<VideoState>;
  fillSlot(contentId: string, args: FillEditorSlotArgs): Promise<EditorPlanView>;
}

export function createEditorGate(ctx: EditorGateDeps): EditorGate {
  /** 只能删不能改：留下的必须是 plan 里原样的那几段，前端传不进新东西 */
  function pickOverlays(plan: VideoEditorPlan, keptIds: string[]): EditorPlanOverlay[] {
    const known = new Set(plan.overlays.map((o) => o.overlayId));
    const unknown = keptIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`这一版成片计划里没有这些片段：${unknown.join("、")}，请重载后重试`);
    const kept = new Set(keptIds);
    return plan.overlays.filter((o) => kept.has(o.overlayId));
  }

  /** edit 门的三个入口共用这一段：状态在门上 + plan 版本对得上 + plan 读得到 */
  async function requirePlan(
    contentId: string,
    planRevision: number,
    action: string,
  ): Promise<{ state: VideoState; plan: VideoEditorPlan }> {
    const state = await ctx.requireState(contentId);
    if (!(state.phase === "edit" && state.state === "awaiting_human")) {
      throw new Error(`当前是 ${ctx.describe(state)}，还轮不到${action}`);
    }
    const current = state.revisions.editor ?? 0;
    if (current !== planRevision) {
      throw new VideoConflictError(
        `成片计划基于的版本已过期（你拿的是 v${planRevision}，当前是 v${current}），请重载后重试`,
        state,
      );
    }
    const plan = await readVersioned<VideoEditorPlan>(videoDir(ctx.dataDir, contentId), "editor-plan", current);
    if (!plan) throw new Error(`读不到 editor-plan.v${current}，请点「重新跑剪辑师」再来一版`);
    // 停在门上的 v1 旧 plan 读成 v2 形状再走新逻辑（§4.2 升级兼容），旧产物本身不动
    return { state, plan: tolerateLegacyPlan(plan) };
  }

  /**
   * 确认成片计划。**覆盖轨槽位按 cutRevision 存**，因为 assemble 就按 `revisions.cut`
   * 去读它们；plan 自己的版本（`revisions.editor`）只用来做乐观锁——同一版 cut 可以重跑
   * N 次剪辑师（plan 版本一路涨），但只会确认一次，所以按 cut 编号恰好落一份，
   * 不会撞上「版本化产物不可覆盖」。
   *
   * 未填的 generate 槽在这里被**显式丢弃**（面板已明示条数）。丢弃后无需重算 P1 硬限：
   * 覆盖率 / 禁区 / 单段时长全是 overlay 存在性的**上界**约束，只删不增不可能新违反。
   */
  async function confirm(contentId: string, args: ConfirmEditorPlanArgs): Promise<VideoState> {
    const { state, plan } = await requirePlan(contentId, args.planRevision, "确认成片计划");
    const slots = planToSlots(pickOverlays(plan, args.keptOverlayIds));
    const cutRevision = state.revisions.cut ?? 0;
    if (slots.length > 0) await writeOverlaySlots(ctx.dataDir, contentId, cutRevision, slots);
    const next = await ctx.write(contentId, (cur) => ({ ...cur, phase: "assemble", state: "queued" }));
    ctx.enqueue(contentId);
    return next;
  }

  /** 素材库那条素材翻成填槽快照：类型、时长、指纹都在这一刻定死（边界 #12） */
  async function snapshotLibraryAsset(libraryId: string): Promise<SlotFillAsset> {
    const asset = await getAsset(libraryId, ctx.dataDir);
    if (!asset) throw new Error(`素材库里找不到 ${libraryId}（可能已被移出素材库）`);
    if (asset.type !== "video" && asset.type !== "image") {
      throw new Error(`${asset.name} 是 ${asset.type} 素材，覆盖轨只能用视频或图片`);
    }
    const type = asset.type === "image" ? ("image" as const) : ("screen" as const);
    let durationMs: number | undefined;
    if (type === "screen") {
      const probed = await probeMedia(asset.path, ctx.deps);
      if (!probed.ok) throw new Error(`读不出 ${asset.name} 的时长：${probed.reason}`);
      durationMs = probed.probe.durationMs;
    }
    return {
      ref: { kind: "library", id: asset.id },
      name: asset.name,
      type,
      ...(durationMs !== undefined ? { durationMs } : {}),
      fingerprint: await fingerprintFile(asset.path),
    };
  }

  /**
   * 填槽 = **派生新 plan revision**（v2 spec §4.2）：旧版原样留盘，只有目标槽的 source 被换掉。
   * 乐观锁不符 → 冲突重载；多窗口后提交者拿到冲突，绝不覆盖前一个人的编排。
   */
  async function fillSlot(contentId: string, args: FillEditorSlotArgs): Promise<EditorPlanView> {
    const { plan } = await requirePlan(contentId, args.planRevision, "填充素材");
    const asset = await snapshotLibraryAsset(args.libraryId);
    const filled = fillPlanSlot(plan, args.planRevision, args.overlayId, asset);
    if (typeof filled === "string") throw new Error(filled);
    const revision = args.planRevision + 1;
    await writeVersioned(videoDir(ctx.dataDir, contentId), "editor-plan", revision, filled);
    await ctx.write(contentId, (cur) => ({ ...cur, revisions: { ...cur.revisions, editor: revision } }));
    return { plan: filled, revision };
  }

  return { confirm, fillSlot };
}
