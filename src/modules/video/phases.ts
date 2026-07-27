/**
 * 各阶段「干什么」（设计 spec §4.2 / §4.3 / §5 / §6）。
 *
 * 与 runner 的分工：runner 管**调度与事务**（认领、心跳、CAS、回收），这里只管
 * **一步之内做完什么事、产出什么 revision、失败算 blocked 还是 failed**。
 * 所以本文件里没有一处写 state.json——推进状态是 runner 的独占权力。
 *
 * 每个阶段都返回同一个 `StepResult`：成功给下一格状态与新 revision，
 * 失败给 errorCode + 中文原因（blocked 另带 blockedReason）。**没有第三种出口**，
 * 静默降级在这一层就被形状挡住了。
 */
import path from "node:path";
import { getContent } from "../../storage/local-store.js";
import { assembleVideo, driftedAssets, readOverlaySlots } from "./assemble.js";
import { extractAsrWav, runAsr, scriptMatchRatio } from "./asr.js";
import { ingestAroll } from "./ingest.js";
import type { VideoDeps } from "./proc.js";
import { runRenderJob } from "./render-exec.js";
import type { VideoStateRef } from "./state-machine.js";
import { readVersioned, readVideoAssets, resolveAssetRef, videoDir, writeVersioned } from "./video-store.js";
import type {
  RenderManifest,
  VideoBlockedReason,
  VideoCut,
  VideoRevisions,
  VideoState,
  VideoTranscript,
} from "./types.js";

export type StepResult =
  | { ok: true; next: VideoStateRef; revisions?: Partial<VideoRevisions> }
  | { ok: false; blockedReason?: VideoBlockedReason; errorCode: string; reason: string };

export interface PhaseContext {
  dataDir: string;
  contentId: string;
  /** 认领后的状态（revisions 以它为准算下一版） */
  state: VideoState;
  deps?: VideoDeps;
  renderDir?: string;
  /** 停机信号：温柔杀掉正在跑的外部进程 */
  abortSignal: AbortSignal;
  /** 渲染进度回调（runner 拿它续租） */
  onProgress?: () => void;
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

async function transcribePhase(ctx: PhaseContext): Promise<StepResult> {
  const { dataDir, contentId } = ctx;
  const stale = await assertArollFresh(dataDir, contentId);
  if (stale) return stale;
  const dir = videoDir(dataDir, contentId);
  const aroll = (await readVideoAssets(dataDir, contentId)).find((a) => a.kind === "aroll")!;
  const arollPath = await resolveAssetRef(dataDir, contentId, aroll.ref);

  const wav = path.join(dir, "asr-input.wav");
  const extracted = await extractAsrWav(arollPath, wav, ctx.deps);
  if (!extracted.ok) {
    return fail({
      ...(extracted.errorCode === "ffmpeg_missing" ? { blockedReason: "ffmpeg_missing" as const } : {}),
      errorCode: extracted.errorCode,
      reason: extracted.reason,
    });
  }
  const asr = await runAsr(
    { audioFile: wav, outFile: path.join(dir, "asr-out.json"), abortSignal: ctx.abortSignal },
    ctx.deps,
  );
  if (!asr.ok) return fail(asr);

  const transcriptRevision = (ctx.state.revisions.transcript ?? 0) + 1;
  // 与口播稿的对齐度只在这里算一次并钉进不可变产物：V0b 的 LLM 建议权按它判定（§4.4）
  const body = (await getContent(contentId, dataDir))?.body ?? "";
  const transcript: VideoTranscript = body
    ? { ...asr.transcript, scriptAlignment: { matchedRatio: scriptMatchRatio(asr.transcript, body) } }
    : asr.transcript;
  await writeVersioned(dir, "transcript", transcriptRevision, transcript);
  // 首版剪辑决策 = 全 keep（§4.4 V0a）：人打开选段视图看到的是完整的一条，只做减法
  const cutRevision = (ctx.state.revisions.cut ?? 0) + 1;
  const cut: VideoCut = {
    transcriptRevision,
    keeps: transcript.segments.map((s) => s.id),
    flags: [],
    origin: "default_all",
  };
  await writeVersioned(dir, "cut", cutRevision, cut);
  return {
    ok: true,
    next: { phase: "cut", state: "awaiting_human" },
    revisions: { transcript: transcriptRevision, cut: cutRevision },
  };
}

async function assemblePhase(ctx: PhaseContext): Promise<StepResult> {
  const { dataDir, contentId } = ctx;
  const dir = videoDir(dataDir, contentId);
  const transcriptRevision = ctx.state.revisions.transcript ?? 0;
  const cutRevision = ctx.state.revisions.cut ?? 0;
  const transcript = await readVersioned<VideoTranscript>(dir, "transcript", transcriptRevision);
  const cut = await readVersioned<VideoCut>(dir, "cut", cutRevision);
  if (!transcript || !cut) {
    return {
      ok: false,
      errorCode: "missing_input",
      reason: `读不到 transcript.v${transcriptRevision} 或 cut.v${cutRevision}，产物可能被删了`,
    };
  }
  const timelineRevision = (ctx.state.revisions.timeline ?? 0) + 1;
  const result = await assembleVideo(
    {
      dataDir,
      contentId,
      transcript,
      transcriptRevision,
      cut,
      cutRevision,
      timelineRevision,
      slots: await readOverlaySlots(dataDir, contentId, cutRevision),
    },
    ctx.deps,
  );
  if (!result.ok) return fail(result);
  return { ok: true, next: { phase: "render", state: "queued" }, revisions: { timeline: timelineRevision } };
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

/** 只有这四个阶段会真的跑东西；cut/review 是人工门，done 是终点 */
export function executePhase(ctx: PhaseContext): Promise<StepResult> {
  switch (ctx.state.phase) {
    case "ingest":
      return ingestPhase(ctx);
    case "transcribe":
      return transcribePhase(ctx);
    case "assemble":
      return assemblePhase(ctx);
    case "render":
      return renderPhase(ctx);
    default:
      return Promise.resolve({
        ok: false,
        errorCode: "not_runnable",
        reason: `阶段 ${ctx.state.phase} 不是可执行阶段（cut/review 等人、done 已收尾）`,
      });
  }
}
