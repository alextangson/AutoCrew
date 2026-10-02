/**
 * 比对用的转写调用（1b §2）：ffmpeg 只截前 120 秒进独立临时目录（0700，用完即删），FunASR 90 秒超时，
 * 两个子进程都以 nice 10 跑；全进程同时只跑一个（CPU 推理，两个一起跑谁都慢），调用方可取消。
 * 转写器是注入口：测试一律换假的，绝不真跑 FunASR。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ASR_SIDECAR_DIR, ASR_WARMUP_WHERE, effectiveAsrStatus, extractAsrWav, runAsr } from "../../video/asr.js";
import { commandExists, type VideoDeps } from "../../video/proc.js";
import { CLIP_SECONDS, MATCH_ASR_TIMEOUT_MS, MATCH_FFMPEG_TIMEOUT_MS } from "./l2.js";

export const MATCH_NICENESS = 10;

export type TranscribeOutcome =
  | { ok: true; text: string }
  | { ok: false; unavailable: boolean; reason: string };

export interface MatchTranscriber {
  transcribe(arollPath: string, signal?: AbortSignal): Promise<TranscribeOutcome>;
  /** 转写还没就绪的原因（null = 就绪）。先问这一句，没就绪立刻降级，不去等 90 秒超时 */
  notReady?(dataDir: string): Promise<string | null>;
}

let asrChain: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = asrChain.catch(() => undefined).then(fn);
  asrChain = run.catch(() => undefined);
  return run;
}

async function clipAndTranscribe(arollPath: string, deps: VideoDeps | undefined, signal?: AbortSignal): Promise<TranscribeOutcome> {
  if (signal?.aborted) return { ok: false, unavailable: false, reason: "已取消" };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-match-"));
  try {
    await fs.chmod(dir, 0o700);
    const wav = path.join(dir, "head.wav");
    const abort = signal ? { abortSignal: signal } : {};
    const clipped = await extractAsrWav(arollPath, wav, deps, { maxSeconds: CLIP_SECONDS, timeoutMs: MATCH_FFMPEG_TIMEOUT_MS, niceness: MATCH_NICENESS, ...abort });
    if (!clipped.ok) return { ok: false, unavailable: clipped.errorCode === "ffmpeg_missing", reason: clipped.reason };
    const out = await runAsr({ audioFile: wav, outFile: path.join(dir, "head.json"), timeoutMs: MATCH_ASR_TIMEOUT_MS, niceness: MATCH_NICENESS, ...abort }, deps);
    if (!out.ok) return { ok: false, unavailable: out.blockedReason === "asr_not_ready", reason: out.reason };
    return { ok: true, text: out.transcript.segments.map((s) => s.text).join("") };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 默认转写器：本机 FunASR sidecar（`asr.ts` 的同一条调用路） */
export function funasrTranscriber(deps?: VideoDeps): MatchTranscriber {
  return {
    transcribe: (arollPath, signal) => oneAtATime(() => clipAndTranscribe(arollPath, deps, signal)),
    notReady: (dataDir) => funasrNotReady(dataDir, deps),
  };
}

/** 运行器、依赖环境（.venv）、模型三样都在才算就绪；模型 = 预热落了 ready，或共享缓存里已经有。doctor 也用它 */
export async function funasrNotReady(dataDir: string, deps?: VideoDeps): Promise<string | null> {
  if (!(await commandExists("uv", deps))) return "未装 uv（ASR 的运行器）";
  const venv = await fs.access(path.join(ASR_SIDECAR_DIR, ".venv")).then(() => true, () => false);
  if (!venv) return "ASR 依赖环境还没装好";
  const status = await effectiveAsrStatus(dataDir);
  if (status.status === "ready") return null;
  const label = { absent: "ASR 模型还没下载（约 1GB）", warming: "ASR 模型正在预热", failed: "ASR 模型上次预热失败" }[status.status];
  return status.detail ? `${label}：${status.detail}` : label;
}

/** doctor 用：没就绪的原因 → 一句怎么装（1b §10） */
export function notReadyFix(reason: string): string {
  if (reason.includes("uv")) return "装 uv：curl -LsSf https://astral.sh/uv/install.sh | sh";
  if (reason.includes("依赖环境")) return `装转写依赖：uv sync --project ${ASR_SIDECAR_DIR}`;
  return `下载 / 预热转写模型：${ASR_WARMUP_WHERE}（约 1GB）`;
}
