/**
 * 粗剪门内的低规格预览（v2 spec §4.1）。
 *
 * 它**不是成片**，所以刻意不复用 `runRenderJob`：那条链路断言全规格 1920×1080 并把产物
 * 登记成稿件 asset，预览两件都不该做——预览文件绝不冒充成片（§1 不变量）。
 *
 * 事务边界与成片同款、规格不同：
 *   写 `preview.v<P>.tmp.mp4` → ffprobe 断言（h264 / 960×540 / 30fps / 有音轨 / 时长）
 *   → rename 就位 → 删掉更老的预览文件（只留最新）。
 * 半截 mp4 因此永远不会被媒体端点读到（边界 #5），预览也不会堆满磁盘（边界 #6）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { buildAnchorWav, driftedAssets, loadIdentity } from "./assemble.js";
import { buildCaptionCues } from "./captions.js";
import { probeMedia } from "./ingest.js";
import { buildRenderManifest } from "./manifest-build.js";
import { buildOutputMap, outputDurationMs } from "./output-map.js";
import { REPO_ROOT, runProcess, stderrTail, type VideoDeps } from "./proc.js";
import { DURATION_TOLERANCE_MS, RENDER_DIR } from "./render-exec.js";
import { OUTPUT_FPS } from "./timeline-build.js";
import {
  latestRevision,
  readEditUnits,
  readVersioned,
  readVideoAssets,
  resolveAssetRef,
  videoDir,
  writeVersioned,
} from "./video-store.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import type { VideoEditUnits, VideoPreviewRequest, VideoPreviewState, VideoTranscript } from "./types.js";

/** 预览画幅：manifest 仍是 1920×1080 契约，靠 Remotion `scale: 0.5` 输出这个尺寸 */
export const PREVIEW_WIDTH = 960;
export const PREVIEW_HEIGHT = 540;

/** 改预览口径就升它——它进不可变请求，旧预览因此不会被当成新预览复用 */
export const PREVIEW_ALGO_VERSION = "pv-1";

/** 预览是给人看一眼的，卡 15 分钟就是出问题了（成片那条是 2 小时） */
export const PREVIEW_TIMEOUT_MS = 15 * 60_000;

export function previewVideoPath(dataDir: string, contentId: string, revision: number): string {
  return path.join(videoDir(dataDir, contentId), `preview.v${revision}.mp4`);
}

/**
 * 落一份不可变的预览请求，返回它的版本 P。
 *
 * P 按**盘上已有的最大号 +1** 分配而不是按 state 里的计数：崩在「写完请求、还没更新
 * 状态」之间时，按 state 重算会撞上已存在的文件，把这条 content 永久钉死。
 */
export async function writePreviewRequest(
  dataDir: string,
  contentId: string,
  req: { keeps: string[]; baseCutRevision: number; baseTranscriptRevision: number },
): Promise<number> {
  const dir = videoDir(dataDir, contentId);
  const revision = ((await latestRevision(dir, "cut-preview-request")) ?? 0) + 1;
  const payload: VideoPreviewRequest = { schemaVersion: 1, ...req, renderAlgoVersion: PREVIEW_ALGO_VERSION };
  await writeVersioned(dir, "cut-preview-request", revision, payload);
  return revision;
}

export interface PreviewExecInput {
  dataDir: string;
  contentId: string;
  /** 预览请求版本 P；产物一律按它命名 */
  revision: number;
  keeps: string[];
  transcriptRevision: number;
  cutRevision: number;
  /**
   * 剪辑单元覆盖。cut job 尾接的那次预览跑在 staging 还没定版的时刻，
   * 盘上读不到 `edit-units.v<cutRevision>`——不传进来就会拿 keeps 去 transcript 里找不存在的 id。
   */
  units?: Pick<VideoEditUnits, "segments" | "origin">;
  renderDir?: string;
  onProgress?: () => void;
  abortSignal?: AbortSignal;
}

export type PreviewOutcome =
  | { ok: true; file: string; durationMs: number }
  | { ok: false; errorCode: string; reason: string };

interface PreviewSource {
  transcript: VideoTranscript;
  units: Pick<VideoEditUnits, "segments" | "origin"> | null;
  arollFile: string;
}

/** 读齐预览要的三样：转写事实、剪辑单元（决定 cue 口径）、A-roll 文件 */
async function loadSource(input: PreviewExecInput): Promise<PreviewSource | PreviewOutcome> {
  const { dataDir, contentId } = input;
  const dir = videoDir(dataDir, contentId);
  const transcript = await readVersioned<VideoTranscript>(dir, "transcript", input.transcriptRevision);
  if (!transcript) {
    return { ok: false, errorCode: "missing_input", reason: `读不到 transcript.v${input.transcriptRevision}` };
  }
  const aroll = (await readVideoAssets(dataDir, contentId)).find((a) => a.kind === "aroll");
  if (!aroll) return { ok: false, errorCode: "aroll_missing", reason: "素材清单里没有 A-roll，请重新走一次导入" };
  const drifted = await driftedAssets(dataDir, contentId, [aroll]);
  if (drifted.length > 0) {
    return { ok: false, errorCode: "aroll_drifted", reason: `A-roll 与登记时对不上了：${drifted.join("；")}` };
  }
  return {
    transcript,
    units: input.units ?? (await readEditUnits(dir, input.cutRevision)),
    arollFile: await resolveAssetRef(dataDir, contentId, aroll.ref),
  };
}

/** 预览验收：规格错的预览会让人对着 540p 的假象做决定，必须当场拦下 */
async function assertPreview(file: string, durationMs: number, deps?: VideoDeps): Promise<string[]> {
  const probed = await probeMedia(file, deps);
  if (!probed.ok) return [probed.reason];
  const { probe } = probed;
  const problems: string[] = [];
  if (!probe.video) problems.push("预览里没有画面轨");
  else {
    if (probe.video.codec !== "h264") problems.push(`视频编码是 ${probe.video.codec}，应为 h264`);
    if (probe.video.width !== PREVIEW_WIDTH || probe.video.height !== PREVIEW_HEIGHT) {
      problems.push(`分辨率是 ${probe.video.width}×${probe.video.height}，应为 ${PREVIEW_WIDTH}×${PREVIEW_HEIGHT}`);
    }
    if (Math.abs(probe.video.fps - OUTPUT_FPS) > 0.05) {
      problems.push(`帧率是 ${probe.video.fps.toFixed(2)}fps，应为 ${OUTPUT_FPS}fps`);
    }
  }
  if (!probe.audio) problems.push("预览里没有音轨");
  const drift = Math.abs(probe.durationMs - durationMs);
  if (drift > DURATION_TOLERANCE_MS) {
    problems.push(`时长 ${probe.durationMs}ms 与选段总长 ${durationMs}ms 相差 ${drift}ms`);
  }
  return problems;
}

const PREVIEW_ARTIFACT_RE = /^preview(?:-anchor|-manifest)?\.v(\d+)\.(?:mp4|wav|json)$/;

/** 只留最新：更老的预览 mp4 与它们的中间产物一并删掉（边界 #6） */
async function prunePreviews(dir: string, keepRevision: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = PREVIEW_ARTIFACT_RE.exec(name);
    if (m && Number(m[1]) !== keepRevision) await fs.rm(path.join(dir, name), { force: true });
  }
}

/**
 * 删掉某一版预览的全部产物（lifecycle spec §3.3）。
 *
 * superseded 的预览 settle 时**主动删自己的输出**：unlink 只防「正在读的人被拽掉文件」，
 * 不防「清理跑完之后一次迟到的 rename 把预览又变出来」。谁产出的谁负责收走。
 */
export async function removePreviewOutputs(dataDir: string, contentId: string, revision: number): Promise<void> {
  const dir = videoDir(dataDir, contentId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = PREVIEW_ARTIFACT_RE.exec(name);
    const tmp = name === `preview.v${revision}.tmp.mp4`;
    if (tmp || (m && Number(m[1]) === revision)) await fs.rm(path.join(dir, name), { force: true });
  }
}

/** 建 manifest 并落盘。它是请求的派生物（请求本身才是审计凭证），所以可覆盖重写 */
async function stagePreviewManifest(
  input: PreviewExecInput,
  src: PreviewSource,
): Promise<{ file: string; durationMs: number } | PreviewOutcome> {
  const dir = videoDir(input.dataDir, input.contentId);
  const transcript = src.units ? { ...src.transcript, segments: src.units.segments } : src.transcript;
  let map;
  try {
    map = buildOutputMap(transcript, { transcriptRevision: input.transcriptRevision, keeps: input.keeps, flags: [], origin: "human" });
  } catch (err) {
    return { ok: false, errorCode: "cut_invalid", reason: (err as Error).message };
  }
  const durationMs = outputDurationMs(map);
  if (durationMs <= 0) {
    return { ok: false, errorCode: "empty_cut", reason: "这一版勾选没有任何有时长的句子，预览是空的——勾几句再看" };
  }
  const anchor = await buildAnchorWav(src.arollFile, map, path.join(dir, `preview-anchor.v${input.revision}.wav`));
  if (!anchor.ok) return { ok: false, errorCode: anchor.errorCode, reason: anchor.reason };
  // 预览 = 无 overlay、无 BGM、无标题卡，但有 anchor 音轨与字幕 cues（v2 spec §4.1）
  const manifest = buildRenderManifest({
    contentId: input.contentId,
    timelineRevision: input.revision,
    cutRevision: input.cutRevision,
    transcriptRevision: input.transcriptRevision,
    durationMs,
    map,
    arollFile: src.arollFile,
    audio: { file: anchor.file, durationMs: anchor.durationMs },
    cues: buildCaptionCues({ transcript, map, origin: src.units?.origin ?? "raw" }),
    identity: await loadIdentity(input.dataDir),
  });
  const file = path.join(dir, `preview-manifest.v${input.revision}.json`);
  await writeJsonAtomic(file, manifest);
  return { file, durationMs };
}

/** 跑一次门内预览。永不抛：每种失败都翻成人话，门照常可确认（边界 #1） */
export async function runPreviewJob(input: PreviewExecInput, deps?: VideoDeps): Promise<PreviewOutcome> {
  const src = await loadSource(input);
  if ("ok" in src) return src;
  const staged = await stagePreviewManifest(input, src);
  if ("ok" in staged) return staged;

  const dir = videoDir(input.dataDir, input.contentId);
  const out = previewVideoPath(input.dataDir, input.contentId, input.revision);
  const tmp = path.join(dir, `preview.v${input.revision}.tmp.mp4`);
  await fs.rm(tmp, { force: true });

  const renderDir = input.renderDir ?? RENDER_DIR;
  const result = await runProcess({
    command: "npm",
    args: ["--prefix", renderDir, "run", "render", "--", "--manifest", staged.file, "--out", tmp, "--profile", "preview"],
    cwd: REPO_ROOT,
    timeoutMs: PREVIEW_TIMEOUT_MS,
    onStdoutLine: () => input.onProgress?.(),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(deps?.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
  });
  if (result.spawnError) {
    return { ok: false, errorCode: "npm_missing", reason: `起不来渲染进程：${result.spawnError}` };
  }
  if (result.code !== 0) {
    await fs.rm(tmp, { force: true });
    const why = result.timedOut ? "预览渲染超时已终止" : `预览渲染退出码 ${String(result.code)}`;
    return { ok: false, errorCode: result.timedOut ? "preview_timeout" : "preview_failed", reason: `${why}：\n${stderrTail(result.stderr, 8) || "无输出"}` };
  }
  const problems = await assertPreview(tmp, staged.durationMs, deps);
  if (problems.length > 0) {
    await fs.rm(tmp, { force: true });
    return { ok: false, errorCode: "preview_assert_failed", reason: `预览渲染完了但规格不对：\n${problems.map((p) => `· ${p}`).join("\n")}` };
  }
  await fs.rename(tmp, out);
  await prunePreviews(dir, input.revision);
  return { ok: true, file: out, durationMs: staged.durationMs };
}

/**
 * cut 阶段调它的那点上下文。**按结构声明而不是 import PhaseContext**：
 * phases 已经依赖本文件，反向 import 会绕成环。
 */
export interface GatePreviewContext {
  dataDir: string;
  contentId: string;
  renderDir?: string;
  onProgress?: () => void;
  abortSignal: AbortSignal;
  deps?: VideoDeps;
}

/**
 * 门内预览：出不来也**只降级不失败**（边界 #1）——门照常打开、列表照常可确认，
 * 失败原因写进 `preview.error` 由面板出横幅。预览是看片辅助，不是出片前置条件。
 */
export async function renderGatePreview(
  ctx: GatePreviewContext,
  input: {
    keeps: string[];
    transcriptRevision: number;
    cutRevision: number;
    units?: Pick<VideoEditUnits, "segments" | "origin">;
  },
): Promise<VideoPreviewState> {
  let revision: number;
  try {
    revision = await writePreviewRequest(ctx.dataDir, ctx.contentId, {
      keeps: input.keeps,
      baseCutRevision: input.cutRevision,
      baseTranscriptRevision: input.transcriptRevision,
    });
  } catch (err) {
    return { requestedRevision: 0, error: `预览请求没落盘：${(err as Error).message}` };
  }
  const result = await runPreviewJob(
    {
      dataDir: ctx.dataDir,
      contentId: ctx.contentId,
      revision,
      ...input,
      ...(ctx.renderDir ? { renderDir: ctx.renderDir } : {}),
      ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
      abortSignal: ctx.abortSignal,
    },
    ctx.deps,
  );
  return result.ok
    ? { requestedRevision: revision, readyRevision: revision }
    : { requestedRevision: revision, error: result.reason };
}
