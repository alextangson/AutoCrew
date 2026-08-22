/**
 * 双 pass 响度归一的共用件（设计 spec §5）。
 *
 * 为什么抽出来：anchor（纯人声）与 master-audio（人声 + BGM）都要做双 pass loudnorm，
 * 但两条 filter 链完全不同。把「目标是多少、怎么测、怎么把测量值拼回第二 pass」收在一处，
 * 两条链才不会各自漂出一套响度口径——每条片子响度一致才算「一个频道」。
 *
 * 单 pass 的动态归一会随内容忽大忽小，双 pass（先测量再按测量值线性归一）才稳定。
 */
import { runProcess, type VideoDeps } from "./proc.js";

/** 主音轨响度目标（常量不可调） */
export const LOUDNESS_TARGET_I = -14;
export const LOUDNORM_BASE = `I=${LOUDNESS_TARGET_I}:TP=-1.5:LRA=11`;
/** 第一 pass：只测量，不出文件 */
export const LOUDNORM_MEASURE = `${LOUDNORM_BASE}:print_format=json`;

/** 整轨接近静音时 loudnorm 会报 -70 或 -inf；低于这条线就不是「小声」而是「没声」 */
export const SILENCE_LUFS = -60;

export interface LoudnormMeasured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** ms → ffmpeg 秒（三位小数），时间参数全线只有这一种写法 */
export function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/** loudnorm 的 JSON 报文混在 stderr 的日志里，取最后一个含 input_i 的对象 */
export function parseLoudnorm(stderr: string): LoudnormMeasured | null {
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

/** 测出来的响度是不是「整轨没声」——`-inf` 会被 parseLoudnorm 判成解析失败，这里管有限但极低的那档 */
export function isSilent(measured: LoudnormMeasured): boolean {
  return Number(measured.input_i) <= SILENCE_LUFS;
}

/** 第一 pass 的测量值 → 第二 pass 的线性归一参数 */
export function tunedLoudnorm(measured: LoudnormMeasured): string {
  return (
    `${LOUDNORM_BASE}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
    `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
    `:offset=${measured.target_offset}:linear=true`
  );
}

export interface FfmpegResult {
  code: number | null;
  stderr: string;
  spawnError?: string;
}

/** 全线唯一的 ffmpeg 调用壳（渲染是另一条路，走 render CLI） */
export async function ffmpeg(args: string[], deps?: VideoDeps): Promise<FfmpegResult> {
  const result = await runProcess({
    command: "ffmpeg",
    args: ["-hide_banner", "-nostdin", ...args],
    timeoutMs: 30 * 60_000,
    ...(deps?.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
  });
  return {
    code: result.code,
    stderr: result.stderr,
    ...(result.spawnError ? { spawnError: result.spawnError } : {}),
  };
}
