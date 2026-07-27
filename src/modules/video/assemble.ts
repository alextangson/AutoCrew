/**
 * Assemble：确定性组装 + 冻结（设计 spec §2.4 / §2.5 / §2.8 / §5）。
 *
 * V0a 这一层**没有 LLM**：timeline 由 transcript + cut + 人工指定的覆盖轨槽位算出来，
 * 同样的输入永远得到同样的 timeline。智能层（LLM 建议 / LLM 组装）是 V0b 的事。
 *
 * 四个不可省的动作，顺序即语义：
 * 1. `buildOutputMap` 把源时间域换成输出时间域——timeline 一律工作在输出域（§2.4）。
 * 2. `validateTimeline` 把关，不合法当场失败（V0b 起这里是 LLM 自纠的入口）。
 * 3. **anchor wav**：按 keep 段抽 A-roll 音轨 → `loudnorm` 双 pass 到 -14 LUFS。
 *    单 pass 的动态归一会随内容忽大忽小，双 pass（先测量再按测量值线性归一）才稳定。
 * 4. **冻结 render-manifest**：render 只吃这份 manifest，绝不回头读 timeline（§2.8）。
 *    冻结前复检全部素材指纹——A-roll 是引用不是拷贝，这是最后一次能发现它被换掉的机会。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { readJson } from "../../storage/json-atomic.js";
import { verifyFingerprint, fingerprintFile } from "./fingerprint.js";
import { probeMedia } from "./ingest.js";
import { upsertVideoAsset } from "./ingest.js";
import { buildOutputMap, outputDurationMs, projectWordsToOutput } from "./output-map.js";
import { runProcess, stderrTail, type VideoDeps } from "./proc.js";
import { TIMELINE_REGISTRY, validateTimeline } from "./timeline-validate.js";
import {
  readVersioned,
  readVideoAssets,
  resolveAssetRef,
  videoDir,
  writeVersioned,
} from "./video-store.js";
import type {
  AssetRef,
  OutputMapEntry,
  OverlayFit,
  RenderManifest,
  RenderManifestIdentity,
  RenderManifestOverlay,
  TimelineOverlay,
  VideoAssetEntry,
  VideoCut,
  VideoTimeline,
  VideoTranscript,
} from "./types.js";

/** 主音轨响度目标（§5，常量不可调——每条片子响度一致才是「一个频道」） */
export const LOUDNESS_TARGET_I = -14;
const LOUDNORM_BASE = `I=${LOUDNESS_TARGET_I}:TP=-1.5:LRA=11`;

/** V0 只出竖屏 1080×1920@30（§10「竖屏以外画幅」不做） */
export const OUTPUT_FPS = 30;
export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;

/** V0a 覆盖轨只有人工指定的屏录/图片；转场恒 cut——fade 在 registry 里，留给 V0b 的 LLM 用 */
export const DEFAULT_TRANSITION = "cut";

export const DEFAULT_IDENTITY: RenderManifestIdentity = {
  captionTheme: { fontFamily: "PingFang SC", primaryColor: "#FFFFFF", emphasisColor: "#FFD54A" },
};

/** 人工在选段视图上指定的覆盖轨槽位（与 cut 同版本存盘：它也是剪辑决策的一部分） */
export interface OverlaySlot {
  kind: "screen" | "image";
  ref: AssetRef;
  outputStartMs: number;
  durationMs: number;
  fit?: OverlayFit;
}

export function writeOverlaySlots(
  dataDir: string,
  contentId: string,
  cutRevision: number,
  slots: OverlaySlot[],
): Promise<string> {
  return writeVersioned(videoDir(dataDir, contentId), "overlays", cutRevision, slots);
}

/** 没写过覆盖轨 = 没有覆盖轨，不是错误 */
export async function readOverlaySlots(
  dataDir: string,
  contentId: string,
  cutRevision: number,
): Promise<OverlaySlot[]> {
  const slots = await readVersioned<OverlaySlot[]>(videoDir(dataDir, contentId), "overlays", cutRevision);
  return Array.isArray(slots) ? slots : [];
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

export interface DeterministicTimelineInput {
  transcriptRevision: number;
  cutRevision: number;
  /** 已登记进素材清单的覆盖轨（assetId 由 registerOverlayAssets 产出） */
  overlays: { assetId: string; slot: OverlaySlot }[];
}

/**
 * V0a 的 timeline 形状是固定的：底轨全程 A-roll + 逐词字幕 + 0-N 个人工覆盖轨，无标题卡。
 * 「没有标题卡」是 V0a 的显式选择——标题卡的文案得有人写，V0a 不引入这个人工门。
 */
export function buildDeterministicTimeline(input: DeterministicTimelineInput): VideoTimeline {
  const overlays: TimelineOverlay[] = input.overlays.map(({ assetId, slot }, i) => ({
    clipId: `clip-${String(i + 1).padStart(2, "0")}`,
    outputStartMs: slot.outputStartMs,
    durationMs: slot.durationMs,
    source:
      slot.kind === "screen"
        ? { type: "screen", assetId, ...(slot.fit ? { fit: slot.fit } : {}) }
        : { type: "image", assetId },
    transition: DEFAULT_TRANSITION,
  }));
  return {
    schemaVersion: 1,
    fps: OUTPUT_FPS,
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    anchor: { kind: "aroll", transcriptRevision: input.transcriptRevision, cutRevision: input.cutRevision },
    base: { type: "aroll" },
    overlays,
    captions: { style: "word-highlight" },
    audio: { anchorGainDb: 0 },
  };
}

// ---------------------------------------------------------------------------
// anchor wav（loudnorm 双 pass）
// ---------------------------------------------------------------------------

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/** keep 段 atrim → concat → loudnorm。单段时省掉 concat（`concat=n=1` 纯属噪音） */
function anchorFilter(map: OutputMapEntry[], loudnorm: string): string {
  const trim = (e: OutputMapEntry): string =>
    `atrim=start=${seconds(e.sourceStartMs)}:end=${seconds(e.sourceEndMs)},asetpts=PTS-STARTPTS`;
  if (map.length === 1) return `[0:a]${trim(map[0])},loudnorm=${loudnorm}[out]`;
  const parts = map.map((e, i) => `[0:a]${trim(e)}[a${i}]`);
  const labels = map.map((_, i) => `[a${i}]`).join("");
  return `${parts.join(";")};${labels}concat=n=${map.length}:v=0:a=1,loudnorm=${loudnorm}[out]`;
}

interface LoudnormMeasured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** loudnorm 的 JSON 报文混在 stderr 的日志里，取最后一个含 input_i 的对象 */
function parseLoudnorm(stderr: string): LoudnormMeasured | null {
  const matches = stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/g);
  if (!matches?.length) return null;
  try {
    const parsed = JSON.parse(matches[matches.length - 1]) as LoudnormMeasured;
    const nums = [parsed.input_i, parsed.input_tp, parsed.input_lra, parsed.input_thresh, parsed.target_offset];
    return nums.every((v) => Number.isFinite(Number(v))) ? parsed : null;
  } catch {
    return null;
  }
}

export type AnchorOutcome =
  | { ok: true; file: string; durationMs: number }
  | { ok: false; errorCode: string; reason: string };

async function ffmpeg(args: string[], deps?: VideoDeps): Promise<{ code: number | null; stderr: string; spawnError?: string }> {
  const result = await runProcess({
    command: "ffmpeg",
    args: ["-hide_banner", "-nostdin", ...args],
    timeoutMs: 30 * 60_000,
    ...(deps?.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
  });
  return { code: result.code, stderr: result.stderr, ...(result.spawnError ? { spawnError: result.spawnError } : {}) };
}

/**
 * 抽 keep 段音轨 → 双 pass 归一到 -14 LUFS → `video/anchor.v<cutRevision>.wav`。
 *
 * anchor 是 (A-roll, cut) 的纯函数产物，不是审计凭证——同一版 cut 重跑直接覆盖，
 * 不像 timeline/manifest 那样走不可覆盖的 writeVersioned。
 */
export async function buildAnchorWav(
  arollFile: string,
  map: OutputMapEntry[],
  outFile: string,
  deps?: VideoDeps,
): Promise<AnchorOutcome> {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const pass1 = await ffmpeg(
    ["-v", "info", "-i", arollFile, "-filter_complex", anchorFilter(map, `${LOUDNORM_BASE}:print_format=json`), "-map", "[out]", "-f", "null", "-"],
    deps,
  );
  if (pass1.spawnError) return { ok: false, errorCode: "ffmpeg_missing", reason: `找不到 ffmpeg：${pass1.spawnError}。装法：brew install ffmpeg` };
  if (pass1.code !== 0) {
    return { ok: false, errorCode: "loudnorm_measure_failed", reason: `响度测量失败（ffmpeg 退出码 ${String(pass1.code)}）：${stderrTail(pass1.stderr, 4)}` };
  }
  const measured = parseLoudnorm(pass1.stderr);
  if (!measured) {
    return { ok: false, errorCode: "loudnorm_measure_failed", reason: "读不出响度测量值（音轨可能接近全静音），无法做双 pass 归一" };
  }

  const tuned =
    `${LOUDNORM_BASE}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
    `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
    `:offset=${measured.target_offset}:linear=true`;
  const tmp = `${outFile}.tmp`;
  const pass2 = await ffmpeg(
    ["-y", "-v", "error", "-i", arollFile, "-filter_complex", anchorFilter(map, tuned), "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-f", "wav", tmp],
    deps,
  );
  if (pass2.code !== 0) {
    await fs.rm(tmp, { force: true });
    return { ok: false, errorCode: "loudnorm_render_failed", reason: `主音轨合成失败（ffmpeg 退出码 ${String(pass2.code)}）：${stderrTail(pass2.stderr, 4)}` };
  }
  await fs.rename(tmp, outFile);
  const probed = await probeMedia(outFile, deps);
  if (!probed.ok) return { ok: false, errorCode: "anchor_probe_failed", reason: probed.reason };
  return { ok: true, file: outFile, durationMs: probed.probe.durationMs };
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

function pickString(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * `<dataDir>/video-identity.json` → manifest.identity。
 * **只挑认识的字段**：render 侧的 schema 是 `.strict()`，多一个键整份 manifest 就被拒——
 * 用户手写的配置文件不该有能力让渲染整条失败。
 */
export async function loadIdentity(dataDir: string): Promise<RenderManifestIdentity> {
  const raw = await readJson<Record<string, unknown>>(path.join(dataDir, "video-identity.json"));
  const caption = (raw?.captionTheme ?? {}) as Record<string, unknown>;
  const code = raw?.codeTheme as Record<string, unknown> | undefined;
  const codeTheme = code
    ? {
        ...(pickString(code.background) ? { background: pickString(code.background)! } : {}),
        ...(pickString(code.foreground) ? { foreground: pickString(code.foreground)! } : {}),
        ...(pickString(code.accent) ? { accent: pickString(code.accent)! } : {}),
        ...(pickString(code.fontFamily) ? { fontFamily: pickString(code.fontFamily)! } : {}),
      }
    : undefined;
  return {
    captionTheme: {
      ...(pickString(caption.fontFamily, DEFAULT_IDENTITY.captionTheme.fontFamily)
        ? { fontFamily: pickString(caption.fontFamily, DEFAULT_IDENTITY.captionTheme.fontFamily)! }
        : {}),
      primaryColor: pickString(caption.primaryColor, DEFAULT_IDENTITY.captionTheme.primaryColor)!,
      emphasisColor: pickString(caption.emphasisColor, DEFAULT_IDENTITY.captionTheme.emphasisColor)!,
    },
    ...(codeTheme && Object.keys(codeTheme).length > 0 ? { codeTheme } : {}),
  };
}

// ---------------------------------------------------------------------------
// 素材：登记与复检
// ---------------------------------------------------------------------------

/** 覆盖轨槽位先登记成素材（含指纹），timeline 才有 assetId 可引用 */
async function registerOverlayAssets(
  dataDir: string,
  contentId: string,
  slots: OverlaySlot[],
): Promise<{ ok: true; overlays: { assetId: string; slot: OverlaySlot }[] } | { ok: false; reason: string }> {
  const overlays: { assetId: string; slot: OverlaySlot }[] = [];
  for (const slot of slots) {
    let absPath: string;
    try {
      absPath = await resolveAssetRef(dataDir, contentId, slot.ref);
      await fs.access(absPath);
    } catch (err) {
      return { ok: false, reason: `覆盖轨素材用不了：${(err as Error).message}` };
    }
    const entry = await upsertVideoAsset(dataDir, contentId, {
      kind: slot.kind === "screen" ? "screen" : "image",
      ref: slot.ref,
      status: "ready",
      fingerprint: await fingerprintFile(absPath),
    });
    overlays.push({ assetId: entry.assetId, slot });
  }
  return { ok: true, overlays };
}

/** 返回漂移素材的人话清单（空 = 全部对得上） */
export async function driftedAssets(
  dataDir: string,
  contentId: string,
  entries: VideoAssetEntry[],
): Promise<string[]> {
  const drifted: string[] = [];
  for (const entry of entries) {
    if (!entry.fingerprint) continue;
    let absPath: string;
    try {
      absPath = await resolveAssetRef(dataDir, contentId, entry.ref);
    } catch (err) {
      drifted.push(`${entry.assetId}：${(err as Error).message}`);
      continue;
    }
    if (!(await verifyFingerprint(absPath, entry.fingerprint))) {
      drifted.push(`${entry.assetId}（${path.basename(absPath)}）已被移动、替换或重新导出`);
    }
  }
  return drifted;
}

// ---------------------------------------------------------------------------
// 组装主流程
// ---------------------------------------------------------------------------

export interface AssembleInput {
  dataDir: string;
  contentId: string;
  transcript: VideoTranscript;
  transcriptRevision: number;
  cut: VideoCut;
  cutRevision: number;
  timelineRevision: number;
  slots: OverlaySlot[];
}

export type AssembleOutcome =
  | { ok: true; timeline: VideoTimeline; manifest: RenderManifest; manifestFile: string }
  | { ok: false; blockedReason?: "aroll_drifted" | "ffmpeg_missing"; errorCode: string; reason: string };

function driftBlocked(drifted: string[]): AssembleOutcome {
  return {
    ok: false,
    blockedReason: "aroll_drifted",
    errorCode: "aroll_drifted",
    reason: `素材与登记时对不上了：\n${drifted.map((d) => `· ${d}`).join("\n")}\n确认换了文件就重新转写，改回原文件即可继续`,
  };
}

function manifestOverlays(
  timeline: VideoTimeline,
  pathById: Map<string, string>,
): RenderManifestOverlay[] {
  return timeline.overlays.map((o) => {
    const kind = o.source.type;
    const file = "assetId" in o.source ? pathById.get(o.source.assetId) : undefined;
    return {
      clipId: o.clipId,
      outputStartMs: o.outputStartMs,
      durationMs: o.durationMs,
      kind,
      ...(file ? { file } : {}),
      ...(o.source.type === "screen" && o.source.fit ? { fit: o.source.fit } : {}),
      ...(o.source.type === "graphic" ? { template: o.source.template, props: o.source.props } : {}),
      ...(o.transition === "fade" ? { transition: "fade" as const } : { transition: "cut" as const }),
    };
  });
}

/** 组装到冻结的一条直线。任何一步不过都当场返回原因，绝不带病往下走 */
export async function assembleVideo(input: AssembleInput, deps?: VideoDeps): Promise<AssembleOutcome> {
  const { dataDir, contentId } = input;
  const dir = videoDir(dataDir, contentId);
  const assets = await readVideoAssets(dataDir, contentId);
  const aroll = assets.find((a) => a.kind === "aroll");
  if (!aroll?.fingerprint) return { ok: false, errorCode: "aroll_missing", reason: "素材清单里没有已登记的 A-roll，请重新走一次导入" };

  // 开跑前先看 A-roll 还在不在（§4.2 每 phase 复检）——不然 ffmpeg 会用一句天书报错
  const before = await driftedAssets(dataDir, contentId, [aroll]);
  if (before.length > 0) return driftBlocked(before);

  const registered = await registerOverlayAssets(dataDir, contentId, input.slots);
  if (!registered.ok) return { ok: false, errorCode: "overlay_asset_unusable", reason: registered.reason };

  let map: OutputMapEntry[];
  try {
    map = buildOutputMap(input.transcript, input.cut);
  } catch (err) {
    return { ok: false, errorCode: "cut_invalid", reason: (err as Error).message };
  }
  const durationMs = outputDurationMs(map);
  if (durationMs <= 0) {
    return { ok: false, errorCode: "empty_cut", reason: "这一版剪辑没有保留任何有时长的分句，成片会是空的——回选段视图勾几句再来" };
  }
  const zeroLength = map.find((e) => e.sourceEndMs <= e.sourceStartMs);
  if (zeroLength) {
    return { ok: false, errorCode: "zero_length_segment", reason: `分句 ${zeroLength.segmentId} 的时长为 0，转写有问题，请重跑 ASR` };
  }

  const timeline = buildDeterministicTimeline({
    transcriptRevision: input.transcriptRevision,
    cutRevision: input.cutRevision,
    overlays: registered.overlays,
  });
  const errors = validateTimeline(timeline, {
    registry: TIMELINE_REGISTRY,
    outputDurationMs: durationMs,
    assets: await readVideoAssets(dataDir, contentId),
  });
  if (errors.length > 0) {
    return { ok: false, errorCode: "timeline_invalid", reason: `timeline 校验不通过：\n${errors.map((e) => `· ${e}`).join("\n")}` };
  }
  await writeVersioned(dir, "timeline", input.timelineRevision, timeline);

  const arollPath = await resolveAssetRef(dataDir, contentId, aroll.ref);
  const anchor = await buildAnchorWav(arollPath, map, path.join(dir, `anchor.v${input.cutRevision}.wav`), deps);
  if (!anchor.ok) {
    return anchor.errorCode === "ffmpeg_missing"
      ? { ok: false, blockedReason: "ffmpeg_missing", errorCode: anchor.errorCode, reason: anchor.reason }
      : { ok: false, errorCode: anchor.errorCode, reason: anchor.reason };
  }

  // 冻结前最后一次复检：从这一刻起 manifest 就是渲染的唯一事实
  const finalAssets = await readVideoAssets(dataDir, contentId);
  const after = await driftedAssets(dataDir, contentId, finalAssets);
  if (after.length > 0) return driftBlocked(after);

  const pathById = new Map<string, string>();
  for (const entry of finalAssets) {
    pathById.set(entry.assetId, await resolveAssetRef(dataDir, contentId, entry.ref));
  }
  const manifest: RenderManifest = {
    schemaVersion: 1,
    contentId,
    timelineRevision: input.timelineRevision,
    cutRevision: input.cutRevision,
    transcriptRevision: input.transcriptRevision,
    fps: OUTPUT_FPS,
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    durationMs,
    anchorAudio: { file: anchor.file, durationMs: anchor.durationMs },
    arollVideo: { file: arollPath, segments: map.map(({ sourceStartMs, sourceEndMs, outputStartMs }) => ({ sourceStartMs, sourceEndMs, outputStartMs })) },
    overlays: manifestOverlays(timeline, pathById),
    captions: { style: "word-highlight", words: projectWordsToOutput(input.transcript, map), emphasisWords: [] },
    identity: await loadIdentity(dataDir),
    // V0a 不采购 AI 镜头、不用克隆音色（§7 是 V0b 起）——发布件的 AI 标注读的就是这两个字段
    provenance: { hasAiClips: false, hasClonedVoice: false },
  };
  const manifestFile = await writeVersioned(dir, "render-manifest", input.timelineRevision, manifest);
  return { ok: true, timeline, manifest, manifestFile };
}
