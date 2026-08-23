/**
 * 选段人工门（视频 spec §4.4 + 粗剪 spec §3.4 + v2 spec §4.1）：确认选段、重跑 AI 粗剪、门内重渲预览。
 *
 * 与 `editor-gate.ts` / `review-gate.ts` 同一套分工：门的判定与产物住在这儿，
 * 事务（状态读写、串行链、入队）由 service 注入。三道门三个文件，看得见「门就是门」。
 *
 * 两条纪律：
 * 1. **乐观锁**：确认与预览都必须带手里那版的 base revision，不符抛 `VideoConflictError`——
 *    两个窗口同时确认时，后到者看得见冲突而不是默默覆盖。
 * 2. **预览不动主状态**：主状态全程钉在 `cut/awaiting_human`，确认不被渲染阻塞。
 */
import { VideoConflictError } from "./errors.js";
import { writePreviewRequest } from "./preview-exec.js";
import { readEditUnits, readVersioned, videoDir, writeVersioned } from "./video-store.js";
import type { PreviewTask } from "./runner-preview.js";
import type { CutFlag, TranscriptSegment, VideoCut, VideoEditUnits, VideoState, VideoTranscript } from "./types.js";

export interface ConfirmCutArgs {
  keeps: string[];
  flags: CutFlag[];
  baseTranscriptRevision: number;
  baseCutRevision: number;
}

/** 门内重渲预览（v2 spec §4.1）：勾选是草稿，**不写 cut revision** */
export interface RequestPreviewArgs {
  keeps: string[];
  baseTranscriptRevision: number;
  baseCutRevision: number;
}

export interface CutGateDeps {
  dataDir: string;
  requireState: (contentId: string) => Promise<VideoState>;
  write: (contentId: string, mutate: (cur: VideoState) => VideoState) => Promise<VideoState>;
  enqueue: (contentId: string) => void;
  enqueuePreview: (task: PreviewTask) => void;
  describe: (state: VideoState) => string;
}

export interface CutGate {
  confirm(contentId: string, args: ConfirmCutArgs): Promise<VideoState>;
  rerunRoughCut(contentId: string): Promise<VideoState>;
  requestPreview(contentId: string, args: RequestPreviewArgs): Promise<VideoState>;
}

export function createCutGate(ctx: CutGateDeps): CutGate {
  const { dataDir } = ctx;

  function assertBase(state: VideoState, args: RequestPreviewArgs): void {
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

  function assertKeeps(segments: TranscriptSegment[], keeps: string[], flags: CutFlag[]): void {
    const known = new Set(segments.map((s) => s.id));
    const unknown = [...new Set([...keeps, ...flags.map((f) => f.segmentId)])].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`引用了转写里不存在的分句：${unknown.join("、")}`);
    if (keeps.length === 0) {
      throw new Error(
        segments.length === 0
          ? "这条素材没转写出任何一句（纯音乐或全程静音？），换素材或重跑转写"
          : "一句都没勾选，成片会是空的——至少留一句",
      );
    }
  }

  /** 门上的三个入口共用：版本对得上 + 转写读得到 + 勾选合法 */
  async function requireCut(
    contentId: string,
    args: RequestPreviewArgs,
    flags: CutFlag[],
    check: (state: VideoState) => void,
  ): Promise<{ state: VideoState; dir: string; transcript: VideoTranscript; units: VideoEditUnits | null }> {
    const state = await ctx.requireState(contentId);
    check(state);
    assertBase(state, args);
    const dir = videoDir(dataDir, contentId);
    const transcriptRevision = args.baseTranscriptRevision;
    const transcript = await readVersioned<VideoTranscript>(dir, "transcript", transcriptRevision);
    if (!transcript) throw new Error(`读不到 transcript.v${transcriptRevision}，请重跑转写`);
    const units = await readEditUnits(dir, args.baseCutRevision);
    assertKeeps(units?.segments ?? transcript.segments, args.keeps, flags);
    return { state, dir, transcript, units };
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

  async function confirm(contentId: string, args: ConfirmCutArgs): Promise<VideoState> {
    const { state, dir, units } = await requireCut(contentId, args, args.flags, (s) => {
      const reopening = s.phase === "done" && s.state === "done";
      if (!reopening && !(s.phase === "cut" && s.state === "awaiting_human")) {
        throw new Error(`当前是 ${ctx.describe(s)}，还轮不到确认选段`);
      }
    });
    const cutRevision = (state.revisions.cut ?? 0) + 1;
    const cut: VideoCut = {
      transcriptRevision: args.baseTranscriptRevision,
      keeps: args.keeps,
      flags: args.flags,
      origin: "human",
      baseCutRevision: args.baseCutRevision,
    };
    await writeVersioned(dir, "cut", cutRevision, cut);
    await carryEditUnits(dir, units, cutRevision, args.flags);
    // 选段定稿后接的是剪辑师，不是组装：plan 用输出域时间，keeps 不定它就算不出来（§3.1）
    const next = await ctx.write(contentId, (cur) => ({
      ...cur,
      phase: "edit",
      state: "queued",
      revisions: { ...cur.revisions, cut: cutRevision },
    }));
    ctx.enqueue(contentId);
    return next;
  }

  /**
   * 重新跑 AI 粗剪（§3.4）。`retry` 只接受 failed/blocked，够不着「建议没产出但状态是
   * awaiting_human」这一格，所以单开一个入口。**人工已终裁的那版禁止被后台覆盖**。
   */
  async function rerunRoughCut(contentId: string): Promise<VideoState> {
    const state = await ctx.requireState(contentId);
    if (!(state.phase === "cut" && state.state === "awaiting_human")) {
      throw new Error(`当前是 ${ctx.describe(state)}，还轮不到重跑 AI 粗剪`);
    }
    const cut = await readVersioned<VideoCut>(videoDir(dataDir, contentId), "cut", state.revisions.cut ?? 0);
    if (cut?.origin === "human") {
      throw new Error("这一版选段是你自己确认过的，AI 建议不会覆盖它——想重来请先重跑转写");
    }
    const next = await ctx.write(contentId, (cur) => ({ ...cur, phase: "cut", state: "queued" }));
    ctx.enqueue(contentId);
    return next;
  }

  /**
   * 按门上当前勾选重渲一版预览。
   *
   * **主状态一个字都不动**：只把 `preview.requestedRevision` 往前推一格，人随时能确认，
   * 不被渲染阻塞（门就是门）。旧的 `readyRevision` 留着——新的还没好之前，老预览照样能播。
   * 请求本身落成不可变产物 `cut-preview-request.v<P>.json`，草稿因此不污染 cut 语义。
   */
  async function requestPreview(contentId: string, args: RequestPreviewArgs): Promise<VideoState> {
    await requireCut(contentId, args, [], (s) => {
      if (!(s.phase === "cut" && s.state === "awaiting_human")) {
        throw new Error(`当前是 ${ctx.describe(s)}，还轮不到看粗剪预览`);
      }
    });
    const revision = await writePreviewRequest(dataDir, contentId, {
      keeps: args.keeps,
      baseCutRevision: args.baseCutRevision,
      baseTranscriptRevision: args.baseTranscriptRevision,
    });
    const next = await ctx.write(contentId, (cur) => ({
      ...cur,
      preview: {
        requestedRevision: revision,
        ...(cur.preview?.readyRevision !== undefined ? { readyRevision: cur.preview.readyRevision } : {}),
      },
    }));
    ctx.enqueuePreview({
      contentId,
      revision,
      keeps: args.keeps,
      transcriptRevision: args.baseTranscriptRevision,
      cutRevision: args.baseCutRevision,
    });
    return next;
  }

  return { confirm, rerunRoughCut, requestPreview };
}
