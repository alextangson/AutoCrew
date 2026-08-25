/**
 * 各阶段「干什么」（设计 spec §4.2 / §4.3 / §5 / §6）。
 *
 * 与 runner 的分工：runner 管**调度与事务**（认领、心跳、CAS、回收），这里只管
 * **一步之内做完什么事、产出什么 revision、失败算 blocked 还是 failed**。
 * 所以本文件里没有一处写 state.json——推进状态是 runner 的独占权力。
 *
 * 每个阶段都返回同一个 `StepResult`：成功给下一格状态与新 revision，
 * 失败给 errorCode + 中文原因（blocked 另带 blockedReason），或者「跑完了但结果没达成」
 * 的 warning 变体（粗剪 spec §3.4）——AI 粗剪失败必须停在人工门而不是 failed，
 * 人还能手工选段。**只有这三种出口**，静默降级在这一层就被形状挡住了。
 */
import path from "node:path";
import { getContent } from "../../storage/local-store.js";
import { assembleVideo, driftedAssets, ASSEMBLE_STAGED_BASES } from "./assemble.js";
import { extractAsrWav, runAsr, scriptMatchRatio } from "./asr.js";
import { buildBrollCatalog } from "./broll-catalog.js";
import { loadConfirmedOverlays } from "./editor-decision.js";
import { runEditor, type EditorKeepUnit } from "./editor.js";
import { extractHotwords } from "./hotwords.js";
import { ingestAroll } from "./ingest.js";
import { buildOutputMap, outputDurationMs } from "./output-map.js";
import type { VideoDeps } from "./proc.js";
import { renderGatePreview } from "./preview-exec.js";
import { runRenderJob } from "./render-exec.js";
import { runRoughCut } from "./rough-cut.js";
import type { VideoStateRef } from "./state-machine.js";
import { ASR_OUT_FILE, asrCacheMeta, clearAsrCacheMeta, readCachedAsr, writeAsrCacheMeta } from "./transcribe-input.js";
import { runTranscriptClean } from "./transcript-clean.js";
import {
  readEditUnits,
  readEffectiveTranscript,
  readVersioned,
  readVideoAssets,
  resolveAssetRef,
  videoDir,
  writeStaging,
} from "./video-store.js";
import type {
  RenderManifest,
  TranscriptClean,
  TranscriptSegment,
  VideoAssetEntry,
  VideoBlockedReason,
  VideoCut,
  VideoEditUnits,
  VideoEditorPlan,
  VideoPreviewState,
  VideoRevisions,
  VideoState,
  VideoTranscript,
} from "./types.js";

/** 已落 staging、等 CAS 通过后由 runner 改名定版的产物（spec §3.3） */
export interface StagedArtifact {
  base: string;
  revision: number;
}

interface StepOk {
  ok: true;
  next: VideoStateRef;
  revisions?: Partial<VideoRevisions>;
  staged?: StagedArtifact[];
  /** cut 阶段顺带出的门内预览指针（v2 spec §4.1）；由 runner 在同一次 CAS 里落盘 */
  preview?: VideoPreviewState;
}

export type StepResult =
  | StepOk
  /** 跑完了但结果没产出：状态照常推进到人工门，warning 落进产物与台账供 UI 显示 */
  | (StepOk & { warning: string })
  | { ok: false; blockedReason?: VideoBlockedReason; errorCode: string; reason: string };

/** 取 warning 变体的那句话；没有就是 undefined（union 的 `in` 收窄只写这一遍） */
export function stepWarning(result: StepResult): string | undefined {
  return result.ok && "warning" in result ? result.warning : undefined;
}

export interface PhaseContext {
  dataDir: string;
  contentId: string;
  /** 认领后的状态（revisions 以它为准算下一版） */
  state: VideoState;
  deps?: VideoDeps;
  renderDir?: string;
  /** 本次 job 的 id：staging 产物按它命名，同一条 job 重跑覆盖自己的半成品 */
  jobId?: string;
  /** 停机信号：温柔杀掉正在跑的外部进程 */
  abortSignal: AbortSignal;
  /** 渲染进度回调（runner 拿它续租） */
  onProgress?: () => void;
  /**
   * 阶段内的人话日志（缓存命中之类「没出错但人该知道」的事），由 runner 注入它自己的报错通道。
   * 不是给失败用的——失败一律走 StepResult，这里只说过程。
   */
  report?: (message: string) => void;
}

/** 把子模块的 outcome 翻成 StepResult：blocked 与 failed 是两种命运，不许混 */
function fail(result: { blockedReason?: VideoBlockedReason; errorCode: string; reason: string }): StepResult {
  return {
    ok: false,
    ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
    errorCode: result.errorCode,
    reason: result.reason,
  };
}

async function ingestPhase(ctx: PhaseContext): Promise<StepResult> {
  const result = await ingestAroll(ctx.dataDir, ctx.contentId, ctx.deps);
  if (!result.ok) return fail(result);
  return { ok: true, next: { phase: "transcribe", state: "queued" } };
}

/** 复检 A-roll 指纹——每个 phase 开跑前都做（§4.2），引用不复制的代价就在这儿还 */
async function assertArollFresh(dataDir: string, contentId: string): Promise<StepResult | null> {
  const aroll = (await readVideoAssets(dataDir, contentId)).find((a) => a.kind === "aroll");
  if (!aroll) return { ok: false, errorCode: "aroll_missing", reason: "素材清单里没有 A-roll，请重新走一次导入" };
  const drifted = await driftedAssets(dataDir, contentId, [aroll]);
  if (drifted.length === 0) return null;
  return {
    ok: false,
    blockedReason: "aroll_drifted",
    errorCode: "aroll_drifted",
    reason: `A-roll 与登记时对不上了：\n${drifted.map((d) => `· ${d}`).join("\n")}\n换了文件就重新转写，改回原文件即可继续`,
  };
}

/** transcribe 一次产四件，全部先落 staging、由 runner 在 CAS 之后一起定版（转写纠错 spec §2） */
interface TranscribeRevisions {
  transcript: number;
  clean: number;
  cut: number;
}

/**
 * 首版剪辑决策 = 全 keep（§4.4 V0a）：人打开选段视图看到的是完整的一条，只做减法。
 * 同时落一份 `origin:"raw"` 的兜底单元表——AI 粗剪跑不起来时，消费方照样有 edit-units 可读。
 *
 * 分句取自**清洗后的文字**（§5），所以两件产物都记 `cleanRevision`：一版字幕要能回答
 * 「这些字是哪来的」。
 */
async function stageDefaultCut(
  dir: string,
  jobId: string,
  segments: TranscriptSegment[],
  rev: TranscribeRevisions,
): Promise<void> {
  const cut: VideoCut = {
    transcriptRevision: rev.transcript,
    cleanRevision: rev.clean,
    keeps: segments.map((s) => s.id),
    flags: [],
    origin: "default_all",
  };
  await writeStaging(dir, "cut", jobId, cut);
  const units: VideoEditUnits = {
    schemaVersion: 1,
    transcriptRevision: rev.transcript,
    cleanRevision: rev.clean,
    origin: "raw",
    segments,
    suggestedDrops: [],
    flags: [],
  };
  await writeStaging(dir, "edit-units", jobId, units);
}

/**
 * 拿到这条 A-roll 的 ASR 事实：指纹与参数全对得上就直接用盘上的 `asr-out.json`，
 * 否则抽音轨重跑 sidecar（§2）。「只想换个清洗口径重试一次」不该再等十几分钟推理。
 *
 * **热词表与缓存键必须是同一份**：`runAsr` 的入参与 `asrCacheMeta` 的热词 hash 取自同一个
 * `hotwords` 变量，改一处漏一处就会留下「meta 说是这批热词、内容却是另一批」的缓存——
 * 那种错是静默的，它会让下次重跑拿到一份对不上的转写。
 */
async function resolveAsrFact(
  ctx: PhaseContext,
  dir: string,
  aroll: VideoAssetEntry,
  hotwords: readonly string[],
): Promise<{ transcript: VideoTranscript } | StepResult> {
  const meta = asrCacheMeta(aroll.fingerprint?.quickHash ?? "none", hotwords);
  const cached = await readCachedAsr(dir, meta);
  if (cached) {
    ctx.report?.(`${ctx.contentId} 复用已有 ASR 结果（A-roll 与热词都没变），跳过转写`);
    return { transcript: cached };
  }
  const arollPath = await resolveAssetRef(ctx.dataDir, ctx.contentId, aroll.ref);
  const wav = path.join(dir, "asr-input.wav");
  const extracted = await extractAsrWav(arollPath, wav, ctx.deps);
  if (!extracted.ok) {
    return fail({
      ...(extracted.errorCode === "ffmpeg_missing" ? { blockedReason: "ffmpeg_missing" as const } : {}),
      errorCode: extracted.errorCode,
      reason: extracted.reason,
    });
  }
  // 先作废 → 重算 → 再登记：崩在中间只会退化成下次没命中，不会留下错配的缓存
  await clearAsrCacheMeta(dir);
  const asr = await runAsr(
    {
      audioFile: wav,
      outFile: path.join(dir, ASR_OUT_FILE),
      // 空表不拼 `--hotword`，sidecar 走与今天逐字节一致的老路（asr.ts 的契约）
      ...(hotwords.length > 0 ? { hotwords: [...hotwords] } : {}),
      abortSignal: ctx.abortSignal,
    },
    ctx.deps,
  );
  if (!asr.ok) return fail(asr);
  await writeAsrCacheMeta(dir, meta);
  return { transcript: asr.transcript };
}

/**
 * 清洗（转写纠错 spec §4）：LLM 对着稿子纠同音错认、重新断句，产出派生文字。
 *
 * **body 为空 = 不跑清洗**：清洗认专名全靠稿件正文，没稿子就只剩凭空猜错字，那比不改更糟
 * （热词那侧同理，见 hotwords.ts）。此时 clean 是转写原样复制，段 id 保持 `seg-XXXX`
 * ——复制品不伪装成清洗过的产物（`cseg-` 前缀留给真重分段的那一版）。
 *
 * 清洗降级只落 `TranscriptClean.warning`（选段卡读它，service.getTranscript 单独透传），
 * **不翻成 StepResult 的 warning**：那句话说的是「这一步跑完了但结果没达成」，而清洗降级
 * 时转写这一步是实打实成功的，混在一起会让台账上的失败原因失真。
 */
async function cleanTranscript(
  ctx: PhaseContext,
  transcript: VideoTranscript,
  body: string,
  transcriptRevision: number,
): Promise<TranscriptClean> {
  const base: TranscriptClean = {
    schemaVersion: 1,
    transcriptRevision,
    baseCleanRevision: null,
    origin: "llm",
    segments: transcript.segments,
  };
  // 没稿子就没有纠错的参照——但不能默不作声：面板上「文字 v1」摆着而一个错字没纠，
  // 人会以为清洗跑过了。一句话说清为什么没跑、错字该去哪儿改。
  if (!body) return { ...base, warning: "这条稿件没有正文，AI 清洗与热词都没有运行——错字请在选段列表里点「改字」手工修正" };
  const outcome = await runTranscriptClean(
    { dataDir: ctx.dataDir, segments: transcript.segments, body, abortSignal: ctx.abortSignal },
    ctx.deps,
  );
  if (outcome.warning) ctx.report?.(`${ctx.contentId} 的转写清洗有降级：${outcome.warning}`);
  return { ...base, segments: outcome.segments, ...(outcome.warning ? { warning: outcome.warning } : {}) };
}

async function transcribePhase(ctx: PhaseContext): Promise<StepResult> {
  const { dataDir, contentId } = ctx;
  const stale = await assertArollFresh(dataDir, contentId);
  if (stale) return stale;
  if (!ctx.jobId) return { ok: false, errorCode: "missing_job", reason: "transcribe 阶段缺 jobId，产物无处落 staging" };
  const dir = videoDir(dataDir, contentId);
  const aroll = (await readVideoAssets(dataDir, contentId)).find((a) => a.kind === "aroll")!;

  // 稿件正文是转写这一步的第二份输入（§2）：热词从它抽、清洗对着它纠错，所以先读它
  const body = (await getContent(contentId, dataDir))?.body ?? "";
  const fact = await resolveAsrFact(ctx, dir, aroll, extractHotwords(body));
  if ("ok" in fact) return fact;

  // 与口播稿的对齐度只在这里算一次并钉进不可变产物：V0b 的 LLM 建议权按它判定（§4.4）
  const transcript: VideoTranscript = body
    ? { ...fact.transcript, scriptAlignment: { matchedRatio: scriptMatchRatio(fact.transcript, body) } }
    : fact.transcript;

  const rev: TranscribeRevisions = {
    transcript: (ctx.state.revisions.transcript ?? 0) + 1,
    clean: (ctx.state.revisions.clean ?? 0) + 1,
    cut: (ctx.state.revisions.cut ?? 0) + 1,
  };
  const clean = await cleanTranscript(ctx, transcript, body, rev.transcript);
  await writeStaging(dir, "transcript", ctx.jobId, transcript);
  await writeStaging(dir, "transcript-clean", ctx.jobId, clean);
  await stageDefaultCut(dir, ctx.jobId, clean.segments, rev);
  return {
    ok: true,
    // 人工门仍是 cut/awaiting_human，这里只是把门前那道计算（AI 粗剪）排上队
    next: { phase: "cut", state: "queued" },
    revisions: { transcript: rev.transcript, clean: rev.clean, cut: rev.cut },
    // 四件一起定版（§2）：早先直写正式版本，崩在 CAS 之前的话恢复重算同号会撞
    // 「版本化产物不可覆盖」，这条 content 就永久卡死在转写这一步
    staged: [
      { base: "transcript", revision: rev.transcript },
      { base: "transcript-clean", revision: rev.clean },
      { base: "edit-units", revision: rev.cut },
      { base: "cut", revision: rev.cut },
    ],
  };
}

/** cut 的出口只有一个：人工门。AI 跑成什么样都停在这儿，由人终裁 */
const HUMAN_GATE: VideoStateRef = { phase: "cut", state: "awaiting_human" };

/**
 * AI 粗剪（粗剪 spec §2/§3）。**只提议不决定**：产出重分后的剪辑单元与建议剔除清单，
 * 人在 `cut/awaiting_human` 门上终裁。跑不起来一律降级成全留版 + warning，绝不 failed/blocked
 * ——V0b 的失败不许让已经可用的 V0a 人工路径变成不可用。
 */
async function cutPhase(ctx: PhaseContext): Promise<StepResult> {
  const { dataDir, contentId } = ctx;
  const dir = videoDir(dataDir, contentId);
  const transcriptRevision = ctx.state.revisions.transcript ?? 0;
  const cleanRevision = ctx.state.revisions.clean;
  const baseCutRevision = ctx.state.revisions.cut ?? 0;
  // 粗剪切的是**有效文字**（§5）：清洗纠过的字才是人在门上会看到的那些字
  const transcript = await readEffectiveTranscript(dir, { transcript: transcriptRevision, clean: cleanRevision });
  if (!transcript) {
    return { ok: false, errorCode: "missing_input", reason: `读不到 transcript.v${transcriptRevision}，请重跑转写` };
  }
  if (!ctx.jobId) return { ok: false, errorCode: "missing_job", reason: "cut 阶段缺 jobId，产物无处落 staging" };
  const base = await readVersioned<VideoCut>(dir, "cut", baseCutRevision);
  if (base?.origin === "human") {
    // §7 #10：人已经交过终裁，迟到的后台建议一律不许覆盖。预览照出——门上没片可看才是最糟的
    return {
      ok: true,
      next: HUMAN_GATE,
      preview: await renderGatePreview(ctx, {
        keeps: base.keeps,
        transcriptRevision,
        cutRevision: baseCutRevision,
        ...(cleanRevision ? { cleanRevision } : {}),
      }),
      warning: "这一版选段已由人工确认，AI 粗剪建议不再覆盖",
    };
  }

  const ratio = transcript.scriptAlignment?.matchedRatio;
  const outcome = await runRoughCut(
    {
      dataDir,
      segments: transcript.segments,
      body: (await getContent(contentId, dataDir))?.body ?? "",
      ...(typeof ratio === "number" ? { scriptCoverage: ratio } : {}),
      abortSignal: ctx.abortSignal,
    },
    ctx.deps,
  );

  const cutRevision = baseCutRevision + 1;
  const staged = await stageCutArtifacts(dir, ctx.jobId, {
    outcome,
    transcriptRevision,
    baseCutRevision,
    ...(cleanRevision ? { cleanRevision } : {}),
  });
  return {
    ok: true,
    next: HUMAN_GATE,
    revisions: { cut: cutRevision },
    staged: [
      { base: "edit-units", revision: cutRevision },
      { base: "cut", revision: cutRevision },
    ],
    // 「粗剪 LLM → 预览渲染」在同一个运行段里顺序做完，人开门时就有片可看（v2 spec §4.1）
    preview: await renderGatePreview(ctx, {
      keeps: staged.keeps,
      transcriptRevision,
      cutRevision,
      ...(cleanRevision ? { cleanRevision } : {}),
      units: { segments: staged.units.segments, origin: staged.units.origin },
    }),
    ...(outcome.warning ? { warning: outcome.warning } : {}),
  };
}

/** keeps = 单元 id 全集减 suggestedDrops（补集由代码算，不由模型给） */
async function stageCutArtifacts(
  dir: string,
  jobId: string,
  input: {
    outcome: Awaited<ReturnType<typeof runRoughCut>>;
    transcriptRevision: number;
    cleanRevision?: number;
    baseCutRevision: number;
  },
): Promise<{ keeps: string[]; units: VideoEditUnits }> {
  const { outcome, transcriptRevision, cleanRevision, baseCutRevision } = input;
  const traced = { transcriptRevision, ...(cleanRevision ? { cleanRevision } : {}) };
  const units: VideoEditUnits = {
    schemaVersion: 1,
    ...traced,
    origin: outcome.origin,
    segments: outcome.units,
    suggestedDrops: outcome.suggestedDrops,
    flags: outcome.flags,
    ...(outcome.provenance ? { provenance: outcome.provenance } : {}),
    ...(outcome.warning ? { warning: outcome.warning } : {}),
  };
  const dropped = new Set(outcome.suggestedDrops);
  const cut: VideoCut = {
    ...traced,
    keeps: outcome.units.filter((u) => !dropped.has(u.id)).map((u) => u.id),
    flags: outcome.flags,
    origin: outcome.origin === "llm" ? "llm" : "default_all",
    baseCutRevision,
  };
  await writeStaging(dir, "edit-units", jobId, units);
  await writeStaging(dir, "cut", jobId, cut);
  return { keeps: cut.keeps, units };
}

/** edit 的出口只有一个：人工门。剪辑师跑成什么样都停在这儿，由人删定（横屏 spec §3.1） */
const EDIT_GATE: VideoStateRef = { phase: "edit", state: "awaiting_human" };

/** 剪辑师看到的是**成片时间轴**：keeps 拼接后的输出域时间，不是 A-roll 源时间 */
function keepUnits(transcript: VideoTranscript, cut: VideoCut): { units: EditorKeepUnit[]; durationMs: number } {
  const map = buildOutputMap(transcript, cut);
  const byId = new Map(transcript.segments.map((s) => [s.id, s]));
  return {
    units: map.map((e) => ({
      id: e.segmentId,
      text: byId.get(e.segmentId)?.text ?? "",
      outputStartMs: e.outputStartMs,
      outputEndMs: e.outputStartMs + (e.sourceEndMs - e.sourceStartMs),
    })),
    durationMs: outputDurationMs(map),
  };
}

/** 读确认后的选段并换算到输出域；读不到就是真失败（不是降级），原样返回 StepResult */
async function loadKeeps(
  ctx: PhaseContext,
  cutRevision: number,
): Promise<{ keeps: { units: EditorKeepUnit[]; durationMs: number } } | StepResult> {
  const dir = videoDir(ctx.dataDir, ctx.contentId);
  const transcriptRevision = ctx.state.revisions.transcript ?? 0;
  const transcript = await readEffectiveTranscript(dir, {
    transcript: transcriptRevision,
    clean: ctx.state.revisions.clean,
  });
  const cut = await readVersioned<VideoCut>(dir, "cut", cutRevision);
  if (!transcript || !cut) {
    return {
      ok: false,
      errorCode: "missing_input",
      reason: `读不到 transcript.v${transcriptRevision} 或 cut.v${cutRevision}，请回选段视图重新确认一次`,
    };
  }
  // 剪辑单位以 edit-units.vK 为准；没有（V0a 老产物）才回落有效转写的分句
  const units = await readEditUnits(dir, cutRevision);
  try {
    return { keeps: keepUnits(units ? { ...transcript, segments: units.segments } : transcript, cut) };
  } catch (err) {
    return { ok: false, errorCode: "cut_invalid", reason: (err as Error).message };
  }
}

function stageEditorPlan(
  dir: string,
  jobId: string,
  input: { outcome: Awaited<ReturnType<typeof runEditor>>; cutRevision: number; excluded: string[] },
): Promise<string> {
  const { outcome, cutRevision, excluded } = input;
  const plan: VideoEditorPlan = {
    schemaVersion: 1,
    cutRevision,
    origin: outcome.origin,
    overlays: outcome.overlays,
    ...(excluded.length > 0 ? { excludedAssets: excluded } : {}),
    ...(outcome.warning ? { warning: outcome.warning } : {}),
    ...(outcome.note ? { note: outcome.note } : {}),
    ...(outcome.provenance ? { provenance: outcome.provenance } : {}),
  };
  return writeStaging(dir, "editor-plan", jobId, plan);
}

/**
 * 剪辑师 agent（横屏 spec §3）。**只提议不决定**：产出 B-roll 编排与强调词，
 * 人在 `edit/awaiting_human` 门上删定。跑不起来一律降级成空 plan + warning，绝不 failed/blocked
 * ——P1 的失败不许让「纯口播成片」这条已经可用的路径变成不可用。
 */
async function editPhase(ctx: PhaseContext): Promise<StepResult> {
  const { dataDir, contentId } = ctx;
  const dir = videoDir(dataDir, contentId);
  const cutRevision = ctx.state.revisions.cut ?? 0;
  const loaded = await loadKeeps(ctx, cutRevision);
  if ("ok" in loaded) return loaded;
  const keeps = loaded.keeps;
  if (!ctx.jobId) return { ok: false, errorCode: "missing_job", reason: "edit 阶段缺 jobId，产物无处落 staging" };

  const content = await getContent(contentId, dataDir);
  // 本稿挂接 + 全库常备合成一份目录；指纹在剪辑师看到素材的这一刻打好，
  // plan 的 asset 快照直接抄它（v2 spec §4.2 / 边界 #12 / lifecycle §1）
  const catalog = await buildBrollCatalog(dataDir, contentId, content?.assets ?? []);
  const outcome = await runEditor(
    {
      dataDir,
      candidates: catalog.candidates,
      units: keeps.units,
      outputDurationMs: keeps.durationMs,
      body: content?.body ?? "",
      assetsDigest: catalog.digest,
      abortSignal: ctx.abortSignal,
    },
    ctx.deps,
  );
  const editorRevision = (ctx.state.revisions.editor ?? 0) + 1;
  await stageEditorPlan(dir, ctx.jobId, { outcome, cutRevision, excluded: catalog.excluded });
  return {
    ok: true,
    next: EDIT_GATE,
    revisions: { editor: editorRevision },
    staged: [{ base: "editor-plan", revision: editorRevision }],
    ...(outcome.warning ? { warning: outcome.warning } : {}),
  };
}

async function assemblePhase(ctx: PhaseContext): Promise<StepResult> {
  const { dataDir, contentId } = ctx;
  const dir = videoDir(dataDir, contentId);
  const transcriptRevision = ctx.state.revisions.transcript ?? 0;
  const cleanRevision = ctx.state.revisions.clean;
  const cutRevision = ctx.state.revisions.cut ?? 0;
  const transcript = await readEffectiveTranscript(dir, { transcript: transcriptRevision, clean: cleanRevision });
  const cut = await readVersioned<VideoCut>(dir, "cut", cutRevision);
  if (!transcript || !cut) {
    return {
      ok: false,
      errorCode: "missing_input",
      reason: `读不到 transcript.v${transcriptRevision} 或 cut.v${cutRevision}，产物可能被删了`,
    };
  }
  if (!ctx.jobId) return { ok: false, errorCode: "missing_job", reason: "assemble 阶段缺 jobId，产物无处落 staging" };
  // 覆盖轨的唯一来源是**确认产物**（lifecycle §2.1）：读不到就是「这一版计划没被确认过」，
  // 绝不当成「没有覆盖轨」往下走——那正是旧 overlay 静默复活的入口
  const decided = await loadConfirmedOverlays(ctx.dataDir, ctx.contentId, {
    confirmedEditorRevision: ctx.state.confirmedEditorRevision,
    cutRevision,
  });
  if (!decided.ok) return fail(decided);

  const timelineRevision = (ctx.state.revisions.timeline ?? 0) + 1;
  // 剪辑单位以 edit-units.vK 为准；没有（V0a 老产物）才回落有效转写的分句（§4）
  const units = await readEditUnits(dir, cutRevision);
  const result = await assembleVideo(
    {
      dataDir,
      contentId,
      transcript: units ? { ...transcript, segments: units.segments } : transcript,
      transcriptRevision,
      ...(cleanRevision ? { cleanRevision } : {}),
      cut,
      cutRevision,
      timelineRevision,
      slots: decided.overlays,
      jobId: ctx.jobId,
      // cue 口径跟着剪辑单元来源走；老产物没有单元表就按 raw 回落（边界 #9）
      unitsOrigin: units?.origin ?? "raw",
    },
    ctx.deps,
  );
  if (!result.ok) return fail(result);
  return {
    ok: true,
    next: { phase: "render", state: "queued" },
    revisions: { timeline: timelineRevision },
    // timeline 与 manifest 一起定版：中途失败不会留下一个占着号的半成品（lifecycle §2.1）
    staged: ASSEMBLE_STAGED_BASES.map((base) => ({ base, revision: timelineRevision })),
    // BGM 被降级掉时这句话必须冒到面板上——不静默降级（横屏 spec §2.4）
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

async function renderPhase(ctx: PhaseContext): Promise<StepResult> {
  const { dataDir, contentId } = ctx;
  const dir = videoDir(dataDir, contentId);
  const timelineRevision = ctx.state.revisions.timeline ?? 0;
  const manifest = await readVersioned<RenderManifest>(dir, "render-manifest", timelineRevision);
  if (!manifest) {
    return { ok: false, errorCode: "missing_manifest", reason: `读不到 render-manifest.v${timelineRevision}，请重新组装` };
  }
  const result = await runRenderJob(
    {
      dataDir,
      contentId,
      manifestFile: path.join(dir, `render-manifest.v${timelineRevision}.json`),
      timelineRevision,
      durationMs: manifest.durationMs,
      ...(ctx.renderDir ? { renderDir: ctx.renderDir } : {}),
      ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
      abortSignal: ctx.abortSignal,
    },
    ctx.deps,
  );
  if (!result.ok) return fail(result);
  return { ok: true, next: { phase: "review", state: "awaiting_human" }, revisions: { rendered: timelineRevision } };
}

/** 这六个阶段会真的跑东西；review 是纯人工门，done 是终点 */
export function executePhase(ctx: PhaseContext): Promise<StepResult> {
  switch (ctx.state.phase) {
    case "ingest":
      return ingestPhase(ctx);
    case "transcribe":
      return transcribePhase(ctx);
    case "cut":
      return cutPhase(ctx);
    case "edit":
      return editPhase(ctx);
    case "assemble":
      return assemblePhase(ctx);
    case "render":
      return renderPhase(ctx);
    default:
      return Promise.resolve({
        ok: false,
        errorCode: "not_runnable",
        reason: `阶段 ${ctx.state.phase} 不是可执行阶段（review 等人、done 已收尾）`,
      });
  }
}
