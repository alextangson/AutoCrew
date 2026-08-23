/**
 * 门内预览的辅助 job（v2 spec §4.1）——runner 的一块，单独成文件是为了让
 * 「它不动主状态」这条纪律看得见：整份文件里唯一的写状态动作就是更新 `preview` 三字段。
 *
 * 与 runner 的分工：调度、队列、lease、心跳仍归 runner，这里只管
 * 「这一次预览该不该发布、发布成什么」。共用的原语由 runner 注入，不重复实现一套。
 */
import { removePreviewOutputs, runPreviewJob } from "./preview-exec.js";
import { nowIso, type VideoDeps } from "./proc.js";
import { appendVideoJob, latestJobsView, readVideoJobs, readVideoState } from "./video-store.js";
import type { VideoJob, VideoPreviewState, VideoState } from "./types.js";

/** 门内预览请求：由 service 落好不可变请求后交给 runner 排队执行 */
export interface PreviewTask {
  contentId: string;
  revision: number;
  keeps: string[];
  transcriptRevision: number;
  cutRevision: number;
}

/** runner 注入的共用原语——预览不另起一套 lease / 心跳 / 写状态的实现 */
export interface PreviewRunnerDeps {
  dataDir: string;
  deps?: VideoDeps;
  renderDir?: string;
  leaseOwner: string;
  abortSignal: AbortSignal;
  isStopped: () => boolean;
  report: (message: string) => void;
  writeState: (contentId: string, mutate: (cur: VideoState | null) => VideoState) => Promise<VideoState>;
  claimJob: (contentId: string, inputKey: string) => Promise<VideoJob>;
  startHeartbeat: (job: VideoJob | null) => { touch(): void; stop(): void };
}

export interface PreviewRunner {
  run(task: PreviewTask): Promise<void>;
  /** 心跳过期的预览 job 的回收动作（边界 #4） */
  recover(job: VideoJob): Promise<void>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createPreviewRunner(ctx: PreviewRunnerDeps): PreviewRunner {
  const { dataDir, deps, leaseOwner, report } = ctx;

  /**
   * 预览结果的三重校验（spec §4.1）：lease 还是我 + 仍是当前 requested revision + 仍在 cut 门。
   * 任一不符 = 我是历史，**旧结果不发布**（latest-wins 的最低实现）。
   * 返回 null 表示可以发布。
   */
  function previewStale(cur: VideoState | null, revision: number): string | null {
    if (!cur) return "状态文件在预览执行期间消失了";
    if (!(cur.phase === "cut" && cur.state === "awaiting_human")) return `已经离开选段门（当前 ${cur.phase}/${cur.state}）`;
    if (cur.preview?.requestedRevision !== revision) {
      return `又点了一次重渲（当前请求是 v${String(cur.preview?.requestedRevision)}）`;
    }
    return null;
  }

  /** CAS 不过时用它跳出写入事务——mutator 是同步的，抛错是唯一能在临界区里中止的方式 */
  class StalePreview extends Error {}

  async function publishPreview(task: PreviewTask, next: VideoPreviewState): Promise<string | null> {
    try {
      await ctx.writeState(task.contentId, (cur) => {
        const stale = previewStale(cur, task.revision);
        if (stale) throw new StalePreview(stale);
        // 主状态一个字都不动：预览是门内辅助，不参与 phase/state 语义
        return { ...cur!, preview: next };
      });
      return null;
    } catch (err) {
      if (err instanceof StalePreview) return err.message;
      throw err;
    }
  }

  async function runPreview(task: PreviewTask): Promise<void> {
    const { state: before } = await readVideoState(dataDir, task.contentId);
    const early = previewStale(before, task.revision);
    if (early) return report(`${task.contentId} 的预览 v${task.revision} 不再需要：${early}`);
    const job = await ctx.claimJob(task.contentId, `preview:${task.revision}`);
    const heartbeat = ctx.startHeartbeat(job);
    let result: Awaited<ReturnType<typeof runPreviewJob>>;
    try {
      result = await runPreviewJob({
        dataDir,
        contentId: task.contentId,
        revision: task.revision,
        keeps: task.keeps,
        transcriptRevision: task.transcriptRevision,
        cutRevision: task.cutRevision,
        ...(ctx.renderDir ? { renderDir: ctx.renderDir } : {}),
        onProgress: () => heartbeat.touch(),
        abortSignal: ctx.abortSignal,
      }, deps);
    } catch (err) {
      result = { ok: false, errorCode: "unexpected", reason: `预览异常中止：${errText(err)}` };
    } finally {
      heartbeat.stop();
    }
    if (ctx.isStopped() && !result.ok) return;
    await settlePreview(task, job, result);
  }

  async function settlePreview(
    task: PreviewTask,
    job: VideoJob,
    result: Awaited<ReturnType<typeof runPreviewJob>>,
  ): Promise<void> {
    const live = latestJobsView(await readVideoJobs(dataDir)).find((j) => j.jobId === job.jobId);
    const superseded =
      live?.leaseOwner !== leaseOwner
        ? "lease 已被别人接管"
        : await publishPreview(
            task,
            result.ok
              ? { requestedRevision: task.revision, readyRevision: task.revision }
              : { requestedRevision: task.revision, error: result.reason },
          );
    if (superseded) {
      // 作废的预览自己把输出收走（§3.3）：清理跑完之后一次迟到的 rename 会让它复活（边界 #12）
      await removePreviewOutputs(dataDir, task.contentId, task.revision).catch((err: unknown) =>
        report(`${task.contentId} 的作废预览 v${task.revision} 没清干净：${errText(err)}`),
      );
      report(`${task.contentId} 的预览 v${task.revision} 作废：${superseded}`);
    }
    await appendVideoJob(dataDir, {
      ...job,
      status: result.ok && !superseded ? "succeeded" : "failed",
      settledAt: nowIso(deps),
      ...(superseded
        ? { errorCode: "superseded", failReason: `预览结果已过时：${superseded}` }
        : result.ok
          ? {}
          : { errorCode: result.errorCode, failReason: result.reason }),
    });
  }

  /**
   * 崩在半路的预览 job（边界 #4）：**不自动重排**——预览是人点出来的，
   * 悄悄重跑一遍会在人早就往下走之后突然冒出一个新预览。这里只把「它没跑完」说出来，
   * 面板据此出横幅、给「重新生成预览」按钮。
   */
  async function recover(job: VideoJob): Promise<void> {
    const revision = Number(job.inputKey.replace("preview:", ""));
    await appendVideoJob(dataDir, {
      ...job,
      status: "failed",
      settledAt: nowIso(deps),
      leaseOwner: undefined,
      errorCode: "interrupted",
      failReason: "预览渲染被中断（进程重启或超时回收）",
    });
    const { state } = await readVideoState(dataDir, job.contentId);
    if (state?.preview?.requestedRevision !== revision || state.preview.readyRevision === revision) return;
    await ctx.writeState(job.contentId, (cur) => ({
      ...cur!,
      preview: { requestedRevision: revision, ...(cur!.preview?.readyRevision !== undefined ? { readyRevision: cur!.preview.readyRevision } : {}), error: "预览渲染被中断（进程重启），点「重新生成预览」再来一次" },
    }));
  }

  return { run: runPreview, recover };
}
