/**
 * 审片人工门（lifecycle spec §2.2 打回分流 + §2.4 打回定位 + §3.3 收尾清理的触发点）。
 *
 * 与 `editor-gate.ts` 同一套分工：门的**判定与产物**住在这儿，事务（状态读写、串行链、
 * 入队）由 service 注入。切出来是因为这道门现在不止「通过 / 打回」两个分支——
 * 它要定位、要落记录、要按目标分流、还要在通过时把收尾清理排上队。
 *
 * 一条纪律：**定位与记录都不许让裁决失败**。人已经看完片子做了决定，
 * 读不齐产物、记录撞了名字，都不该把这个决定顶回去——报一句，裁决照常生效。
 */
import { VideoConflictError } from "./errors.js";
import { tolerateLegacyPlan } from "./editor-plan.js";
import { buildOutputMap } from "./output-map.js";
import { locateReviewTarget, suggestedGate, type LocateSpan } from "./review-locate.js";
import { writeReviewDecision, type ReviewLocation, type VideoReviewDecision } from "./review-decision.js";
import { readEditUnits, readEffectiveTranscript, readVersioned, videoDir } from "./video-store.js";
import type { VideoCut, VideoEditorPlan, VideoState } from "./types.js";

export interface ConfirmReviewArgs {
  renderedRevision: number;
  verdict: "approve" | "reject";
  /** 打回去哪道门；不给就按时间戳定位的结果推荐 */
  target?: "edit" | "cut";
  /** 人在播放器上停的位置（输出时间域毫秒） */
  timestampMs?: number;
  note?: string;
}

export interface ReviewGateDeps {
  dataDir: string;
  requireState: (contentId: string) => Promise<VideoState>;
  write: (contentId: string, mutate: (cur: VideoState) => VideoState) => Promise<VideoState>;
  /** 通过之后把收尾清理排上队（§3.3） */
  enqueueCleanup: (contentId: string) => void;
  describe: (state: VideoState) => string;
  report: (message: string) => void;
}

export interface ReviewGate {
  confirm(contentId: string, args: ConfirmReviewArgs): Promise<VideoState>;
}

export function createReviewGate(ctx: ReviewGateDeps): ReviewGate {
  const { dataDir } = ctx;

  /** 确认过的那一版编排 → 输出域区间；没确认过就是空（此时定位只落到句子） */
  async function overlaySpans(state: VideoState, contentId: string): Promise<LocateSpan[]> {
    const planRevision = state.confirmedEditorRevision ?? 0;
    if (!planRevision) return [];
    const plan = await readVersioned<VideoEditorPlan>(videoDir(dataDir, contentId), "editor-plan", planRevision);
    if (!plan) return [];
    return tolerateLegacyPlan(plan).overlays.map((o) => ({
      id: o.overlayId,
      startMs: o.outputStartMs,
      endMs: o.outputStartMs + o.durationMs,
    }));
  }

  /** keeps 拼接后的分句区间（输出域）。读不齐或对不上就返回空，定位退化不报错 */
  async function segmentSpans(state: VideoState, contentId: string): Promise<LocateSpan[]> {
    const dir = videoDir(dataDir, contentId);
    const cutRevision = state.revisions.cut ?? 0;
    const transcript = await readEffectiveTranscript(dir, {
      transcript: state.revisions.transcript ?? 0,
      clean: state.revisions.clean,
    });
    const cut = await readVersioned<VideoCut>(dir, "cut", cutRevision);
    if (!transcript || !cut) return [];
    const units = await readEditUnits(dir, cutRevision);
    try {
      return buildOutputMap(units ? { ...transcript, segments: units.segments } : transcript, cut).map((e) => ({
        id: e.segmentId,
        startMs: e.outputStartMs,
        endMs: e.outputStartMs + (e.sourceEndMs - e.sourceStartMs),
      }));
    } catch {
      return []; // keeps 与转写对不上时定位不了，但打回照样成立
    }
  }

  /** 时间戳落进某个 overlay 槽 → 回门二高亮那一槽；否则落到某一句 → 回门一 */
  async function locate(state: VideoState, contentId: string, timestampMs: number): Promise<ReviewLocation | null> {
    return locateReviewTarget(
      timestampMs,
      await overlaySpans(state, contentId),
      await segmentSpans(state, contentId),
    );
  }

  /** 记录落不可变产物；已存在（异常恢复路径）不阻断裁决，报一句就过 */
  async function record(contentId: string, decision: VideoReviewDecision): Promise<void> {
    try {
      await writeReviewDecision(dataDir, contentId, decision);
    } catch (err) {
      ctx.report(`${contentId} 的审片记录没落盘（裁决仍然生效）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function confirm(contentId: string, args: ConfirmReviewArgs): Promise<VideoState> {
    const state = await ctx.requireState(contentId);
    if (!(state.phase === "review" && state.state === "awaiting_human")) {
      throw new Error(`当前是 ${ctx.describe(state)}，还轮不到审片`);
    }
    const rendered = state.revisions.rendered ?? 0;
    if (rendered !== args.renderedRevision) {
      throw new VideoConflictError(`审的是成片 v${args.renderedRevision}，当前已是 v${rendered}，请重载后重试`, state);
    }
    const at =
      args.verdict === "reject" && typeof args.timestampMs === "number"
        ? await locate(state, contentId, args.timestampMs)
        : null;
    // 打回分流（§2.2）：B-roll 不对只回门二，说错话才回门一。人没指定就按定位结果推荐
    const gate = args.verdict === "reject" ? (args.target ?? suggestedGate(at)) : undefined;
    await record(contentId, {
      schemaVersion: 1,
      renderedRevision: rendered,
      verdict: args.verdict,
      ...(gate ? { target: gate } : {}),
      ...(typeof args.timestampMs === "number" ? { timestampMs: args.timestampMs } : {}),
      ...(args.note?.trim() ? { note: args.note.trim() } : {}),
      ...(at ? { locate: at } : {}),
      decidedAt: new Date().toISOString(),
    });
    if (args.verdict === "reject") {
      return ctx.write(contentId, (cur) => ({ ...cur, phase: gate!, state: "awaiting_human" }));
    }
    // done 落盘即置 cleanup=pending：进程死在清理中途，下次启动会接着做完（§3.3）
    const next = await ctx.write(contentId, (cur) => ({
      ...cur,
      phase: "done",
      state: "done",
      cleanup: { status: "pending", approvedRevision: rendered },
    }));
    ctx.enqueueCleanup(contentId);
    return next;
  }

  return { confirm };
}
