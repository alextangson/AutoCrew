/**
 * L2：原片开头的转写比候选稿（P6 §12.4-B，codex 评审 #13 #14；1b §2 抽进本体）。纯函数。
 *
 * 在每条候选稿上按转写长度开滑动窗口，取最佳窗口的**信息量加权字二元组相似度**
 * （权重 = 候选集合内的 IDF，分母在转写侧）。窗口跟转写一样长，长稿不会因为字多而天然占优；
 * 「的是」「我们」这种各稿都有的二元组权重低，专有名词权重高。
 */
import { compareKey } from "./l1.js";

export const CLIP_SECONDS = 120;
export const MATCH_ASR_TIMEOUT_MS = 90_000;
export const MATCH_FFMPEG_TIMEOUT_MS = 60_000;
/** 有效语音少于这么多字 → 短转写，不自动认（low_quality_transcript） */
export const MIN_SPEECH_CHARS = 80;

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
