/**
 * 「这次转写的输入是什么」的唯一口径（转写纠错 spec §2）。
 *
 * 两个消费方共用同一组常量，改一个不会漏掉另一个：
 * - **job 去重**（runner 的 inputKey）：输入没变的重复投递合并成一次；变了各自成队。
 * - **ASR 结果缓存**：A-roll 与热词都没变时跳过 ffmpeg + sidecar，直接用盘上的 `asr-out.json`。
 *
 * 缓存存在的理由很具体：14 分钟素材一次推理要跑十几分钟，而「只想换个清洗口径重试一次」
 * 是转写这一步最常见的重跑动机。不为它开新 phase / 新 job——重试粒度靠缓存拿到（§2）。
 *
 * 缓存是**保守**的：meta 缺失、对不上、`asr-out.json` 读不出或结构不对，一律当没命中重跑
 * ASR。多跑一次只是慢，用错一份转写是把别人的话剪进片子。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { HOTWORD_ALGO_VERSION } from "./hotwords.js";
// 清洗 prompt 的版本跟着 prompt 走（`transcript-clean.ts` 自持它，与 hotwords 同一个模式）：
// 版本号与它描述的那段文字放在一起，改口径时才不会漏改版本
import { CLEAN_PROMPT_VERSION } from "./transcript-clean.js";
import type { TranscriptSegment, VideoTranscript } from "./types.js";

const sha8 = (s: string): string => createHash("sha256").update(s, "utf-8").digest("hex").slice(0, 8);

/**
 * ASR 调用参数的版本（模型、采样率、传参形态）。它只进缓存 meta 不进 inputKey：
 * 换 ASR 参数意味着盘上那份 `asr-out.json` 作废，但 job 语义上仍是「转写这条 A-roll」。
 */
export const ASR_PARAMS_VERSION = "asr-1";

/**
 * 引擎路由指纹。口径抄 `roughCutInputKey`：换模型/换端点 = 换了输入，
 * 清洗结果不该跨路由复用。读不到配置也是一种输入状态（配好之后 key 会变，自动重跑）。
 */
async function routeDigest(dataDir: string): Promise<string> {
  try {
    const config = await loadEngineConfig(dataDir);
    const r = resolveEngineRoute(config, "scout", config.strongModel);
    return sha8(`${r.config.baseUrl}|${r.model}|${r.config.protocol ?? ""}`);
  } catch {
    return "none";
  }
}

/**
 * transcribe 的输入指纹。除了 A-roll 本身，热词从稿件正文抽、清洗读稿件正文对照，
 * 所以正文与两个算法版本都是输入——只写 A-roll 的话，稿子改了会被当成「同一份输入」合并掉。
 */
export async function transcribeInputKey(dataDir: string, arollHash: string, body: string): Promise<string> {
  return (
    `aroll:${arollHash}+body:${sha8(body)}` +
    `+hot:${HOTWORD_ALGO_VERSION}+clean:${CLEAN_PROMPT_VERSION}+route:${await routeDigest(dataDir)}`
  );
}

// ---------------------------------------------------------------------------
// ASR 结果缓存
// ---------------------------------------------------------------------------

/** ASR 裸输出的文件名（sidecar 直接写它）与它的侧车 meta */
export const ASR_OUT_FILE = "asr-out.json";
export const ASR_META_FILE = "asr-out.meta.json";

/** 盘上那份 `asr-out.json` 是对着什么算出来的 */
export interface AsrCacheMeta {
  schemaVersion: 1;
  /** A-roll 内容指纹（引用不复制，换了文件就换了转写） */
  arollQuickHash: string;
  /** 热词表指纹：换一批热词，识别结果就可能不同 */
  hotwordsHash: string;
  paramsVersion: string;
}

/** 顺序不该影响命中（提取是频次排序，同一批词换个顺序仍是同一批词） */
export function hotwordsHash(hotwords: readonly string[]): string {
  return sha8(JSON.stringify([...hotwords].sort()));
}

export function asrCacheMeta(arollQuickHash: string, hotwords: readonly string[]): AsrCacheMeta {
  return {
    schemaVersion: 1,
    arollQuickHash,
    hotwordsHash: hotwordsHash(hotwords),
    paramsVersion: ASR_PARAMS_VERSION,
  };
}

/**
 * 缓存文件也是系统边界：它可能是上次崩在写一半留下的半个 JSON。逐字段验，验不过当没命中。
 * 与 asr.ts 的 sidecar 解析各验各的——那边验的是「sidecar 契约有没有被破坏」（要报错），
 * 这边验的是「这份缓存还能不能用」（不能用就重跑），两种命运不该共用一条判定。
 */
function parseCachedTranscript(raw: string): VideoTranscript | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = parsed as Partial<VideoTranscript>;
  if (!obj || typeof obj !== "object" || obj.schemaVersion !== 1 || obj.source !== "funasr") return null;
  if (!Array.isArray(obj.segments)) return null;
  for (const seg of obj.segments as TranscriptSegment[]) {
    const shapeOk =
      seg && typeof seg.id === "string" && typeof seg.text === "string" &&
      Number.isFinite(seg.startMs) && Number.isFinite(seg.endMs) && Array.isArray(seg.words);
    if (!shapeOk) return null;
  }
  return { schemaVersion: 1, source: "funasr", segments: obj.segments };
}

function sameMeta(a: AsrCacheMeta, b: AsrCacheMeta): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.arollQuickHash === b.arollQuickHash &&
    a.hotwordsHash === b.hotwordsHash &&
    a.paramsVersion === b.paramsVersion
  );
}

/** 命中就返回盘上那份转写，任何一处对不上返回 null（调用方据此重跑 ASR） */
export async function readCachedAsr(dir: string, want: AsrCacheMeta): Promise<VideoTranscript | null> {
  let meta: AsrCacheMeta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, ASR_META_FILE), "utf-8")) as AsrCacheMeta;
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object" || !sameMeta(meta, want)) return null;
  try {
    return parseCachedTranscript(await fs.readFile(path.join(dir, ASR_OUT_FILE), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 作废 meta。**重跑 ASR 之前先调它**，与 `writeAsrCacheMeta` 一起构成
 * 「先作废 → 重算 → 再登记」这条写协议：任何一刻崩掉最多退化成下次没命中，
 * 绝不会留下一份「meta 说是这条素材、内容却是上一条」的错配缓存——那是最糟的一种错，
 * 它会静默地把别人的话剪进片子。
 */
export async function clearAsrCacheMeta(dir: string): Promise<void> {
  await fs.rm(path.join(dir, ASR_META_FILE), { force: true });
}

/** 登记：只在 `asr-out.json` 已经落定之后调（见 `clearAsrCacheMeta` 的写协议） */
export async function writeAsrCacheMeta(dir: string, meta: AsrCacheMeta): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, ASR_META_FILE), meta);
}
