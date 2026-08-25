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
  /** 请求时的清洗版本；缺省 = 那时还没有清洗版。发布前拿它对一次，防迟到的旧字幕 */
  cleanRevision?: number;
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
   * 预览结果的校验（spec §4.1 + 转写纠错 spec §5）：lease 还是我 + 仍是当前 requested revision
   * + 仍在 cut 门 + **文字与选段还是请求时那两版**。任一不符 = 我是历史，**旧结果不发布**。
   *
   * 加文字/选段这两条是因为预览要渲几分钟，期间后台重跑转写、人手改字都会换掉字幕来源：
   * 请求指针没动，产物却已经是旧字幕——迟到的它不许冒充新的。
   * 返回 null 表示可以发布。
   */
  function previewStale(cur: VideoState | null, task: PreviewTask): string | null {
    if (!cur) return "状态文件在预览执行期间消失了";
    if (!(cur.phase === "cut" && cur.state === "awaiting_human")) return `已经离开选段门（当前 ${cur.phase}/${cur.state}）`;
    if (cur.preview?.requestedRevision !== task.revision) {
      return `又点了一次重渲（当前请求是 v${String(cur.preview?.requestedRevision)}）`;
    }
    if ((cur.revisions.clean ?? 0) !== (task.cleanRevision ?? 0)) {
      return `文字已经换了一版（清洗 v${String(cur.revisions.clean ?? 0)}，这份预览烧的是 v${String(task.cleanRevision ?? 0)}）`;
    }
    if ((cur.revisions.cut ?? 0) !== task.cutRevision) {
      return `选段已经换了一版（当前 v${String(cur.revisions.cut ?? 0)}，这份预览剪的是 v${task.cutRevision}）`;
    }
    return null;
  }

  /** CAS 不过时用它跳出写入事务——mutator 是同步的，抛错是唯一能在临界区里中止的方式 */
  class StalePreview extends Error {}

  async function publishPreview(task: PreviewTask, next: VideoPreviewState): Promise<string | null> {
    try {
      await ctx.writeState(task.contentId, (cur) => {
        const stale = previewStale(cur, task);
        if (stale) throw new StalePreview(stale);
        // 主状态一个字都不动：预览是门内辅助，不参与 phase/state 语义
        return { ...cur!, preview: next };
      });
      return null;
    } catch (err) {
      if (err instanceof StalePreview) {
        await tombstonePreview(task, err.message);
        return err.message;
      }
      throw err;
    }
  }

  /**
   * 迟到预览的可见收场：请求指针还指着我、产物却永远不会来时，必须把 error 写回去——
   * 前端按「requested > ready 且无 error = 渲染中」推导，留着悬空指针就是永远的
   * 「预览渲染中…」（手改字/重跑转写换掉字幕来源正是这条路）。指针已被新请求接管
   * 时一个字不动：那是别人的进行时。readyRevision 照留，老预览还能播（recover 同款）。
   */
  async function tombstonePreview(task: PreviewTask, reason: string): Promise<void> {
    await ctx.writeState(task.contentId, (cur) => {
      if (!cur || cur.preview?.requestedRevision !== task.revision || cur.preview.readyRevision === task.revision) {
        return cur!;
      }
      return {
        ...cur,
        preview: {
          requestedRevision: task.revision,
          ...(cur.preview.readyRevision !== undefined ? { readyRevision: cur.preview.readyRevision } : {}),
          error: `这版预览已作废：${reason}。点「重新生成预览」按当前文字与选段再渲`,
        },
      };
    });
  }

  async function runPreview(task: PreviewTask): Promise<void> {
    const { state: before } = await readVideoState(dataDir, task.contentId);
    const early = previewStale(before, task);
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
        ...(task.cleanRevision ? { cleanRevision: task.cleanRevision } : {}),
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
