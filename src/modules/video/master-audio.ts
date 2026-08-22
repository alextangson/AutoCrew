/**
 * BGM 主混音（横屏 spec §2.4）。
 *
 * 为什么不混进 anchor：anchor 是 `(A-roll, cut)` 的纯函数产物，永远是纯人声。BGM 混进去之后
 * 「换一首曲子」就会让转写与选段都没变的产物一起失效，也再说不清成片里的人声是哪一版。
 * 所以 master-audio 是 anchor **之后**的独立一步，自带版本号：`master-audio.v<timelineRevision>.wav`。
 *
 * 混音顺序即语义，任何一步换位响度都会失控：
 *   人声（anchor，已 -14 LUFS）
 *   → BGM **先自身双 pass 响度归一**：不归一就等于拿「这首歌恰好录得多大声」当垫乐音量
 *   → loop/截断到人声长度 + 尾部 2s fade（曲子短了循环，长了砍掉，结尾不许硬切）
 *   → `amix(normalize=0)` 以 -22dB 垫入：normalize=1 会按输入条数自动衰减，人声跟着变小
 *   → 最终混音再过一次双 pass loudnorm 回到 -14 LUFS / TP -1.5
 *   → limiter 只作安全网，正常素材根本碰不到它
 *
 * 系统不找音乐、不生成音乐：版权是创始人的责任边界（spec §2.4）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { probeMedia } from "./ingest.js";
import {
  ffmpeg,
  isSilent,
  LOUDNORM_MEASURE,
  parseLoudnorm,
  seconds,
  tunedLoudnorm,
  type LoudnormMeasured,
} from "./loudnorm.js";
import type { VideoDeps } from "./proc.js";

/** 混音算法版本：改了下面任何一个参数都要跟着加一，否则旧 master-audio 会被当成同款复用 */
export const MASTER_AUDIO_ALGO = "master-v1";

/** 垫乐相对人声的音量（spec §2.4 定值） */
export const BGM_BED_GAIN_DB = -22;
/** 尾部淡出，避免成片最后一帧硬切音乐 */
export const BGM_FADE_OUT_MS = 2000;
/** 短于这条线的音频不是 BGM，是误挂的音效或半截文件（边界 #12） */
export const MIN_BGM_MS = 2000;
/** limiter 天花板 = TP -1.5dBFS 的线性值，安全网而非音色处理 */
export const LIMITER_CEILING = "0.841";

/** 混音参数指纹：进 inputKey，换参数即换产物（spec §2.4） */
export const MASTER_AUDIO_PARAMS = `${MASTER_AUDIO_ALGO}|bed:${BGM_BED_GAIN_DB}|fade:${BGM_FADE_OUT_MS}`;

export type MasterAudioOutcome =
  | { ok: true; file: string; durationMs: number }
  /** BGM 本身不合格：降级成无 BGM，成片照出，但 warning 必须让人看见（不静默降级） */
  | { ok: false; rejected: true; warning: string }
  /** 混音链自己炸了：不许降级，assemble 当场失败 */
  | { ok: false; rejected?: false; errorCode: string; reason: string };

/**
 * BGM 支路。`aformat` 一步同时解决边界 #12 的后两条：单声道上混成立体声、异常采样率重采样到 48k。
 * 之后才是归一 → 截到人声长度 → 尾部淡出 → 垫入音量。
 */
export function bgmBranch(tuned: string, durationMs: number): string {
  const fadeStartMs = Math.max(0, durationMs - BGM_FADE_OUT_MS);
  return (
    `[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
    `loudnorm=${tuned},` +
    `atrim=end=${seconds(durationMs)},asetpts=PTS-STARTPTS,` +
    `afade=t=out:st=${seconds(fadeStartMs)}:d=${seconds(BGM_FADE_OUT_MS)},` +
    `volume=${BGM_BED_GAIN_DB}dB[bed]`
  );
}

/** 人声 + 垫乐 → amix(normalize=0) → 最终 loudnorm → limiter 安全网 */
export function masterFilter(args: { bgmTuned: string; mixLoudnorm: string; durationMs: number }): string {
  return (
    `${bgmBranch(args.bgmTuned, args.durationMs)};` +
    `[0:a][bed]amix=inputs=2:duration=first:normalize=0,` +
    `loudnorm=${args.mixLoudnorm},` +
    `alimiter=limit=${LIMITER_CEILING}[out]`
  );
}

/** 混音两个 pass 共用的参数序列：只有 loudnorm 段与输出目标不同 */
function mixArgs(
  input: { anchorFile: string; bgmFile: string; durationMs: number },
  filter: string,
  output: string[],
): string[] {
  return [
    "-i", input.anchorFile,
    // -stream_loop -1：曲子短于人声时无限循环，长度由支路的 atrim 说了算
    "-stream_loop", "-1", "-i", input.bgmFile,
    "-filter_complex", filter,
    "-map", "[out]",
    "-t", seconds(input.durationMs),
    ...output,
  ];
}

/** BGM 收货门槛（边界 #12）：不是音频、读不出时长、短于 2s 一律拒收 */
async function gateBgm(bgmFile: string, deps?: VideoDeps): Promise<MasterAudioOutcome | null> {
  const name = path.basename(bgmFile);
  const probed = await probeMedia(bgmFile, deps);
  if (!probed.ok) {
    return probed.errorCode === "ffmpeg_missing"
      ? { ok: false, errorCode: "ffmpeg_missing", reason: probed.reason }
      : { ok: false, rejected: true, warning: `BGM「${name}」读不了（文件可能已损坏），这一版按无 BGM 出片` };
  }
  if (!probed.probe.audio) {
    return { ok: false, rejected: true, warning: `BGM「${name}」里没有音轨，这一版按无 BGM 出片` };
  }
  if (probed.probe.durationMs < MIN_BGM_MS) {
    return {
      ok: false,
      rejected: true,
      warning: `BGM「${name}」只有 ${probed.probe.durationMs}ms，短于 ${MIN_BGM_MS}ms 下限（这更像误挂的音效），这一版按无 BGM 出片`,
    };
  }
  return null;
}

/** BGM 自身响度测量：拿不到值 = 整轨接近静音，按拒收处理 */
async function measureBgm(
  bgmFile: string,
  deps?: VideoDeps,
): Promise<{ ok: true; measured: LoudnormMeasured } | { ok: false; outcome: MasterAudioOutcome }> {
  const name = path.basename(bgmFile);
  const silent: MasterAudioOutcome = {
    ok: false,
    rejected: true,
    warning: `BGM「${name}」整轨接近静音，垫进去也听不见，这一版按无 BGM 出片`,
  };
  const pass = await ffmpeg(
    ["-v", "info", "-i", bgmFile, "-filter_complex", `[0:a]loudnorm=${LOUDNORM_MEASURE}[out]`, "-map", "[out]", "-f", "null", "-"],
    deps,
  );
  if (pass.spawnError) {
    return { ok: false, outcome: { ok: false, errorCode: "ffmpeg_missing", reason: `找不到 ffmpeg：${pass.spawnError}。装法：brew install ffmpeg` } };
  }
  if (pass.code !== 0) return { ok: false, outcome: silent };
  const measured = parseLoudnorm(pass.stderr);
  if (!measured || isSilent(measured)) return { ok: false, outcome: silent };
  return { ok: true, measured };
}

export interface MasterAudioInput {
  /** anchor.v<M>.wav——已归一到 -14 LUFS 的纯人声 */
  anchorFile: string;
  /** 成片输出域总长；BGM 按它循环/截断 */
  durationMs: number;
  bgmFile: string;
  outFile: string;
}

/**
 * 人声 + BGM → `master-audio.v<K>.wav`。
 * BGM 不合格返回 `rejected`（调用方降级成无 BGM + warning），混音链失败返回 errorCode（调用方当场失败）。
 */
export async function buildMasterAudio(input: MasterAudioInput, deps?: VideoDeps): Promise<MasterAudioOutcome> {
  const rejected = await gateBgm(input.bgmFile, deps);
  if (rejected) return rejected;
  const bgm = await measureBgm(input.bgmFile, deps);
  if (!bgm.ok) return bgm.outcome;
  const bgmTuned = tunedLoudnorm(bgm.measured);

  await fs.mkdir(path.dirname(input.outFile), { recursive: true });
  const measurePass = await ffmpeg(
    mixArgs(input, masterFilter({ bgmTuned, mixLoudnorm: LOUDNORM_MEASURE, durationMs: input.durationMs }), ["-f", "null", "-"]),
    deps,
  );
  if (measurePass.code !== 0) {
    return { ok: false, errorCode: "master_measure_failed", reason: `混音响度测量失败（ffmpeg 退出码 ${String(measurePass.code)}）` };
  }
  const mixMeasured = parseLoudnorm(measurePass.stderr);
  if (!mixMeasured) {
    return { ok: false, errorCode: "master_measure_failed", reason: "读不出混音后的响度测量值，无法做双 pass 归一" };
  }

  const tmp = `${input.outFile}.tmp`;
  const renderPass = await ffmpeg(
    mixArgs(
      input,
      masterFilter({ bgmTuned, mixLoudnorm: tunedLoudnorm(mixMeasured), durationMs: input.durationMs }),
      ["-y", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-f", "wav", tmp],
    ),
    deps,
  );
  if (renderPass.code !== 0) {
    await fs.rm(tmp, { force: true });
    return { ok: false, errorCode: "master_render_failed", reason: `主混音合成失败（ffmpeg 退出码 ${String(renderPass.code)}）` };
  }
  await fs.rename(tmp, input.outFile);
  const probed = await probeMedia(input.outFile, deps);
  if (!probed.ok) return { ok: false, errorCode: "master_probe_failed", reason: probed.reason };
  return { ok: true, file: input.outFile, durationMs: probed.probe.durationMs };
}
