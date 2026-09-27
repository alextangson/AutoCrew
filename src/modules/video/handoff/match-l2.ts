/**
 * 认稿 L2：原片开头的转写比候选稿（P6 §12.4-B，codex 评审 #13 #14）。
 *
 * 转写：ffmpeg 只截前 120 秒进独立临时目录（0700，用完即删），FunASR 90 秒超时，
 * 全进程同时只跑一个（CPU 推理，两个一起跑谁都慢），调用方可取消。
 * 转写器是注入口：测试一律换假的，绝不真跑 FunASR。
 *
 * 评分：在每条候选稿上按转写长度开滑动窗口，取最佳窗口的**信息量加权字二元组相似度**
 * （权重 = 候选集合内的 IDF，分母在转写侧）。窗口跟转写一样长，长稿不会因为字多而天然占优；
 * 「的是」「我们」这种各稿都有的二元组权重低，专有名词权重高。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractAsrWav, runAsr } from "../asr.js";
import type { VideoDeps } from "../proc.js";
import { compareKey } from "./match-l1.js";

export const CLIP_SECONDS = 120;
export const MATCH_ASR_TIMEOUT_MS = 90_000;
/** 有效语音少于这么多字 → low_quality_transcript */
export const MIN_SPEECH_CHARS = 80;

export type TranscribeOutcome =
  | { ok: true; text: string }
  | { ok: false; unavailable: boolean; reason: string };

export interface MatchTranscriber {
  transcribe(arollPath: string, signal?: AbortSignal): Promise<TranscribeOutcome>;
}

// ---------------------------------------------------------------------------
// 全局并发 1
// ---------------------------------------------------------------------------

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
    const clipped = await extractAsrWav(arollPath, wav, deps, { maxSeconds: CLIP_SECONDS, timeoutMs: 60_000, ...(signal ? { abortSignal: signal } : {}) });
    if (!clipped.ok) return { ok: false, unavailable: clipped.errorCode === "ffmpeg_missing", reason: clipped.reason };
    const out = await runAsr({ audioFile: wav, outFile: path.join(dir, "head.json"), timeoutMs: MATCH_ASR_TIMEOUT_MS, ...(signal ? { abortSignal: signal } : {}) }, deps);
    if (!out.ok) return { ok: false, unavailable: out.blockedReason === "asr_not_ready", reason: out.reason };
    return { ok: true, text: out.transcript.segments.map((s) => s.text).join("") };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 默认转写器：本机 FunASR sidecar（`asr.ts` 的同一条调用路） */
export function funasrTranscriber(deps?: VideoDeps): MatchTranscriber {
  return { transcribe: (arollPath, signal) => oneAtATime(() => clipAndTranscribe(arollPath, deps, signal)) };
}

// ---------------------------------------------------------------------------
// 评分
// ---------------------------------------------------------------------------

export function bigramSeq(text: string): string[] {
  const chars = [...compareKey(text)];
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

export function speechChars(text: string): number {
  return [...compareKey(text)].length;
}

/** 候选集合内的 IDF：一条稿算一篇文档 */
export function idfTable(docs: readonly string[][]): (gram: string) => number {
  const df = new Map<string, number>();
  for (const doc of docs) for (const g of new Set(doc)) df.set(g, (df.get(g) ?? 0) + 1);
  const n = docs.length;
  return (gram) => Math.log((n + 1) / ((df.get(gram) ?? 0) + 1)) + 1;
}

/** 最佳窗口的加权覆盖：Σ 命中二元组权重 / Σ 转写二元组权重 */
export function windowSimilarity(transcript: readonly string[], body: readonly string[], idf: (g: string) => number): number {
  const spoken = new Set(transcript);
  if (spoken.size === 0 || body.length === 0) return 0;
  let total = 0;
  for (const g of spoken) total += idf(g);
  const size = Math.max(1, transcript.length);
  const stride = Math.max(1, Math.floor(size / 4));
  let best = 0;
  for (let start = 0; ; start += stride) {
    const window = new Set(body.slice(start, start + size));
    let hit = 0;
    for (const g of spoken) if (window.has(g)) hit += idf(g);
    best = Math.max(best, hit / total);
    if (start + size >= body.length) break;
  }
  return Math.round(best * 1000) / 1000;
}

/** 转写对整组候选打分（顺序与 bodies 一致） */
export function scoreTranscript(transcript: string, bodies: readonly string[]): number[] {
  const docs = bodies.map(bigramSeq);
  const idf = idfTable(docs);
  const spoken = bigramSeq(transcript);
  return docs.map((doc) => windowSimilarity(spoken, doc, idf));
}
