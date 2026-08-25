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
import { editUnitText, locateUnitWords, manualTextReason } from "./transcript-edit.js";
import {
  readEditUnits,
  removeVersioned,
  readEffectiveTranscript,
  readTranscriptClean,
  readVersioned,
  videoDir,
  writeVersioned,
} from "./video-store.js";
import type { PreviewTask } from "./runner-preview.js";
import type {
  CutFlag,
  TranscriptClean,
  TranscriptSegment,
  VideoCut,
  VideoEditUnits,
  VideoState,
  VideoTranscript,
} from "./types.js";

export interface ConfirmCutArgs {
  keeps: string[];
  flags: CutFlag[];
  baseTranscriptRevision: number;
  baseCutRevision: number;
}

/**
 * 手工改字（转写纠错 spec §6）。**三个 base 一起锁**：文字住在 `transcript-clean.v<C>` 里，
 * 只锁转写与选段会漏掉「后台刚重跑完清洗」那一格——那时人手里的字已经不是盘上的字，
 * 照改就等于把新清洗结果悄悄盖回旧文字。
 */
export interface EditUnitTextArgs {
  unitId: string;
  text: string;
  baseTranscriptRevision: number;
  baseCleanRevision: number;
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
  rerunTranscribe(contentId: string): Promise<VideoState>;
  requestPreview(contentId: string, args: RequestPreviewArgs): Promise<VideoState>;
  /** 门上手工改一句的文字：落一版 `origin:"human"` 的 clean，选段勾选原样带过去 */
  editText(contentId: string, args: EditUnitTextArgs): Promise<VideoState>;
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
    // 门上勾的是**有效文字**（转写纠错 spec §5）：没有单元表时回落的也该是清洗过的分句
    const transcript = await readEffectiveTranscript(dir, {
      transcript: transcriptRevision,
      clean: state.revisions.clean,
    });
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
      // 追溯链（§1）：这一版终裁是对着哪一版文字勾的
      ...(state.revisions.clean ? { cleanRevision: state.revisions.clean } : {}),
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
   * 重跑转写（转写纠错 spec §7）。门上看见错字、或者改了稿子想让热词与清洗重认一遍时，
   * 这是唯一的出口——`retry` 只接受 failed/blocked，重跑粗剪又只重算取舍不重认文字。
   *
   * **不看 `cut.origin`**：重跑转写的语义就是「事实要换一版」，这一版选段与手工改字一并作废
   * （新 transcript/clean revision 一出，旧 keeps 的分句 id 在新文字里根本不存在）。
   * 这与「重跑粗剪不许覆盖人工终裁」不矛盾：那是后台建议偷偷盖掉人的决定，这是人自己按的
   * 按钮——按钮上写明「会作废已勾的选段与手工改字」是 UI 的责任（§7）。
   *
   * 代价可控：ASR 结果有缓存（§2），素材没换的重跑跳过十几分钟的推理，只重跑清洗。
   */
  async function rerunTranscribe(contentId: string): Promise<VideoState> {
    const state = await ctx.requireState(contentId);
    if (!(state.phase === "cut" && state.state === "awaiting_human")) {
      throw new Error(`当前是 ${ctx.describe(state)}，只有停在选段这道门上时才能重跑转写`);
    }
    const next = await ctx.write(contentId, (cur) => ({ ...cur, phase: "transcribe", state: "queued" }));
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
    const { state } = await requireCut(contentId, args, [], (s) => {
      if (!(s.phase === "cut" && s.state === "awaiting_human")) {
        throw new Error(`当前是 ${ctx.describe(s)}，还轮不到看粗剪预览`);
      }
    });
    // 文字版本进请求：渲完落盘前对着当前 revision 复核，迟到的旧字幕不许冒充新的（§5）
    const cleanRevision = state.revisions.clean;
    const revision = await writePreviewRequest(dataDir, contentId, {
      keeps: args.keeps,
      baseCutRevision: args.baseCutRevision,
      baseTranscriptRevision: args.baseTranscriptRevision,
      ...(cleanRevision ? { baseCleanRevision: cleanRevision } : {}),
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
      ...(cleanRevision ? { cleanRevision } : {}),
    });
    return next;
  }

  // -------------------------------------------------------------------------
  // 手工改字（转写纠错 spec §6）
  // -------------------------------------------------------------------------

  /** 三 base 齐锁；不符即冲突（一等结果），前端重载后重改，绝不盲改 */
  function assertTextBase(state: VideoState, args: EditUnitTextArgs): void {
    const cur = {
      transcript: state.revisions.transcript ?? 0,
      clean: state.revisions.clean ?? 0,
      cut: state.revisions.cut ?? 0,
    };
    if (
      cur.transcript === args.baseTranscriptRevision &&
      cur.clean === args.baseCleanRevision &&
      cur.cut === args.baseCutRevision
    ) {
      return;
    }
    throw new VideoConflictError(
      `要改的那版文字已经过期（你拿的是转写 v${args.baseTranscriptRevision}/文字 v${args.baseCleanRevision}/` +
        `选段 v${args.baseCutRevision}，当前是 v${cur.transcript}/v${cur.clean}/v${cur.cut}），请重载后重改`,
      state,
    );
  }

  /**
   * 版本化产物撞上「不可覆盖」= 有人抢在前面写了同一个号（§1 的并发裁决：**不引入新锁**，
   * 用 link 的 EEXIST 当仲裁）。翻成冲突而不是故障：前端重载最新版再改一次就行。
   */
  async function writeOrConflict(
    dir: string,
    base: string,
    revision: number,
    data: unknown,
    state: VideoState,
  ): Promise<void> {
    try {
      await writeVersioned(dir, base, revision, data);
    } catch (err) {
      if (err instanceof Error && err.message.includes("版本化产物不可覆盖")) {
        throw new VideoConflictError("同一时间有另一处也在改这一版文字，你这次没写进去——请重载后重改", state);
      }
      throw err;
    }
  }

  /**
   * 手工改字（§6）：热词防不住、清洗也没治好的错字，这是最后一道兜底。
   *
   * 一次改字同时定三版产物：
   * - `transcript-clean.v<C+1>`：`origin:"human"`、`baseCleanRevision=C`，其余分句原样，
   *   **不带 warning**——那句话说的是上一版清洗降级了什么，手改版没有降级要报；
   * - `edit-units.v<K+1>`：只有目标单元的 words/text 变，id、结构、源区间一律不动；
   * - `cut.v<K+1>`：keeps/flags/origin 原样携带（改个错字不该把勾了半天的选段清空），
   *   `cleanRevision` 指向新文字。单元表与 cut 必须同号，消费方拿 `revisions.cut` 一个数
   *   同时定位两份产物。
   *
   * **先写 clean**：并发双写抢的是同一个 clean 号，输的那个在第一步就被 EEXIST 挡下，
   * 还没碰到 cut/units，盘上不会留下半套产物。
   */
  async function editText(contentId: string, args: EditUnitTextArgs): Promise<VideoState> {
    const state = await ctx.requireState(contentId);
    if (!(state.phase === "cut" && state.state === "awaiting_human")) {
      throw new Error(`当前是 ${ctx.describe(state)}，还轮不到在门上改字`);
    }
    assertTextBase(state, args);
    const bad = manualTextReason(args.text);
    if (bad) throw new Error(bad);
    const text = args.text.trim();

    const dir = videoDir(dataDir, contentId);
    const clean = args.baseCleanRevision > 0 ? await readTranscriptClean(dir, args.baseCleanRevision) : null;
    if (!clean || clean.transcriptRevision !== args.baseTranscriptRevision) {
      throw new Error("这一版转写还没有可改的文字（老稿件没跑过清洗）——先重跑一次转写再改字");
    }
    const units = await readEditUnits(dir, args.baseCutRevision);
    const unit = units?.segments.find((s) => s.id === args.unitId);
    if (!units || !unit) throw new Error(`这一版选段里没有「${args.unitId}」这一句，刷新后重试`);
    const cut = await readVersioned<VideoCut>(dir, "cut", args.baseCutRevision);
    if (!cut) throw new Error(`读不到 cut.v${args.baseCutRevision}，刷新后重试`);
    // 单元的词序列必是某一句里的连续子区间（splitEditUnits 把分句边界也当切点）；
    // 定位不到 = 手里这份单元表与盘上这版文字对不上，人话拒绝，绝不改到别的句子上
    const spot = locateUnitWords(clean.segments, unit.words ?? []);
    if (!spot) throw new Error(`「${args.unitId}」在当前文字里定位不到（多半是文字又换过一版），刷新后重试`);

    const edited = editUnitText(clean.segments[spot.segmentIndex], spot.from, spot.to, text);
    const cleanRevision = args.baseCleanRevision + 1;
    const cutRevision = args.baseCutRevision + 1;
    const nextClean: TranscriptClean = {
      schemaVersion: 1,
      transcriptRevision: args.baseTranscriptRevision,
      baseCleanRevision: args.baseCleanRevision,
      origin: "human",
      segments: clean.segments.map((s, i) => (i === spot.segmentIndex ? edited.segment : s)),
    };
    const nextUnits: VideoEditUnits = {
      ...units,
      cleanRevision,
      // 单元的 startMs/endMs 不动：源区间是这段音频的事实，改字不该改成片时长
      segments: units.segments.map((s) => (s.id === args.unitId ? { ...s, text, words: edited.words } : s)),
    };
    const nextCut: VideoCut = { ...cut, cleanRevision, baseCutRevision: args.baseCutRevision };
    await writeOrConflict(dir, "transcript-clean", cleanRevision, nextClean, state);
    try {
      await writeOrConflict(dir, "edit-units", cutRevision, nextUnits, state);
      await writeOrConflict(dir, "cut", cutRevision, nextCut, state);
    } catch (err) {
      // clean 号是这次刚抢到、state 还没引用的：留着它，下一次改字会永远撞同一个号，
      // 一次冲突就变成永久冲突（跨进程时后台 promote 抢走 cut 号而 clean 号空着的错峰）。
      // 回删之后，冲突文案里的「重载后重改」才是真话。
      if (err instanceof VideoConflictError) {
        await removeVersioned(dir, "transcript-clean", cleanRevision).catch(() => {});
      }
      throw err;
    }
    // 门不动（人还在挑），只把两个 revision 往前推一格：SSE 一响前端就重拉新文字
    return ctx.write(contentId, (cur) => ({
      ...cur,
      revisions: { ...cur.revisions, clean: cleanRevision, cut: cutRevision },
    }));
  }

  return { confirm, rerunRoughCut, rerunTranscribe, requestPreview, editText };
}
