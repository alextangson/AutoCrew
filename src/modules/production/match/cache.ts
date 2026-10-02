/**
 * 转写缓存（1b §2，§14-9）：键 = 文件的**完整 sha256**（不用 quickHash——它不覆盖等长中段修改）。
 * 每份字节内容只转写一次。只存转写文本与时长，放本机工作区缓存目录：不进资料库、不进仓库。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getWorkspaceCacheDir } from "../../../storage/storage-roots.js";
import { writeJsonAtomicMkdir } from "../../../storage/json-atomic.js";
import { CLIP_SECONDS } from "./l2.js";

export interface CachedTranscript { sha256: string; text: string; clip_seconds: number; duration_ms?: number; at: string }

const SHA = /^[a-f0-9]{64}$/;

export function transcriptCacheDir(dataDir: string): string {
  return path.join(getWorkspaceCacheDir(dataDir), "aroll-transcripts");
}

function fileOf(dataDir: string, sha: string): string {
  if (!SHA.test(sha)) throw new Error(`转写缓存键不是完整 sha256：${sha.slice(0, 16)}`);
  return path.join(transcriptCacheDir(dataDir), `${sha}.json`);
}

export async function readTranscript(dataDir: string, sha: string): Promise<CachedTranscript | null> {
  try {
    const v = JSON.parse(await fs.readFile(fileOf(dataDir, sha), "utf8")) as CachedTranscript;
    return v.sha256 === sha && typeof v.text === "string" && v.clip_seconds === CLIP_SECONDS ? v : null;
  } catch { return null; }
}

export async function writeTranscript(dataDir: string, sha: string, text: string, durationMs?: number): Promise<void> {
  const v: CachedTranscript = { sha256: sha, text, clip_seconds: CLIP_SECONDS, ...(durationMs ? { duration_ms: durationMs } : {}), at: new Date().toISOString() };
  await writeJsonAtomicMkdir(fileOf(dataDir, sha), v);
}
