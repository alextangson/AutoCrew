/**
 * Assemble：确定性组装 + 冻结（设计 spec §2.4 / §2.5 / §2.8 / §5；横屏 spec §2.3 / §2.4）。
 *
 * 这一层**没有 LLM**：timeline 由 transcript + cut + 人工指定的覆盖轨槽位算出来，
 * 同样的输入永远得到同样的 timeline。timeline 的形状本身在 `timeline-build.ts`。
 *
 * 五个不可省的动作，顺序即语义：
 * 1. `buildOutputMap` 把源时间域换成输出时间域——timeline 一律工作在输出域（§2.4）。
 * 2. `validateTimeline` 把关，不合法当场失败。
 * 3. **anchor wav**：按 keep 段抽 A-roll 音轨 → `loudnorm` 双 pass 到 -14 LUFS。
 *    单 pass 的动态归一会随内容忽大忽小，双 pass（先测量再按测量值线性归一）才稳定。
 * 4. **音轨选取**：挂了 BGM 就再合一版 master-audio，没挂就直接指 anchor。
 *    anchor 永远是纯人声，混音是它之后的独立一步（横屏 spec §2.4）。
 * 5. **冻结 render-manifest**：render 只吃这份 manifest，绝不回头读 timeline（§2.8）。
 *    冻结前复检全部素材指纹——A-roll 是引用不是拷贝，这是最后一次能发现它被换掉的机会。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../storage/local-store.js";
import { readJson } from "../../storage/json-atomic.js";
import { verifyFingerprint, fingerprintFile } from "./fingerprint.js";
import { probeMedia, resolveBgmRef } from "./ingest.js";
import { upsertVideoAsset } from "./ingest.js";
import { ffmpeg, LOUDNORM_MEASURE, parseLoudnorm, seconds, tunedLoudnorm } from "./loudnorm.js";
import { buildMasterAudio } from "./master-audio.js";
import { buildCaptionCues } from "./captions.js";
import { buildRenderManifest } from "./manifest-build.js";
import { buildOutputMap, outputDurationMs } from "./output-map.js";
import { stderrTail, type VideoDeps } from "./proc.js";
import { buildDeterministicTimeline, type OverlaySlot } from "./timeline-build.js";
import { TIMELINE_REGISTRY, validateTimeline } from "./timeline-validate.js";
import {
  readVideoAssets,
  resolveAssetRef,
  videoDir,
  writeVersioned,
} from "./video-store.js";
import type {
  OutputMapEntry,
  RenderManifest,
  RenderManifestIdentity,
  RenderManifestOverlay,
  VideoAssetEntry,
  VideoCut,
  VideoTimeline,
  VideoTranscript,
} from "./types.js";

// ---------------------------------------------------------------------------
// anchor wav（loudnorm 双 pass）
// ---------------------------------------------------------------------------

/** keep 段 atrim → concat → loudnorm。单段时省掉 concat（`concat=n=1` 纯属噪音） */
function anchorFilter(map: OutputMapEntry[], loudnorm: string): string {
  const trim = (e: OutputMapEntry): string =>
    `atrim=start=${seconds(e.sourceStartMs)}:end=${seconds(e.sourceEndMs)},asetpts=PTS-STARTPTS`;
  if (map.length === 1) return `[0:a]${trim(map[0])},loudnorm=${loudnorm}[out]`;
  const parts = map.map((e, i) => `[0:a]${trim(e)}[a${i}]`);
  const labels = map.map((_, i) => `[a${i}]`).join("");
  return `${parts.join(";")};${labels}concat=n=${map.length}:v=0:a=1,loudnorm=${loudnorm}[out]`;
}

export type AnchorOutcome =
  | { ok: true; file: string; durationMs: number }
  | { ok: false; errorCode: string; reason: string };

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
    ["-v", "info", "-i", arollFile, "-filter_complex", anchorFilter(map, LOUDNORM_MEASURE), "-map", "[out]", "-f", "null", "-"],
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

  const tuned = tunedLoudnorm(measured);
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

export const DEFAULT_IDENTITY: RenderManifestIdentity = {
  captionTheme: { fontFamily: "PingFang SC", primaryColor: "#FFFFFF", accentColor: "#FFD54A" },
};

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
      accentColor: pickString(caption.accentColor, DEFAULT_IDENTITY.captionTheme.accentColor)!,
    },
    ...(codeTheme && Object.keys(codeTheme).length > 0 ? { codeTheme } : {}),
  };
}

// ---------------------------------------------------------------------------
// 素材：登记与复检
// ---------------------------------------------------------------------------

/**
 * 覆盖轨槽位先登记成素材（含指纹），timeline 才有 assetId 可引用。
 *
 * 槽位自带指纹时**先复检再登记**（v2 spec §4.2 / 边界 #12）：那份指纹是剪辑师选中或人
 * 填槽时打的快照。少了这一步，「填完槽又把文件换了」只会被登记成新指纹，从此查无可查。
 */
async function registerOverlayAssets(
  dataDir: string,
  contentId: string,
  slots: OverlaySlot[],
): Promise<
  | { ok: true; overlays: { assetId: string; slot: OverlaySlot }[] }
  | { ok: false; drifted?: true; reason: string }
> {
  const overlays: { assetId: string; slot: OverlaySlot }[] = [];
  for (const slot of slots) {
    let absPath: string;
    try {
      absPath = await resolveAssetRef(dataDir, contentId, slot.ref);
      await fs.access(absPath);
    } catch (err) {
      return { ok: false, reason: `覆盖轨素材用不了：${(err as Error).message}` };
    }
    if (slot.fingerprint && !(await verifyFingerprint(absPath, slot.fingerprint))) {
      return {
        ok: false,
        drifted: true,
        reason:
          `覆盖轨素材 ${path.basename(absPath)} 与确认成片计划时对不上了（被移动、替换或重新导出过）。\n` +
          "改回原文件即可继续；确实换了新素材就回成片计划重新填一次这一槽",
      };
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
  /**
   * 剪辑单元的来源（`edit-units.origin`）。cue 切分按它分派：
   * `llm` 走语义单元，`raw`（含老产物缺表回落）走宽度分组。
   */
  unitsOrigin?: "llm" | "raw";
}

export type AssembleOutcome =
  /** warning = 组装成了但有话要说（例：BGM 不合格已降级为无 BGM）——降级必须可见 */
  | { ok: true; timeline: VideoTimeline; manifest: RenderManifest; manifestFile: string; warning?: string }
  | { ok: false; blockedReason?: "aroll_drifted" | "ffmpeg_missing"; errorCode: string; reason: string };

type AudioTrackOutcome =
  | { ok: true; file: string; durationMs: number; warning?: string }
  | { ok: false; errorCode: string; reason: string };

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
      // 屏录的取材窗口必须传到渲染侧，否则整段素材只会从头播（横屏 spec §3.3 阻断项）
      ...(o.source.type === "screen" && o.source.inMs !== undefined ? { inMs: o.source.inMs } : {}),
      ...(o.source.type === "screen" && o.source.outMs !== undefined ? { outMs: o.source.outMs } : {}),
      ...("fit" in o.source && o.source.fit ? { fit: o.source.fit } : {}),
      ...(o.source.type === "graphic" ? { template: o.source.template, props: o.source.props } : {}),
      ...(o.transition === "fade" ? { transition: "fade" as const } : { transition: "cut" as const }),
    };
  });
}

/** 片头大字取发布件的 `coverText`（§2.3）——postTitle 是平台发布标题，不是给画面用的 */
async function titleTextOf(dataDir: string, contentId: string): Promise<string | undefined> {
  const content = await getContent(contentId, dataDir);
  return content?.videoKit?.coverText?.trim() || undefined;
}

/**
 * 成片音轨：有 BGM 走 master-audio，无 BGM 直接指 anchor（§2.4）。
 * 「无 BGM」是合法状态不报警；BGM 挂了但不能用才降级 + warning；挂了多条一律报错让人选，不猜。
 */
async function resolveAudioTrack(
  input: AssembleInput,
  anchor: { file: string; durationMs: number },
  deps?: VideoDeps,
): Promise<AudioTrackOutcome> {
  const { dataDir, contentId } = input;
  const bgm = await resolveBgmRef(dataDir, contentId);
  if (bgm.kind === "none") return { ok: true, ...anchor };
  if (bgm.kind === "ambiguous") {
    return {
      ok: false,
      errorCode: "bgm_ambiguous",
      reason: `这篇挂了 ${bgm.filenames.length} 条 BGM（${bgm.filenames.join("、")}），系统不替你猜用哪条——把多余的改成别的角色或移除后重试`,
    };
  }
  let bgmPath: string;
  try {
    bgmPath = await resolveAssetRef(dataDir, contentId, bgm.ref);
    await fs.access(bgmPath);
  } catch (err) {
    return { ok: true, ...anchor, warning: `BGM 用不了（${(err as Error).message}），这一版按无 BGM 出片` };
  }
  // BGM 是受管素材：进清单、带指纹，冻结前的复检因此也盯着它（§2.4）
  await upsertVideoAsset(dataDir, contentId, {
    kind: "bgm",
    ref: bgm.ref,
    status: "ready",
    fingerprint: await fingerprintFile(bgmPath),
  });
  const master = await buildMasterAudio(
    {
      anchorFile: anchor.file,
      durationMs: anchor.durationMs,
      bgmFile: bgmPath,
      outFile: path.join(videoDir(dataDir, contentId), `master-audio.v${input.timelineRevision}.wav`),
    },
    deps,
  );
  if (master.ok) return { ok: true, file: master.file, durationMs: master.durationMs };
  if (master.rejected) return { ok: true, ...anchor, warning: master.warning };
  return { ok: false, errorCode: master.errorCode, reason: master.reason };
}

interface FreezeInput {
  input: AssembleInput;
  timeline: VideoTimeline;
  map: OutputMapEntry[];
  durationMs: number;
  arollPath: string;
  audio: { file: string; durationMs: number };
  pathById: Map<string, string>;
  identity: RenderManifestIdentity;
}

/**
 * manifest 是渲染的唯一事实：这里之后没人再回头读 timeline（§2.8）。
 * 形状由共享 builder 出，本函数只负责把 timeline 翻成它要的入参——
 * 预览与正式因此不可能长出两套时间映射（边界 #16）。
 */
function freezeManifest(f: FreezeInput): RenderManifest {
  const { input, timeline } = f;
  return buildRenderManifest({
    contentId: input.contentId,
    timelineRevision: input.timelineRevision,
    cutRevision: input.cutRevision,
    transcriptRevision: input.transcriptRevision,
    durationMs: f.durationMs,
    map: f.map,
    arollFile: f.arollPath,
    audio: f.audio,
    // 字幕断句在这里算完冻结，渲染端只做块内排版（v2 spec §2.1）
    cues: buildCaptionCues({ transcript: input.transcript, map: f.map, origin: input.unitsOrigin ?? "raw" }),
    overlays: manifestOverlays(timeline, f.pathById),
    ...(timeline.titleCard
      ? { titleCard: { text: timeline.titleCard.text, durationMs: timeline.titleCard.durationMs } }
      : {}),
    identity: f.identity,
  });
}

/** 输出域总长与零长分句的把关；不过就当场说清楚，绝不带病往下走 */
function checkOutputMap(map: OutputMapEntry[]): { ok: false; errorCode: string; reason: string } | null {
  if (outputDurationMs(map) <= 0) {
    return { ok: false, errorCode: "empty_cut", reason: "这一版剪辑没有保留任何有时长的分句，成片会是空的——回选段视图勾几句再来" };
  }
  const zeroLength = map.find((e) => e.sourceEndMs <= e.sourceStartMs);
  return zeroLength
    ? { ok: false, errorCode: "zero_length_segment", reason: `分句 ${zeroLength.segmentId} 的时长为 0，转写有问题，请重跑 ASR` }
    : null;
}

/** ffmpeg 缺席是「等一个外部条件」不是「这条剪不出来」——两种命运在这里分岔 */
function audioFailed(result: { errorCode: string; reason: string }): AssembleOutcome {
  return result.errorCode === "ffmpeg_missing"
    ? { ok: false, blockedReason: "ffmpeg_missing", errorCode: result.errorCode, reason: result.reason }
    : { ok: false, errorCode: result.errorCode, reason: result.reason };
}

/** 建 timeline → 校验 → 落盘。不合法的 timeline 绝不落盘（落了就成了假的审计凭证） */
async function stageTimeline(
  input: AssembleInput,
  overlays: { assetId: string; slot: OverlaySlot }[],
  durationMs: number,
): Promise<{ ok: true; timeline: VideoTimeline } | { ok: false; errorCode: string; reason: string }> {
  const { dataDir, contentId } = input;
  const titleText = await titleTextOf(dataDir, contentId);
  const timeline = buildDeterministicTimeline({
    transcriptRevision: input.transcriptRevision,
    cutRevision: input.cutRevision,
    overlays,
    outputDurationMs: durationMs,
    ...(titleText ? { titleText } : {}),
  });
  const errors = validateTimeline(timeline, {
    registry: TIMELINE_REGISTRY,
    outputDurationMs: durationMs,
    assets: await readVideoAssets(dataDir, contentId),
  });
  if (errors.length > 0) {
    return { ok: false, errorCode: "timeline_invalid", reason: `timeline 校验不通过：\n${errors.map((e) => `· ${e}`).join("\n")}` };
  }
  await writeVersioned(videoDir(dataDir, contentId), "timeline", input.timelineRevision, timeline);
  return { ok: true, timeline };
}

/** 组装到冻结的一条直线。任何一步不过都当场返回原因 */
export async function assembleVideo(input: AssembleInput, deps?: VideoDeps): Promise<AssembleOutcome> {
  const { dataDir, contentId } = input;
  const dir = videoDir(dataDir, contentId);
  const aroll = (await readVideoAssets(dataDir, contentId)).find((a) => a.kind === "aroll");
  if (!aroll?.fingerprint) return { ok: false, errorCode: "aroll_missing", reason: "素材清单里没有已登记的 A-roll，请重新走一次导入" };

  // 开跑前先看 A-roll 还在不在（§4.2 每 phase 复检）——不然 ffmpeg 会用一句天书报错
  const before = await driftedAssets(dataDir, contentId, [aroll]);
  if (before.length > 0) return driftBlocked(before);

  const registered = await registerOverlayAssets(dataDir, contentId, input.slots);
  if (!registered.ok) {
    return registered.drifted
      ? { ok: false, blockedReason: "aroll_drifted", errorCode: "overlay_asset_drifted", reason: registered.reason }
      : { ok: false, errorCode: "overlay_asset_unusable", reason: registered.reason };
  }

  let map: OutputMapEntry[];
  try {
    map = buildOutputMap(input.transcript, input.cut);
  } catch (err) {
    return { ok: false, errorCode: "cut_invalid", reason: (err as Error).message };
  }
  const mapProblem = checkOutputMap(map);
  if (mapProblem) return mapProblem;
  const durationMs = outputDurationMs(map);

  const staged = await stageTimeline(input, registered.overlays, durationMs);
  if (!staged.ok) return staged;

  const arollPath = await resolveAssetRef(dataDir, contentId, aroll.ref);
  const anchor = await buildAnchorWav(arollPath, map, path.join(dir, `anchor.v${input.cutRevision}.wav`), deps);
  if (!anchor.ok) return audioFailed(anchor);
  const audio = await resolveAudioTrack(input, { file: anchor.file, durationMs: anchor.durationMs }, deps);
  if (!audio.ok) return audioFailed(audio);

  // 冻结前最后一次复检：从这一刻起 manifest 就是渲染的唯一事实
  const finalAssets = await readVideoAssets(dataDir, contentId);
  const after = await driftedAssets(dataDir, contentId, finalAssets);
  if (after.length > 0) return driftBlocked(after);

  const pathById = new Map<string, string>();
  for (const entry of finalAssets) {
    pathById.set(entry.assetId, await resolveAssetRef(dataDir, contentId, entry.ref));
  }
  const manifest = freezeManifest({
    input, timeline: staged.timeline, map, durationMs, arollPath, pathById,
    audio: { file: audio.file, durationMs: audio.durationMs },
    identity: await loadIdentity(dataDir),
  });
  const manifestFile = await writeVersioned(dir, "render-manifest", input.timelineRevision, manifest);
  return { ok: true, timeline: staged.timeline, manifest, manifestFile, ...(audio.warning ? { warning: audio.warning } : {}) };
}
