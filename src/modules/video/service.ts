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
import { writeEmphasisWords, writeOverlaySlots } from "./timeline-build.js";
import { planToSlots } from "./editor-plan.js";
import { checkVideoEligibility } from "./ingest.js";
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
import type {
  CutFlag,
  EditorPlanOverlay,
  TranscriptSegment,
  VideoCut,
  VideoEditUnits,
  VideoEditorPlan,
  VideoJob,
  VideoPhase,
  VideoState,
  VideoTranscript,
} from "./types.js";

/** 乐观锁冲突：调用方据此提示「有人改过了，已为你重载」，而不是当作系统故障 */
export class VideoConflictError extends Error {
  constructor(
    message: string,
    readonly current: VideoState,
  ) {
    super(message);
    this.name = "VideoConflictError";
  }
}

export interface ConfirmCutArgs {
  keeps: string[];
  flags: CutFlag[];
  baseTranscriptRevision: number;
  baseCutRevision: number;
}

/**
 * 成片计划的确认（横屏 spec §3.1）。**覆盖轨槽位的唯一写入口**——
 * 编排由剪辑师产出、由人删定，不再有第二条「人手摆时间轴」的入口与它抢同一份产物。
 */
export interface ConfirmEditorPlanArgs {
  planRevision: number;
  keptOverlayIds: string[];
  /** 不传 = 保留 plan 里全部强调词；传了按传的（面板可删 chip），只能删不能新增 */
  keptEmphasisWords?: string[];
}

/** 成片计划视图：plan 本体 + 它的版本号（提交时当乐观锁的 base） */
export interface EditorPlanView {
  plan: VideoEditorPlan;
  revision: number;
}

export interface ConfirmReviewArgs {
  renderedRevision: number;
  verdict: "approve" | "reject";
}

export interface VideoStatus {
  state: VideoState;
  jobs: VideoJob[];
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

  // 启动回收先排在链头：任何一次调用都自动等它做完，不用外部再记得调一次
  let chain: Promise<unknown> = runner
    .recoverExpired()
    .then((n) => (n > 0 ? report(`回收 ${n} 条中断的视频任务，已重排`) : undefined))
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

  function assertCutBase(state: VideoState, args: ConfirmCutArgs): void {
    const transcriptRevision = state.revisions.transcript ?? 0;
    const cutRevision = state.revisions.cut ?? 0;
    if (transcriptRevision !== args.baseTranscriptRevision || cutRevision !== args.baseCutRevision) {
      throw new VideoConflictError(
        `选段基于的版本已过期（你拿的是转写 v${args.baseTranscriptRevision}/选段 v${args.baseCutRevision}，` +
          `当前是 v${transcriptRevision}/v${cutRevision}），请重载后重试`,
        state,
      );
    }
  }

  function assertKeeps(segments: TranscriptSegment[], args: ConfirmCutArgs): void {
    const known = new Set(segments.map((s) => s.id));
    const unknown = [...new Set([...args.keeps, ...args.flags.map((f) => f.segmentId)])].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`引用了转写里不存在的分句：${unknown.join("、")}`);
    if (args.keeps.length === 0) {
      throw new Error(
        segments.length === 0
          ? "这条素材没转写出任何一句（纯音乐或全程静音？），换素材或重跑转写"
          : "一句都没勾选，成片会是空的——至少留一句",
      );
    }
  }

  /**
   * 单元表随 cut 一起进新版本：cut.vK 与 edit-units.vK 必须同号，否则 assemble 会拿
   * 新 keeps 去 transcript.segments 里找 unit id，当场找不到。
   * AI 的 suggestedDrops 与 provenance 原样留着——人「恢复全留」之后，那仍是只读证据。
   */
  async function carryEditUnits(dir: string, base: VideoEditUnits | null, revision: number, flags: CutFlag[]): Promise<void> {
    if (!base) return;
    // warning 是「AI 那一轮出了什么状况」，人已经处理完了，不该跟着新版本继续报警
    const { warning: _handled, ...rest } = base;
    await writeVersioned(dir, "edit-units", revision, { ...rest, flags });
  }

  function confirmCut(contentId: string, args: ConfirmCutArgs): Promise<VideoState> {
    return serialize(async () => {
      const state = await requireState(contentId);
      const reopening = state.phase === "done" && state.state === "done";
      if (!reopening && !(state.phase === "cut" && state.state === "awaiting_human")) {
        throw new Error(`当前是 ${ref(state)}，还轮不到确认选段`);
      }
      assertCutBase(state, args);
      const dir = videoDir(dataDir, contentId);
      const transcriptRevision = state.revisions.transcript ?? 0;
      const transcript = await readVersioned<VideoTranscript>(dir, "transcript", transcriptRevision);
      if (!transcript) throw new Error(`读不到 transcript.v${transcriptRevision}，请重跑转写`);
      const units = await readEditUnits(dir, args.baseCutRevision);
      assertKeeps(units?.segments ?? transcript.segments, args);

      const cutRevision = (state.revisions.cut ?? 0) + 1;
      const cut: VideoCut = {
        transcriptRevision,
        keeps: args.keeps,
        flags: args.flags,
        origin: "human",
        baseCutRevision: args.baseCutRevision,
      };
      await writeVersioned(dir, "cut", cutRevision, cut);
      await carryEditUnits(dir, units, cutRevision, args.flags);
      // 选段定稿后接的是剪辑师，不是组装：plan 用输出域时间，keeps 不定它就算不出来（§3.1）
      const next = await write(contentId, (cur) => ({
        ...cur,
        phase: "edit",
        state: "queued",
        revisions: { ...cur.revisions, cut: cutRevision },
      }));
      runner.enqueue(contentId);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // 成片计划（edit 人工门）
  // -------------------------------------------------------------------------

  /** 只能删不能改：留下的必须是 plan 里原样的那几段，前端传不进新东西 */
  function pickOverlays(plan: VideoEditorPlan, keptIds: string[]): EditorPlanOverlay[] {
    const known = new Set(plan.overlays.map((o) => o.overlayId));
    const unknown = keptIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`这一版成片计划里没有这些片段：${unknown.join("、")}，请重载后重试`);
    const kept = new Set(keptIds);
    return plan.overlays.filter((o) => kept.has(o.overlayId));
  }

  function pickEmphasis(plan: VideoEditorPlan, kept?: string[]): string[] {
    if (!kept) return plan.emphasisWords;
    const known = new Set(plan.emphasisWords);
    const unknown = kept.filter((w) => !known.has(w));
    if (unknown.length > 0) throw new Error(`这一版成片计划里没有这些强调词：${unknown.join("、")}，请重载后重试`);
    return plan.emphasisWords.filter((w) => kept.includes(w));
  }

  /**
   * 确认成片计划。**覆盖轨槽位与强调词按 cutRevision 存**，因为 assemble 就按
   * `revisions.cut` 去读它们；plan 自己的版本（`revisions.editor`）只用来做乐观锁——
   * 同一版 cut 可以重跑 N 次剪辑师（plan 版本一路涨），但只会确认一次，所以按 cut 编号
   * 恰好落一份，不会撞上「版本化产物不可覆盖」。
   */
  function confirmEditorPlan(contentId: string, args: ConfirmEditorPlanArgs): Promise<VideoState> {
    return serialize(async () => {
      const state = await requireState(contentId);
      if (!(state.phase === "edit" && state.state === "awaiting_human")) {
        throw new Error(`当前是 ${ref(state)}，还轮不到确认成片计划`);
      }
      const planRevision = state.revisions.editor ?? 0;
      if (planRevision !== args.planRevision) {
        throw new VideoConflictError(
          `成片计划基于的版本已过期（你拿的是 v${args.planRevision}，当前是 v${planRevision}），请重载后重试`,
          state,
        );
      }
      const dir = videoDir(dataDir, contentId);
      const plan = await readVersioned<VideoEditorPlan>(dir, "editor-plan", planRevision);
      if (!plan) throw new Error(`读不到 editor-plan.v${planRevision}，请点「重新跑剪辑师」再来一版`);
      const overlays = pickOverlays(plan, args.keptOverlayIds);
      const words = pickEmphasis(plan, args.keptEmphasisWords);
      const cutRevision = state.revisions.cut ?? 0;
      if (overlays.length > 0) await writeOverlaySlots(dataDir, contentId, cutRevision, planToSlots(overlays));
      if (words.length > 0) await writeEmphasisWords(dataDir, contentId, cutRevision, words);
      const next = await write(contentId, (cur) => ({ ...cur, phase: "assemble", state: "queued" }));
      runner.enqueue(contentId);
      return next;
    });
  }

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
  function rerunRoughCut(contentId: string): Promise<VideoState> {
    return serialize(async () => {
      const state = await requireState(contentId);
      if (!(state.phase === "cut" && state.state === "awaiting_human")) {
        throw new Error(`当前是 ${ref(state)}，还轮不到重跑 AI 粗剪`);
      }
      const cut = await readVersioned<VideoCut>(videoDir(dataDir, contentId), "cut", state.revisions.cut ?? 0);
      if (cut?.origin === "human") {
        throw new Error("这一版选段是你自己确认过的，AI 建议不会覆盖它——想重来请先重跑转写");
      }
      const next = await write(contentId, (cur) => ({ ...cur, phase: "cut", state: "queued" }));
      runner.enqueue(contentId);
      return next;
    });
  }

  function confirmReview(contentId: string, args: ConfirmReviewArgs): Promise<VideoState> {
    return serialize(async () => {
      const state = await requireState(contentId);
      if (!(state.phase === "review" && state.state === "awaiting_human")) {
        throw new Error(`当前是 ${ref(state)}，还轮不到审片`);
      }
      const rendered = state.revisions.rendered ?? 0;
      if (rendered !== args.renderedRevision) {
        throw new VideoConflictError(
          `审的是成片 v${args.renderedRevision}，当前已是 v${rendered}，请重载后重试`,
          state,
        );
      }
      // 打回 = 回选段重剪（阶段回退白名单的两条边之一，§2.2 v2.1）
      const target: { phase: VideoPhase; state: VideoState["state"] } =
        args.verdict === "approve" ? { phase: "done", state: "done" } : { phase: "cut", state: "awaiting_human" };
      return write(contentId, (cur) => ({ ...cur, ...target }));
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
      const next = await write(contentId, (cur) => ({
        schemaVersion: 1,
        entryType: "aroll",
        phase,
        state: "queued",
        revisions: cur.revisions,
        ...(cur.inputManifest ? { inputManifest: cur.inputManifest } : {}),
        ...(cur.stale ? { stale: cur.stale } : {}),
        updatedAt: "",
      }));
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
      return { state, jobs };
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

  /** 还没跑过剪辑师 = null（不是错误）：面板据此显示「剪辑师还没排」而不是红字 */
  function getEditorPlan(contentId: string): Promise<EditorPlanView | null> {
    return serialize(async () => {
      const { state } = await readVideoState(dataDir, contentId);
      const revision = state?.revisions.editor ?? 0;
      if (!revision) return null;
      const plan = await readVersioned<VideoEditorPlan>(videoDir(dataDir, contentId), "editor-plan", revision);
      return plan ? { plan, revision } : null;
    });
  }

  return {
    startBuild,
    confirmCut,
    confirmEditorPlan,
    confirmReview,
    rerunRoughCut,
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
