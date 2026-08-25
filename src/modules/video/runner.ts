/**
 * 视频线 runner（设计 spec §3 执行模型）。
 *
 * **进程内单例串行**：渲染吃满 CPU，两条同时跑只会互相拖慢并把机器卡死。
 * 所有入口只投递，跑不跑、什么时候跑由这里决定。
 *
 * 四条纪律，缺一条这条管线就会在崩溃/并发下丢状态：
 * 1. **claim 带 lease**：queued→running 的同时给 job 盖 `leaseOwner = pid-<pid>-<launchId>`，
 *    跨进程重复渲染因此不可能（另一个进程看得见这条 lease 还活着）。
 * 2. **心跳 60 秒续租**：渲染能跑几十分钟，固定 lease 会被误判为死亡；长渲染期间由进度
 *    回调顺带续租，所以哪怕 60 秒的定时器错过一拍，只要还在出帧就不会被回收。
 * 3. **启动回收**：心跳过期 10 分钟的 running（上次崩在半路）→ 同阶段重排 + attempts+1。
 * 4. **settle 带 CAS**：落盘前校验 lease 还是自己、状态还停在我认领的那一格、revisions 没前移；
 *    不符则**产物留盘、状态不动**——旧 revision 渲染完不许污染新状态（codex #10）。
 */
import { getContent } from "../../storage/local-store.js";
import { buildBrollCatalog } from "./broll-catalog.js";
import { createCleanupRunner } from "./runner-cleanup.js";
import { recoverExpired } from "./runner-recover.js";
import { editorInputKey } from "./editor.js";
import { fingerprintFile } from "./fingerprint.js";
import { resolveBgmRef } from "./ingest.js";
import { MASTER_AUDIO_PARAMS } from "./master-audio.js";
import { executePhase, stepWarning, type StepResult } from "./phases.js";
import { nowIso, nowMs, type VideoDeps } from "./proc.js";
import { createPreviewRunner, type PreviewTask } from "./runner-preview.js";
import { roughCutInputKey } from "./rough-cut.js";
import { transcribeInputKey } from "./transcribe-input.js";
import {
  appendVideoJob,
  jobKey,
  latestJobsView,
  promoteStaging,
  readVideoJobs,
  readVideoAssets,
  readVideoState,
  resolveAssetRef,
  transitionVideoState,
  transitionVideoStateWithEffect,
  videoDir,
  VIDEO_HEARTBEAT_MS,
} from "./video-store.js";
import type { VideoJob, VideoJobPhase, VideoPhase, VideoRevisions, VideoState } from "./types.js";

export type { StepResult };
export type { PreviewTask };

const JOB_PHASES = new Set<string>(["transcribe", "cut", "edit", "assemble", "render"]);

export interface VideoRunnerOptions {
  dataDir: string;
  deps?: VideoDeps;
  /** 同进程多实例（测试、多工作区）要各自可辨认 */
  launchId?: string;
  renderDir?: string;
  /** 每次状态落盘成功后触发（SSE 的源头） */
  onStateWritten?: (contentId: string) => void;
  onError?: (message: string) => void;
  /** staging 定版注入点；测试用它锁定磁盘失败路径 */
  promoteStagingImpl?: typeof promoteStaging;
}

export interface VideoRunner {
  readonly leaseOwner: string;
  enqueue(contentId: string): void;
  /**
   * 排一次门内预览（v2 spec §4.1）。**辅助 job，不动主状态**：主状态全程钉在
   * `cut/awaiting_human`，确认因此不被渲染阻塞——门就是门。
   */
  enqueuePreview(task: PreviewTask): void;
  /** 排一次成片收尾清理（lifecycle spec §3.3）；只对 done + cleanup=pending 生效 */
  enqueueCleanup(contentId: string): void;
  /** 启动时把死在半路的清理接着做完（§4 #9）。返回重排条数 */
  resumeCleanup(): Promise<number>;
  /** 启动回收：心跳过期的 running 重排。返回回收条数 */
  recoverExpired(): Promise<number>;
  /** 队列跑空（测试与 shutdown 用） */
  whenIdle(): Promise<void>;
  shutdown(): Promise<void>;
}

function genesisState(): VideoState {
  return { schemaVersion: 1, entryType: "aroll", phase: "ingest", state: "idle", revisions: {}, updatedAt: "" };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createVideoRunner(opts: VideoRunnerOptions): VideoRunner {
  const { dataDir, deps } = opts;
  const leaseOwner = `pid-${process.pid}-${opts.launchId ?? Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  const pending = new Set<string>();
  /** 主推进、辅助预览、收尾清理排同一条队：渲染吃满 CPU，两条同时跑只会互相拖慢 */
  const order: (
    | { kind: "advance"; contentId: string }
    | { kind: "cleanup"; contentId: string }
    | ({ kind: "preview" } & PreviewTask)
  )[] = [];
  let pump: Promise<void> = Promise.resolve();
  let running = false;
  let stopped = false;

  const report = (msg: string): void => (opts.onError ?? ((m: string) => console.error(`[video-runner] ${m}`)))(msg);

  // -------------------------------------------------------------------------
  // 状态与 job 写入
  // -------------------------------------------------------------------------

  async function writeState(
    contentId: string,
    mutate: (cur: VideoState | null) => VideoState,
  ): Promise<VideoState> {
    const next = await transitionVideoState(dataDir, contentId, mutate);
    opts.onStateWritten?.(contentId);
    return next;
  }

  /** 认领：同一 inputKey 已有 job 就沿用它的 jobId（重复投递合并），attempts 累加 */
  async function claimJob(contentId: string, phase: VideoJobPhase, inputKey: string): Promise<VideoJob> {
    const key = `${contentId}|${phase}|${inputKey}`;
    const existing = latestJobsView(await readVideoJobs(dataDir)).find((j) => jobKey(j) === key);
    const stamp = nowIso(deps);
    return appendVideoJob(dataDir, {
      ...(existing ? { jobId: existing.jobId } : {}),
      contentId,
      phase,
      inputKey,
      status: "running",
      attempts: (existing?.attempts ?? 0) + 1,
      leaseOwner,
      claimedAt: stamp,
      startedAt: stamp,
      heartbeatAt: stamp,
    });
  }

  interface Heartbeat {
    touch(): void;
    stop(): void;
  }

  /**
   * 60 秒续租。`touch()` 给渲染进度回调用——出帧就等于活着，
   * 比定时器更可信（定时器可能被同步的 CPU 密集段挤掉）。
   */
  function startHeartbeat(job: VideoJob | null): Heartbeat {
    if (!job) return { touch: () => {}, stop: () => {} };
    let last = nowMs(deps);
    let alive = true;
    const beat = (): void => {
      last = nowMs(deps);
      void appendVideoJob(dataDir, { ...job, status: "running", leaseOwner, heartbeatAt: nowIso(deps) }).catch((err) =>
        report(`心跳写入失败（${job.jobId}）：${errText(err)}`),
      );
    };
    const timer = setInterval(() => alive && beat(), VIDEO_HEARTBEAT_MS);
    timer.unref?.();
    return {
      touch: () => {
        if (alive && nowMs(deps) - last >= VIDEO_HEARTBEAT_MS) beat();
      },
      stop: () => {
        alive = false;
        clearInterval(timer);
      },
    };
  }

  /** 收尾清理的那一半住在 runner-cleanup.ts：它只动 cleanup 三字段，不动 phase/state */
  const cleanupRunner = createCleanupRunner({
    dataDir,
    now: () => nowIso(deps),
    report,
    writeState,
    enqueue: (contentId) => enqueueCleanup(contentId),
  });

  /**
   * 门内预览的那一半（v2 spec §4.1）住在 runner-preview.ts：调度/lease/心跳仍归这里，
   * 「结果该不该发布」归那里，共用原语靠注入，不重复实现一套。
   */
  const previewRunner = createPreviewRunner({
    dataDir,
    ...(deps ? { deps } : {}),
    ...(opts.renderDir ? { renderDir: opts.renderDir } : {}),
    leaseOwner,
    abortSignal: controller.signal,
    isStopped: () => stopped,
    report,
    writeState,
    claimJob: (contentId, inputKey) => claimJob(contentId, "cut_preview", inputKey),
    startHeartbeat,
  });

  // -------------------------------------------------------------------------
  // 认领 → 执行 → settle
  // -------------------------------------------------------------------------

  /**
   * 换 BGM 是换输入（边界 #13）：不进 inputKey 的话，转写与选段都没变时重投组装会被
   * 当成「同一份输入」合并掉，旧的 master-audio 就那么留在成片里了。
   */
  async function bgmKey(contentId: string): Promise<string> {
    try {
      const bgm = await resolveBgmRef(dataDir, contentId);
      if (bgm.kind === "none") return "none";
      if (bgm.kind === "ambiguous") return `ambiguous:${bgm.filenames.slice().sort().join(",")}`;
      const fp = await fingerprintFile(await resolveAssetRef(dataDir, contentId, bgm.ref));
      return `${fp.quickHash.slice(0, 12)}+${MASTER_AUDIO_PARAMS}`;
    } catch {
      // 读不到 BGM 不等于没有 BGM；真出问题会在组装那一步显式失败
      return "unreadable";
    }
  }

  async function inputKeyFor(contentId: string, state: VideoState): Promise<string> {
    const r = state.revisions;
    if (state.phase === "assemble") {
      // 确认版进 key（lifecycle §2.1）：回门二改一处再确认时 cut/transcript 都没变，
      // 不带确认版的话这次重投会被当成「同一份输入」合并掉，成片还是上一版的编排
      return (
        `cut:${r.cut ?? 0}+transcript:${r.transcript ?? 0}` +
        `+decision:${state.confirmedEditorRevision ?? 0}+bgm:${await bgmKey(contentId)}`
      );
    }
    if (state.phase === "render") return `timeline:${r.timeline ?? 0}`;
    // 粗剪还消费 Content.body、prompt 版本与模型路由（§3.2）：只写 transcript 版本的话，
    // 稿子改了而转写没变时，旧输入的结果会被当成新结果推进
    if (state.phase === "cut") {
      const body = (await getContent(contentId, dataDir))?.body ?? "";
      return roughCutInputKey(dataDir, r.transcript ?? 0, body);
    }
    // 剪辑师消费的是「确认后的 cut + 稿件 + 目录（本稿 broll + 常备池）」（横屏 spec §3.1）：
    // 素材说明改一个字、换一条素材、常备池增减，编排就该重算，所以目录指纹也进 key。
    // 与 edit phase 共用 buildBrollCatalog——两边算出两份目录会让漂移判定永远误报
    if (state.phase === "edit") {
      const content = await getContent(contentId, dataDir);
      const catalog = await buildBrollCatalog(dataDir, contentId, content?.assets ?? []);
      return editorInputKey(dataDir, r.cut ?? 0, content?.body ?? "", catalog.digest);
    }
    // transcribe 消费的不止 A-roll（转写纠错 spec §2）：热词从稿件正文抽、清洗对着正文纠错，
    // 所以正文、热词算法版、清洗 prompt 版、模型路由都是它的输入。只写 A-roll 指纹的话，
    // 「素材没变、只改了稿子或清洗口径」的重投会被当成同一份输入合并掉，永远拿不到新结果
    const aroll = (await readVideoAssets(dataDir, contentId)).find((a) => a.kind === "aroll");
    const body = (await getContent(contentId, dataDir))?.body ?? "";
    return transcribeInputKey(dataDir, aroll?.fingerprint?.quickHash.slice(0, 12) ?? "none", body);
  }

  function executeStep(
    contentId: string,
    state: VideoState,
    heartbeat: Heartbeat,
    job: VideoJob | null,
  ): Promise<StepResult> {
    return executePhase({
      dataDir,
      contentId,
      state,
      ...(deps ? { deps } : {}),
      ...(opts.renderDir ? { renderDir: opts.renderDir } : {}),
      ...(job ? { jobId: job.jobId } : {}),
      abortSignal: controller.signal,
      onProgress: () => heartbeat.touch(),
      report,
    });
  }

  /** CAS：lease 还是我、状态还停在我认领的那一格、revisions 没前移。任一不符 = 我是历史 */
  function casViolation(before: VideoState, cur: VideoState | null): string | null {
    if (!cur) return "状态文件在任务执行期间消失了";
    if (cur.phase !== before.phase || cur.state !== "running") return `状态已变成 ${cur.phase}/${cur.state}`;
    if (JSON.stringify(cur.revisions) !== JSON.stringify(before.revisions)) return "输入 revision 已前移";
    return null;
  }

  /**
   * settle 后的状态。**保留式改写而不是白名单重建**：以前这里按字段名一个个抄，
   * 于是每加一个状态字段（confirmedEditorRevision、cleanup…）都会在这条路径上被悄悄抹掉，
   * 而抹掉的后果要到下一步才炸。现在只显式清掉「上一次的失败痕迹」，其余原样带过去。
   */
  function settledState(cur: VideoState, result: StepResult, phase: VideoPhase): VideoState {
    const preview = (result.ok ? result.preview : undefined) ?? cur.preview;
    const { blockedReason: _b, failedPhase: _f, errorCode: _e, failReason: _r, ...carried } = cur;
    const base = { ...carried, updatedAt: "", ...(preview ? { preview } : {}) };
    if (result.ok) {
      return { ...base, phase: result.next.phase, state: result.next.state, revisions: { ...cur.revisions, ...result.revisions } };
    }
    const failure = result.blockedReason
      ? { state: "blocked" as const, blockedReason: result.blockedReason }
      : { state: "failed" as const, failedPhase: phase };
    return { ...base, phase, revisions: cur.revisions, ...failure, errorCode: result.errorCode, failReason: result.reason };
  }

  /** CAS 不过时用它跳出写入事务，调用方据此把产物留作历史而不推进状态。 */
  class StaleSettle extends Error {}
  class PromotionFailed extends Error {}

  async function settleStateAndPromote(
    contentId: string,
    before: VideoState,
    result: StepResult,
    job: VideoJob | null,
  ): Promise<string | null> {
    try {
      await transitionVideoStateWithEffect(dataDir, contentId, (cur) => {
        const violation = casViolation(before, cur);
        if (violation) throw new StaleSettle(violation);
        return {
          next: settledState(cur!, result, before.phase),
          beforeCommit: () => promoteStaged(contentId, result, job),
        };
      });
      opts.onStateWritten?.(contentId);
      return null;
    } catch (err) {
      if (err instanceof StaleSettle) return err.message;
      throw err;
    }
  }

  function outputRevision(phase: VideoPhase, revisions?: Partial<VideoRevisions>): number | undefined {
    if (!revisions) return undefined;
    if (phase === "transcribe") return revisions.transcript;
    if (phase === "cut") return revisions.cut;
    if (phase === "edit") return revisions.editor;
    if (phase === "assemble") return revisions.timeline;
    return revisions.rendered;
  }

  /**
   * 认领前的输入快照是否还成立（§3.2 / §7 #7）。revisions 由 CAS 管，这里管的是 CAS 看不见的
   * 那部分输入：稿件正文、A-roll 指纹、模型路由。变了就说明这次的产物已经是对着旧输入算的。
   */
  async function inputDrifted(contentId: string, before: VideoState, job: VideoJob): Promise<boolean> {
    try {
      return (await inputKeyFor(contentId, before)) !== job.inputKey;
    } catch {
      return false; // 读不到输入不等于输入变了；真出问题会在下一次执行时暴露
    }
  }

  /** CAS 通过后、状态提交前把 staging 产物定版本（§3.3）；失败会中止状态提交。 */
  async function promoteStaged(contentId: string, result: StepResult, job: VideoJob | null): Promise<void> {
    if (!result.ok || !result.staged?.length || !job) return;
    const dir = videoDir(dataDir, contentId);
    for (const item of result.staged) {
      try {
        await (opts.promoteStagingImpl ?? promoteStaging)(dir, item.base, job.jobId, item.revision);
      } catch (err) {
        throw new PromotionFailed(`${item.base}.v${item.revision} 定版失败：${errText(err)}`);
      }
    }
  }

  async function markPromotionFailed(contentId: string, before: VideoState, reason: string): Promise<string | null> {
    try {
      await writeState(contentId, (cur) => {
        const violation = casViolation(before, cur);
        if (violation) throw new StaleSettle(violation);
        const carried = { ...cur! };
        delete carried.blockedReason;
        return {
          ...carried,
          phase: before.phase,
          state: "failed",
          revisions: before.revisions,
          failedPhase: before.phase,
          errorCode: "promotion_failed",
          failReason: reason,
        };
      });
      return null;
    } catch (err) {
      if (err instanceof StaleSettle) return err.message;
      throw err;
    }
  }

  async function settleViolation(
    contentId: string,
    before: VideoState,
    result: StepResult,
    job: VideoJob | null,
  ): Promise<string | null> {
    if (job) {
      const live = latestJobsView(await readVideoJobs(dataDir)).find((j) => j.jobId === job.jobId);
      if (live?.leaseOwner !== leaseOwner) return "lease 已被别人接管";
      if (await inputDrifted(contentId, before, job)) return "输入在执行期间被改动（稿件或素材已不是认领时那份）";
    }
    return settleStateAndPromote(contentId, before, result, job);
  }

  async function settle(contentId: string, before: VideoState, result: StepResult, job: VideoJob | null): Promise<void> {
    let violation: string | null = null;
    let promotionError: string | null = null;
    try {
      violation = await settleViolation(contentId, before, result, job);
    } catch (err) {
      if (!(err instanceof PromotionFailed)) throw err;
      promotionError = err.message;
      const failedSettle = await markPromotionFailed(contentId, before, promotionError);
      if (failedSettle) violation = failedSettle;
      report(`${contentId} 的 ${before.phase} 产物定版失败，状态未推进：${promotionError}`);
    }
    if (violation) report(`${contentId} 的 ${before.phase} 产物只作历史留档：${violation}`);
    const warning = stepWarning(result);
    if (!violation && !promotionError && warning) report(`${contentId} 的 ${before.phase} 跑完了但结果没达成：${warning}`);
    if (!job) return;
    const rev = violation || promotionError ? undefined : outputRevision(before.phase, result.ok ? result.revisions : undefined);
    await appendVideoJob(dataDir, {
      ...job,
      status: result.ok && !violation && !promotionError ? "succeeded" : "failed",
      settledAt: nowIso(deps),
      ...(rev !== undefined ? { outputRevision: rev } : {}),
      ...(!violation && !promotionError && warning ? { warning } : {}),
      ...(violation
        ? { errorCode: "stale_settle", failReason: `历史产物（文件已留盘，状态未推进）：${violation}` }
        : promotionError
          ? { errorCode: "promotion_failed", failReason: promotionError }
        : result.ok
          ? {}
          : { errorCode: result.errorCode, failReason: result.reason }),
    });
  }

  async function runStep(contentId: string, before: VideoState): Promise<void> {
    const jobPhase = JOB_PHASES.has(before.phase) ? (before.phase as VideoJobPhase) : null;
    const inputKey = await inputKeyFor(contentId, before);
    const claimed = await writeState(contentId, (cur) => ({ ...(cur ?? genesisState()), state: "running" }));
    const job = jobPhase ? await claimJob(contentId, jobPhase, inputKey) : null;
    const heartbeat = startHeartbeat(job);
    let result: StepResult;
    try {
      result = await executeStep(contentId, claimed, heartbeat, job);
    } catch (err) {
      result = { ok: false, errorCode: "unexpected", reason: `${before.phase} 阶段异常中止：${errText(err)}` };
    } finally {
      heartbeat.stop();
    }
    // 停机途中被杀掉的任务不落 failed：状态留在 running，下次启动按心跳过期回收重排
    if (stopped && !result.ok) return;
    await settle(contentId, claimed, result, job);
  }

  /** 一条 content 一路往下跑，直到停在人工门/失败/阻塞（自动接续不回队列，省一轮调度） */
  async function advance(contentId: string): Promise<void> {
    for (;;) {
      if (stopped) return;
      const { state } = await readVideoState(dataDir, contentId);
      if (!state || state.state !== "queued") return;
      await runStep(contentId, state);
    }
  }

  function schedule(): void {
    if (running || stopped) return;
    running = true;
    pump = (async () => {
      try {
        while (order.length > 0 && !stopped) {
          const task = order.shift()!;
          pending.delete(taskKey(task));
          try {
            if (task.kind === "advance") await advance(task.contentId);
            else if (task.kind === "cleanup") await cleanupRunner.run(task.contentId);
            else await previewRunner.run(task);
          } catch (err) {
            report(`${task.contentId} 推进失败：${errText(err)}`);
          }
        }
      } finally {
        running = false;
      }
    })();
  }

  function taskKey(task: { kind: string; contentId: string; revision?: number }): string {
    if (task.kind === "preview") return `preview|${task.contentId}|${String(task.revision)}`;
    return `${task.kind}|${task.contentId}`;
  }

  function enqueue(contentId: string): void {
    if (stopped || pending.has(`advance|${contentId}`)) return;
    pending.add(`advance|${contentId}`);
    order.push({ kind: "advance", contentId });
    schedule();
  }

  function enqueuePreview(task: PreviewTask): void {
    const key = taskKey({ kind: "preview", ...task });
    if (stopped || pending.has(key)) return;
    pending.add(key);
    order.push({ kind: "preview", ...task });
    schedule();
  }

  function enqueueCleanup(contentId: string): void {
    if (stopped || pending.has(`cleanup|${contentId}`)) return;
    pending.add(`cleanup|${contentId}`);
    order.push({ kind: "cleanup", contentId });
    schedule();
  }

  return {
    leaseOwner,
    enqueue,
    enqueuePreview,
    enqueueCleanup,
    resumeCleanup: () => cleanupRunner.resume(),
    // 启动回收住在 runner-recover.ts：两类「崩在半路」的判定合起来将近 50 行，
    // 挤在调度循环旁边会把「谁在跑」这条主线埋掉
    recoverExpired: () =>
      recoverExpired({
        dataDir,
        nowMs: () => nowMs(deps),
        writeState,
        enqueue,
        recoverPreview: (job) => previewRunner.recover(job),
      }),
    whenIdle: () => pump,
    async shutdown() {
      stopped = true;
      controller.abort();
      await pump.catch(() => undefined);
    },
  };
}
