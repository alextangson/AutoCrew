/**
 * 视频线服务门面（设计 spec §8.2 IPC 的唯一后端入口）。
 *
 * 桌面端 handler 只认这一个接口——投递、确认、查询全在这儿收口，
 * runner / store / sidecar 都不对外暴露。
 *
 * 三条纪律：
 * 1. **投递即返回**：`startBuild` 只做 eligibility + 落 queued + 入队，绝不等 ASR/渲染
 *    （§0.3「一切入口只投递任务，不阻塞聊天」）。
 * 2. **人工确认带乐观锁**（codex #11）：`confirmCut` / `confirmReview` 必须带 base revision，
 *    与当前不符抛 `VideoConflictError`——两个窗口同时确认时，后到者看得见冲突而不是默默覆盖。
 * 3. **生命周期串行**：所有写入走一条 promise 链（inbox-runtime 同款），
 *    「读-改-写」不会被另一个入口插队。
 *
 * 每次状态落盘成功后触发 `onEvent`——SSE 的事件源就是这里，没有第二处（§8.3 四件套之一）。
 */
import { readAsrStatus, warmupAsr, type AsrStatusRecord } from "./asr.js";
import { tolerateLegacyPlan } from "./editor-plan.js";
import { VideoConflictError } from "./errors.js";
import {
  createEditorGate,
  type BackToCutArgs,
  type ConfirmEditorPlanArgs,
  type EditorPlanView,
  type FillEditorSlotArgs,
  type RemoveEditorSlotArgs,
} from "./editor-gate.js";
import { createCutGate, type ConfirmCutArgs, type RequestPreviewArgs } from "./cut-gate.js";
import { checkVideoEligibility } from "./ingest.js";
import { createReviewGate, type ConfirmReviewArgs } from "./review-gate.js";
import { createVideoRunner, type VideoRunner } from "./runner.js";
import type { VideoDeps } from "./proc.js";
import {
  latestJobsView,
  readEditUnits,
  readVersioned,
  readVideoJobs,
  readVideoState,
  transitionVideoState,
  videoDir,
  writeVersioned,
} from "./video-store.js";
import { readReviewDecision, type VideoReviewDecision } from "./review-decision.js";
import type {
  VideoCut,
  VideoEditUnits,
  VideoEditorPlan,
  VideoJob,
  VideoState,
  VideoTranscript,
} from "./types.js";

export { VideoConflictError } from "./errors.js";

/** 选段这道门（确认 / 重跑粗剪 / 门内预览）的入参住在 cut-gate.ts */
export type { ConfirmCutArgs, RequestPreviewArgs } from "./cut-gate.js";

/**
 * 成片计划这道门的入口住在 editor-gate.ts（横屏 spec §3.1 + v2 spec §4.2 + lifecycle §2.3）——
 * 覆盖轨的唯一写入口仍是「确认」，不再有第二条「人手摆时间轴」的路与它抢同一份产物。
 */
export type {
  BackToCutArgs,
  ConfirmEditorPlanArgs,
  EditorPlanView,
  FillEditorSlotArgs,
  RemoveEditorSlotArgs,
} from "./editor-gate.js";

/**
 * 审片裁决（lifecycle spec §2.4）。打回带定位与备注，全部落进不可变
 * `review-decision.v<renderedRevision>.json`——纯前端的备注活不过一次刷新。
 * 判定与产物住在 review-gate.ts，这里只是把类型转出去。
 */
export type { ConfirmReviewArgs } from "./review-gate.js";

export interface VideoStatus {
  state: VideoState;
  jobs: VideoJob[];
  /** 当前成片版的审片记录（打回的备注与定位在这儿，目标门的横幅读它） */
  review?: VideoReviewDecision;
}

/** 选段视图要的一整套：转写（事实）、剪辑单元（派生，可能不存在）、当前决策 */
export interface CutView {
  transcript: VideoTranscript;
  cut: VideoCut;
  editUnits?: VideoEditUnits;
}

export interface VideoService {
  startBuild(contentId: string): Promise<VideoState>;
  confirmCut(contentId: string, args: ConfirmCutArgs): Promise<VideoState>;
  /** 确认成片计划：留下的 overlay 落成覆盖轨槽位，随后进组装 */
  confirmEditorPlan(contentId: string, args: ConfirmEditorPlanArgs): Promise<VideoState>;
  /** 给一个待生成槽填素材：派生出新一版 plan（旧版原样留盘） */
  fillEditorSlot(contentId: string, args: FillEditorSlotArgs): Promise<EditorPlanView>;
  /** 删掉一段编排：与填槽共用同一个派生函数，同样派生新一版 plan */
  removeEditorSlot(contentId: string, args: RemoveEditorSlotArgs): Promise<EditorPlanView>;
  /** 门二退回门一（lifecycle §2.2）：在成片计划上才发现话说错了 */
  editorBackToCut(contentId: string, args: BackToCutArgs): Promise<VideoState>;
  /** 按门上当前勾选重渲一版预览；主状态不动，渲完由辅助 job 更新 preview 指针 */
  requestCutPreview(contentId: string, args: RequestPreviewArgs): Promise<VideoState>;
  /** 渲染失败在一份废 manifest 上时回组装重出一份（v2 spec §2.3 的死路出口） */
  reassemble(contentId: string): Promise<VideoState>;
  confirmReview(contentId: string, args: ConfirmReviewArgs): Promise<VideoState>;
  /** 重新跑一次 AI 粗剪（粗剪 spec §3.4）；人工已终裁的那版不许被后台覆盖 */
  rerunRoughCut(contentId: string): Promise<VideoState>;
  /** 重新跑一次剪辑师（横屏 spec §3.1）；只在成片计划的人工门上可用 */
  rerunEditor(contentId: string): Promise<VideoState>;
  retry(contentId: string): Promise<VideoState>;
  getStatus(contentId: string): Promise<VideoStatus | null>;
  getTranscript(contentId: string): Promise<CutView | null>;
  getEditorPlan(contentId: string): Promise<EditorPlanView | null>;
  warmupAsr(): Promise<{ status: string }>;
  asrStatus(): Promise<{ status: string; detail?: string }>;
  shutdown(): Promise<void>;
}

export interface VideoServiceOptions {
  dataDir: string;
  deps?: VideoDeps;
  onEvent?: (e: { type: "video:updated"; contentId: string }) => void;
  /** 测试/自定义渲染 workspace 位置 */
  renderDir?: string;
  launchId?: string;
  onError?: (message: string) => void;
}

function ref(state: VideoState): string {
  return `${state.phase}/${state.state}`;
}

export function createVideoService(opts: VideoServiceOptions): VideoService {
  const { dataDir } = opts;
  const report = (msg: string): void => (opts.onError ?? ((m: string) => console.error(`[video-service] ${m}`)))(msg);
  const emit = (contentId: string): void => opts.onEvent?.({ type: "video:updated", contentId });

  const runner: VideoRunner = createVideoRunner({
    dataDir,
    ...(opts.deps ? { deps: opts.deps } : {}),
    ...(opts.renderDir ? { renderDir: opts.renderDir } : {}),
    ...(opts.launchId ? { launchId: opts.launchId } : {}),
    onStateWritten: emit,
    onError: report,
  });

  // 启动回收先排在链头：任何一次调用都自动等它做完，不用外部再记得调一次。
  // 收尾清理的重试也在这里（§3.3）：done 落盘了但清理死在半路的稿件，启动时接着做完
  let chain: Promise<unknown> = runner
    .recoverExpired()
    .then((n) => (n > 0 ? report(`回收 ${n} 条中断的视频任务，已重排`) : undefined))
    .then(() => runner.resumeCleanup())
    .then((n) => (n > 0 ? report(`${n} 篇成片的收尾清理没做完，已重排`) : undefined))
    .catch((err: unknown) => report(`启动回收失败：${String(err)}`));

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  async function write(contentId: string, mutate: (cur: VideoState) => VideoState): Promise<VideoState> {
    const next = await transitionVideoState(dataDir, contentId, (cur) => {
      if (!cur) throw new Error("这篇还没开始剪，先点「开始剪」");
      return mutate(cur);
    });
    emit(contentId);
    return next;
  }

  async function requireState(contentId: string): Promise<VideoState> {
    const { state, warning } = await readVideoState(dataDir, contentId);
    if (warning) report(`${contentId}：${warning}`);
    if (!state) throw new Error("这篇还没开始剪，先点「开始剪」");
    return state;
  }

  // -------------------------------------------------------------------------
  // 投递
  // -------------------------------------------------------------------------

  function startBuild(contentId: string): Promise<VideoState> {
    return serialize(async () => {
      const eligible = await checkVideoEligibility(contentId, dataDir);
      if (!eligible.ok) throw new Error(eligible.reason);
      const { state } = await readVideoState(dataDir, contentId);
      // 已在管线里（含人工门与失败态）：重复投递合并成一次，不重置任何进度
      if (state && state.state !== "idle") {
        runner.enqueue(contentId);
        return state;
      }
      const next = await transitionVideoState(dataDir, contentId, (cur) => ({
        schemaVersion: 1,
        entryType: "aroll",
        phase: "ingest",
        state: "queued",
        revisions: cur?.revisions ?? {},
        updatedAt: "",
      }));
      emit(contentId);
      runner.enqueue(contentId);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // 人工门
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 成片计划（edit 人工门）
  // -------------------------------------------------------------------------

  /** 重新跑剪辑师（§3.1）。plan 还没被确认过，重跑只会多出一版 plan，覆盖不了任何决策 */
  function rerunEditor(contentId: string): Promise<VideoState> {
    return serialize(async () => {
      const state = await requireState(contentId);
      if (!(state.phase === "edit" && state.state === "awaiting_human")) {
        throw new Error(`当前是 ${ref(state)}，还轮不到重跑剪辑师`);
      }
      const next = await write(contentId, (cur) => ({ ...cur, phase: "edit", state: "queued" }));
      runner.enqueue(contentId);
      return next;
    });
  }

  /**
   * 重新跑 AI 粗剪（§3.4）。`retry` 只接受 failed/blocked，够不着「建议没产出但状态是
   * awaiting_human」这一格，所以单开一个入口。**人工已终裁的那版禁止被后台覆盖**。
   */
  /**
   * 成片计划这道门（confirm / 填槽）。它自己不开事务，读写与入队都用这里的原语——
   * 「三条路走同一道闸」那段判定住在 editor-gate.ts。
   */
  /** 审片这道门（通过 / 打回分流 / 落记录 / 排清理）住在 review-gate.ts，同样不自己开事务 */
  const reviewGate = createReviewGate({
    dataDir,
    requireState,
    write,
    enqueueCleanup: (id) => runner.enqueueCleanup(id),
    describe: ref,
    report,
  });

  /** 选段这道门（确认 / 重跑粗剪 / 门内预览）住在 cut-gate.ts */
  const cutGate = createCutGate({
    dataDir,
    requireState,
    write,
    enqueue: (id) => runner.enqueue(id),
    enqueuePreview: (task) => runner.enqueuePreview(task),
    describe: ref,
  });

  const editorGate = createEditorGate({
    dataDir,
    ...(opts.deps ? { deps: opts.deps } : {}),
    requireState,
    write,
    enqueue: (contentId) => runner.enqueue(contentId),
    describe: ref,
  });

  /**
   * 渲染失败在一份废 manifest 上时的出口（v2 spec §2.3）。
   * `retry` 只会重投同一份 manifest——对「旧 schema 被 zod 拒」这类失败，重试永远是死路，
   * 所以另开一条受控回退边回 assemble 重出一份。
   */
  function reassemble(contentId: string): Promise<VideoState> {
    return serialize(async () => {
      const state = await requireState(contentId);
      if (!(state.phase === "render" && state.state === "failed")) {
        throw new Error(`当前是 ${ref(state)}，只有渲染失败时才需要重新组装`);
      }
      const next = await write(contentId, (cur) => ({ ...cur, phase: "assemble", state: "queued" }));
      runner.enqueue(contentId);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // 重试与查询
  // -------------------------------------------------------------------------

  function retry(contentId: string): Promise<VideoState> {
    return serialize(async () => {
      const state = await requireState(contentId);
      if (state.state !== "failed" && state.state !== "blocked") {
        throw new Error(`当前是 ${ref(state)}，没有可重试的失败`);
      }
      // failed 重投 failedPhase（失败时 phase 原地不动，两者恒相等）；blocked 重投当前 phase
      const phase = state.state === "failed" ? (state.failedPhase ?? state.phase) : state.phase;
      // 只清失败痕迹，其余状态字段原样带走——白名单重建会在每加一个字段时悄悄丢掉它
      const next = await write(contentId, (cur) => {
        const { blockedReason: _b, failedPhase: _f, errorCode: _e, failReason: _r, ...carried } = cur;
        return { ...carried, phase, state: "queued", updatedAt: "" };
      });
      runner.enqueue(contentId);
      return next;
    });
  }

  function getStatus(contentId: string): Promise<VideoStatus | null> {
    return serialize(async () => {
      const { state, warning } = await readVideoState(dataDir, contentId);
      if (warning) report(`${contentId}：${warning}`);
      if (!state) return null;
      const jobs = latestJobsView(await readVideoJobs(dataDir)).filter((j) => j.contentId === contentId);
      // 打回的备注与定位跟着状态一起回前端：目标门的横幅读它，刷新不丢（§2.4）
      const rendered = state.revisions.rendered ?? 0;
      const review = rendered ? await readReviewDecision(dataDir, contentId, rendered) : null;
      return { state, jobs, ...(review ? { review } : {}) };
    });
  }

  function getTranscript(contentId: string): Promise<CutView | null> {
    return serialize(async () => {
      const { state } = await readVideoState(dataDir, contentId);
      if (!state?.revisions.transcript || !state.revisions.cut) return null;
      const dir = videoDir(dataDir, contentId);
      const transcript = await readVersioned<VideoTranscript>(dir, "transcript", state.revisions.transcript);
      const cut = await readVersioned<VideoCut>(dir, "cut", state.revisions.cut);
      if (!transcript || !cut) return null;
      // 老产物没有 edit-units：面板据此回落 transcript.segments（§4）
      const editUnits = await readEditUnits(dir, state.revisions.cut);
      return { transcript, cut, ...(editUnits ? { editUnits } : {}) };
    });
  }

  /**
   * 还没跑过剪辑师 = null（不是错误）：面板据此显示「剪辑师还没排」而不是红字。
   * plan 与当前选段对不上时带 `staleCutRevision` 出去——面板出横幅并挡住确认，
   * 因为按旧输出域时间排的 overlay 会落在错误的话上（§2.2）。
   */
  function getEditorPlan(contentId: string): Promise<EditorPlanView | null> {
    return serialize(async () => {
      const { state } = await readVideoState(dataDir, contentId);
      const revision = state?.revisions.editor ?? 0;
      if (!revision) return null;
      const raw = await readVersioned<VideoEditorPlan>(videoDir(dataDir, contentId), "editor-plan", revision);
      if (!raw) return null;
      const plan = tolerateLegacyPlan(raw);
      const cutRevision = state?.revisions.cut ?? 0;
      return {
        plan,
        revision,
        ...(plan.cutRevision !== cutRevision ? { staleCutRevision: plan.cutRevision } : {}),
      };
    });
  }

  return {
    startBuild,
    confirmCut: (contentId, args) => serialize(() => cutGate.confirm(contentId, args)),
    confirmEditorPlan: (contentId, args) => serialize(() => editorGate.confirm(contentId, args)),
    fillEditorSlot: (contentId, args) => serialize(() => editorGate.fillSlot(contentId, args)),
    removeEditorSlot: (contentId, args) => serialize(() => editorGate.removeSlot(contentId, args)),
    editorBackToCut: (contentId, args) => serialize(() => editorGate.backToCut(contentId, args)),
    requestCutPreview: (contentId, args) => serialize(() => cutGate.requestPreview(contentId, args)),
    reassemble,
    confirmReview: (contentId, args) => serialize(() => reviewGate.confirm(contentId, args)),
    rerunRoughCut: (contentId) => serialize(() => cutGate.rerunRoughCut(contentId)),
    rerunEditor,
    retry,
    getStatus,
    getTranscript,
    getEditorPlan,
    warmupAsr: async () => {
      const record = await warmupAsr(dataDir, opts.deps);
      return { status: record.status };
    },
    asrStatus: async () => {
      const record: AsrStatusRecord = await readAsrStatus(dataDir);
      return { status: record.status, ...(record.detail ? { detail: record.detail } : {}) };
    },
    shutdown: () => runner.shutdown(),
  };
}
