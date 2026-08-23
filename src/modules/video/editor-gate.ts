/**
 * 成片计划人工门的入口（横屏 spec §3.1 + v2 spec §4.2 + lifecycle spec §2.1/§2.2/§2.3）：
 * 确认、填槽、删槽、退回选段，以及它们共用的前置判定。
 *
 * 从 service 里切出来是因为它们共享同一段前置判定（在门上 + 版本对得上 + 选段没换 + plan 读得到），
 * 而那段判定正是这道门的全部纪律所在——挤在门面文件里读不出「几条路走同一道闸」。
 *
 * 两条纪律写在形状里：
 * 1. **改 plan 一律派生新版**（填 / 删 / 确认都是），旧版原样留盘。就地改会违反
 *    「版本化产物只增不改」，也会让乐观锁失去基准。
 * 2. **确认产物是 `editor-decision.v<planRevision>.json`**，空计划显式写 `overlays: []`。
 *    再也不按 cut 号存——那让「回门二改一处再确认」必撞不可覆盖，也让旧 overlay 会复活。
 *
 * 本文件不自己开事务：状态读写、串行链、入队都由 service 注入。
 */
import { getAsset } from "../../storage/library-store.js";
import { writeEditorDecision } from "./editor-decision.js";
import { deriveEditorPlan, planToSlots, tolerateLegacyPlan, type SlotFillAsset } from "./editor-plan.js";
import { fingerprintFile } from "./fingerprint.js";
import { probeMedia } from "./ingest.js";
import type { VideoDeps } from "./proc.js";
import { readVersioned, videoDir, writeVersioned } from "./video-store.js";
import { VideoConflictError } from "./errors.js";
import type { EditorPlanOverlay, VideoEditorPlan, VideoState } from "./types.js";

/** 确认成片计划：留下的 overlay 落成决策，随后进组装 */
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

/** 门内删槽（lifecycle spec §2.3）：与填槽共用同一个派生函数 */
export interface RemoveEditorSlotArgs {
  planRevision: number;
  overlayId: string;
}

/** 门二退回门一（lifecycle spec §2.2）：在成片计划上才发现话说错了 */
export interface BackToCutArgs {
  planRevision: number;
}

/** 成片计划视图：plan 本体 + 它的版本号（提交时当乐观锁的 base） */
export interface EditorPlanView {
  plan: VideoEditorPlan;
  revision: number;
  /**
   * 非空 = 这份 plan 是对上一版选段排的（`plan.cutRevision !== revisions.cut`）。
   * 面板据此出横幅并挡住确认——按旧输出域时间排的 overlay 会落在错误的话上。
   */
  staleCutRevision?: number;
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
  removeSlot(contentId: string, args: RemoveEditorSlotArgs): Promise<EditorPlanView>;
  backToCut(contentId: string, args: BackToCutArgs): Promise<VideoState>;
}

export function createEditorGate(ctx: EditorGateDeps): EditorGate {
  const dir = (contentId: string): string => videoDir(ctx.dataDir, contentId);

  /** 只能删不能改：留下的必须是 plan 里原样的那几段，前端传不进新东西 */
  function pickOverlays(plan: VideoEditorPlan, keptIds: string[]): EditorPlanOverlay[] {
    const known = new Set(plan.overlays.map((o) => o.overlayId));
    const unknown = keptIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`这一版成片计划里没有这些片段：${unknown.join("、")}，请重载后重试`);
    const kept = new Set(keptIds);
    return plan.overlays.filter((o) => kept.has(o.overlayId));
  }

  /** edit 门的几个入口共用这一段：在门上 + plan 版本对得上 + 选段没换 + plan 读得到 */
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
    const raw = await readVersioned<VideoEditorPlan>(dir(contentId), "editor-plan", current);
    if (!raw) throw new Error(`读不到 editor-plan.v${current}，请点「重新跑剪辑师」再来一版`);
    // 停在门上的 v1 旧 plan 读成 v2 形状再走新逻辑（§4.2 升级兼容），旧产物本身不动
    const plan = tolerateLegacyPlan(raw);
    const cutRevision = state.revisions.cut ?? 0;
    if (plan.cutRevision !== cutRevision) {
      throw new VideoConflictError(
        `这份计划是对选段 v${plan.cutRevision} 排的，当前选段已是 v${cutRevision}——` +
          "输出域时间全变了，请点「重新跑剪辑师」按新选段重排一版",
        state,
      );
    }
    return { state, plan };
  }

  /**
   * 确认成片计划。**确认本身也派生一版 plan**（lifecycle §2.1）：确认时顺手删掉的那几段
   * 是一次真实的改动，留成 `editor-plan.v<N+1>` 才对得上账；决策就写在同一个号上。
   *
   * 未填的 generate 槽在这里被**显式丢弃**（面板已明示条数）。丢弃后无需重算 P1 硬限：
   * 覆盖率 / 禁区 / 单段时长全是 overlay 存在性的**上界**约束，只删不增不可能新违反。
   */
  async function confirm(contentId: string, args: ConfirmEditorPlanArgs): Promise<VideoState> {
    const { state, plan } = await requirePlan(contentId, args.planRevision, "确认成片计划");
    const kept = pickOverlays(plan, args.keptOverlayIds);
    const cutRevision = state.revisions.cut ?? 0;
    const revision = args.planRevision + 1;
    await writeVersioned(dir(contentId), "editor-plan", revision, {
      ...plan,
      origin: "human" as const,
      basePlanRevision: args.planRevision,
      overlays: kept,
    });
    await writeEditorDecision(ctx.dataDir, contentId, {
      schemaVersion: 1,
      planRevision: revision,
      cutRevision,
      // 空数组是显式结论「这条出纯口播」，不是「没写文件」
      overlays: planToSlots(kept),
      decidedAt: new Date().toISOString(),
    });
    const next = await ctx.write(contentId, (cur) => ({
      ...cur,
      phase: "assemble",
      state: "queued",
      revisions: { ...cur.revisions, editor: revision },
      confirmedEditorRevision: revision,
    }));
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
      // 库里已有探测事实就用它（入库时探过）；没有才现探一次，不让填槽等一次 ffprobe
      durationMs = asset.media?.durationMs;
      if (!durationMs) {
        const probed = await probeMedia(asset.path, ctx.deps);
        if (!probed.ok) throw new Error(`读不出 ${asset.name} 的时长：${probed.reason}`);
        durationMs = probed.probe.durationMs;
      }
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
   * 填 / 删共用的落盘动作：派生新版 → 写盘 → 推进 `revisions.editor`。
   * 乐观锁不符 → 冲突重载；多窗口后提交者拿到冲突，绝不覆盖前一个人的编排。
   */
  async function mutate(
    contentId: string,
    planRevision: number,
    action: string,
    apply: (plan: VideoEditorPlan) => VideoEditorPlan | string,
  ): Promise<EditorPlanView> {
    const { plan } = await requirePlan(contentId, planRevision, action);
    const derived = apply(plan);
    if (typeof derived === "string") throw new Error(derived);
    const revision = planRevision + 1;
    await writeVersioned(dir(contentId), "editor-plan", revision, derived);
    await ctx.write(contentId, (cur) => ({ ...cur, revisions: { ...cur.revisions, editor: revision } }));
    return { plan: derived, revision };
  }

  async function fillSlot(contentId: string, args: FillEditorSlotArgs): Promise<EditorPlanView> {
    const asset = await snapshotLibraryAsset(args.libraryId);
    return mutate(contentId, args.planRevision, "填充素材", (plan) =>
      deriveEditorPlan(plan, args.planRevision, { kind: "fill", overlayId: args.overlayId, asset }),
    );
  }

  function removeSlot(contentId: string, args: RemoveEditorSlotArgs): Promise<EditorPlanView> {
    return mutate(contentId, args.planRevision, "删除片段", (plan) =>
      deriveEditorPlan(plan, args.planRevision, { kind: "remove", overlayId: args.overlayId }),
    );
  }

  /**
   * 门二退回门一（lifecycle §2.2）。带乐观锁是因为它也是一次决策：
   * 手里那版 plan 已经不是当前版时，人看的编排和他要退回的理由对不上，不能默默照做。
   */
  async function backToCut(contentId: string, args: BackToCutArgs): Promise<VideoState> {
    await requirePlan(contentId, args.planRevision, "回选段重改");
    return ctx.write(contentId, (cur) => ({ ...cur, phase: "cut", state: "awaiting_human" }));
  }

  return { confirm, fillSlot, removeSlot, backToCut };
}
