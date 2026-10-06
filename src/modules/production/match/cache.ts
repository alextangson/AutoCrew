/**
 * 转写缓存（1b §2，§14-9）的读方：自动找原片停用后不再写入，只读旧缓存给对话里的原片候选带开头一句。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getWorkspaceCacheDir } from "../../../storage/storage-roots.js";
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
