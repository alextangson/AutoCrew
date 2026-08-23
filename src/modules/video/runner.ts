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
import fs from "node:fs/promises";
import path from "node:path";
import { isContentId } from "../../storage/entity-id.js";
import { getContent } from "../../storage/local-store.js";
import { catalogDigest, editorInputKey } from "./editor.js";
import { scanBrollCandidates, trimCandidates } from "./editor-plan.js";
import { fingerprintFile } from "./fingerprint.js";
import { resolveBgmRef } from "./ingest.js";
import { MASTER_AUDIO_PARAMS } from "./master-audio.js";
import { executePhase, stepWarning, type StepResult } from "./phases.js";
import { nowIso, nowMs, type VideoDeps } from "./proc.js";
import { createPreviewRunner, type PreviewTask } from "./runner-preview.js";
import { roughCutInputKey } from "./rough-cut.js";
import {
  appendVideoJob,
  jobKey,
  latestJobsView,
  promoteStaging,
  readVideoJobs,
  readVideoAssets,
  readVideoState,
  recoverExpiredJobs,
  resolveAssetRef,
  transitionVideoState,
  videoDir,
  VIDEO_HEARTBEAT_MS,
  VIDEO_LEASE_MS,
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
}

export interface VideoRunner {
  readonly leaseOwner: string;
  enqueue(contentId: string): void;
  /**
   * 排一次门内预览（v2 spec §4.1）。**辅助 job，不动主状态**：主状态全程钉在
   * `cut/awaiting_human`，确认因此不被渲染阻塞——门就是门。
   */
  enqueuePreview(task: PreviewTask): void;
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
  /** 主推进与辅助预览排同一条队：渲染吃满 CPU，两条同时跑只会互相拖慢 */
  const order: ({ kind: "advance"; contentId: string } | ({ kind: "preview" } & PreviewTask))[] = [];
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
      return `cut:${r.cut ?? 0}+transcript:${r.transcript ?? 0}+bgm:${await bgmKey(contentId)}`;
    }
    if (state.phase === "render") return `timeline:${r.timeline ?? 0}`;
    // 粗剪还消费 Content.body、prompt 版本与模型路由（§3.2）：只写 transcript 版本的话，
    // 稿子改了而转写没变时，旧输入的结果会被当成新结果推进
    if (state.phase === "cut") {
      const body = (await getContent(contentId, dataDir))?.body ?? "";
      return roughCutInputKey(dataDir, r.transcript ?? 0, body);
    }
    // 剪辑师消费的是「确认后的 cut + 稿件 + broll 素材清单」（横屏 spec §3.1）：
    // 素材说明改一个字、换一条素材，编排就该重算，所以清单指纹也进 key
    if (state.phase === "edit") {
      const content = await getContent(contentId, dataDir);
      const scan = trimCandidates(scanBrollCandidates(content?.assets ?? []));
      return editorInputKey(dataDir, r.cut ?? 0, content?.body ?? "", catalogDigest(scan.candidates, scan.excluded));
    }
    // transcribe 的输入是 A-roll 本身：换了素材就是另一个任务，同一素材重复投递自动合并
    const aroll = (await readVideoAssets(dataDir, contentId)).find((a) => a.kind === "aroll");
    return `aroll:${aroll?.fingerprint?.quickHash.slice(0, 12) ?? "none"}`;
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
    });
  }

  /** CAS：lease 还是我、状态还停在我认领的那一格、revisions 没前移。任一不符 = 我是历史 */
  function casViolation(before: VideoState, cur: VideoState | null): string | null {
    if (!cur) return "状态文件在任务执行期间消失了";
    if (cur.phase !== before.phase || cur.state !== "running") return `状态已变成 ${cur.phase}/${cur.state}`;
    if (JSON.stringify(cur.revisions) !== JSON.stringify(before.revisions)) return "输入 revision 已前移";
    return null;
  }

  function settledState(cur: VideoState, result: StepResult, phase: VideoPhase): VideoState {
    const preview = (result.ok ? result.preview : undefined) ?? cur.preview;
    const base = {
      schemaVersion: 1 as const,
      entryType: "aroll" as const,
      updatedAt: "",
      ...(cur.inputManifest ? { inputManifest: cur.inputManifest } : {}),
      ...(cur.stale ? { stale: cur.stale } : {}),
      ...(preview ? { preview } : {}),
    };
    // 成功即清空 blockedReason/failedPhase/errorCode/failReason：留着上一次的失败痕迹只会误导人
    if (result.ok) {
      return { ...base, phase: result.next.phase, state: result.next.state, revisions: { ...cur.revisions, ...result.revisions } };
    }
    const failure = result.blockedReason
      ? { state: "blocked" as const, blockedReason: result.blockedReason }
      : { state: "failed" as const, failedPhase: phase };
    return { ...base, phase, revisions: cur.revisions, ...failure, errorCode: result.errorCode, failReason: result.reason };
  }

  /** CAS 不过时用它跳出写入事务——mutator 是同步的，抛错是唯一能在临界区里中止的方式 */
  class StaleSettle extends Error {}

  async function settleState(contentId: string, before: VideoState, result: StepResult): Promise<string | null> {
    try {
      await writeState(contentId, (cur) => {
        const violation = casViolation(before, cur);
        if (violation) throw new StaleSettle(violation);
        return settledState(cur!, result, before.phase);
      });
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

  /** CAS 通过后才把 staging 产物定版本（§3.3）。失败必须吼出来：状态推了、产物没落位 */
  async function promoteStaged(contentId: string, result: StepResult, job: VideoJob | null): Promise<void> {
    if (!result.ok || !result.staged?.length || !job) return;
    const dir = videoDir(dataDir, contentId);
    for (const item of result.staged) {
      try {
        await promoteStaging(dir, item.base, job.jobId, item.revision);
      } catch (err) {
        report(`${contentId} 的 ${item.base}.v${item.revision} 定版失败（状态已推进，产物仍在 staging）：${errText(err)}`);
      }
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
    return settleState(contentId, before, result);
  }

  async function settle(contentId: string, before: VideoState, result: StepResult, job: VideoJob | null): Promise<void> {
    const violation = await settleViolation(contentId, before, result, job);
    if (violation) report(`${contentId} 的 ${before.phase} 产物只作历史留档：${violation}`);
    else await promoteStaged(contentId, result, job);
    const warning = stepWarning(result);
    if (!violation && warning) report(`${contentId} 的 ${before.phase} 跑完了但结果没达成：${warning}`);
    if (!job) return;
    const rev = violation ? undefined : outputRevision(before.phase, result.ok ? result.revisions : undefined);
    await appendVideoJob(dataDir, {
      ...job,
      status: result.ok && !violation ? "succeeded" : "failed",
      settledAt: nowIso(deps),
      ...(rev !== undefined ? { outputRevision: rev } : {}),
      ...(!violation && warning ? { warning } : {}),
      ...(violation
        ? { errorCode: "stale_settle", failReason: `历史产物（文件已留盘，状态未推进）：${violation}` }
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
    return task.kind === "advance" ? `advance|${task.contentId}` : `preview|${task.contentId}|${String(task.revision)}`;
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

  // -------------------------------------------------------------------------
  // 启动回收
  // -------------------------------------------------------------------------

  async function requeueJob(job: VideoJob): Promise<void> {
    if (job.phase === "cut_preview") return previewRunner.recover(job);
    await appendVideoJob(dataDir, {
      ...job,
      status: "queued",
      attempts: job.attempts + 1,
      leaseOwner: undefined,
      claimedAt: undefined,
      heartbeatAt: undefined,
    });
    const { state } = await readVideoState(dataDir, job.contentId);
    if (state?.state === "running") await writeState(job.contentId, (cur) => ({ ...cur!, state: "queued" }));
    enqueue(job.contentId);
  }

  /**
   * ingest 没有 job 行（§3 只有三个 phase 值得开 job），崩在那儿就没人回收它。
   * 用 state.json 的 updatedAt 兜底：running 且超过一个 lease 没动过 = 上次崩了。
   * 有活 job 的 content 一律跳过——长渲染的 state.updatedAt 本来就不会动。
   */
  async function recoverStuckStates(skip: Set<string>): Promise<number> {
    let ids: string[];
    try {
      ids = await fs.readdir(path.join(dataDir, "contents"));
    } catch {
      return 0;
    }
    let count = 0;
    for (const contentId of ids) {
      // contents/ 下混着 .DS_Store 之类的东西；非法 id 会让 readVideoState 直接抛
      if (skip.has(contentId) || !isContentId(contentId)) continue;
      const { state } = await readVideoState(dataDir, contentId);
      if (!state || state.state !== "running") continue;
      if (nowMs(deps) - Date.parse(state.updatedAt || "") <= VIDEO_LEASE_MS) continue;
      await writeState(contentId, (cur) => ({ ...cur!, state: "queued" }));
      enqueue(contentId);
      count += 1;
    }
    return count;
  }

  async function recoverExpired(): Promise<number> {
    const jobs = await readVideoJobs(dataDir);
    const expired = recoverExpiredJobs(jobs, nowMs(deps));
    const expiredIds = new Set(expired.map((j) => j.contentId));
    for (const job of expired) await requeueJob(job);
    const live = latestJobsView(jobs)
      .filter((j) => j.status === "running" && !expiredIds.has(j.contentId))
      .map((j) => j.contentId);
    return expired.length + (await recoverStuckStates(new Set([...expiredIds, ...live])));
  }

  return {
    leaseOwner,
    enqueue,
    enqueuePreview,
    recoverExpired,
    whenIdle: () => pump,
    async shutdown() {
      stopped = true;
      controller.abort();
      await pump.catch(() => undefined);
    },
  };
}
