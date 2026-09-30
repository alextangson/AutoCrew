/**
 * 取一个作业的开头转写（1b §2）：先查按完整 sha 的缓存；没有才转写（不持任何锁）。
 * 没就绪 / 失败 / 超时 / 文件变了都回原因，不静默（E29、B2）。
 */
import fs from "node:fs/promises";
import type { Heard } from "./decide.js";
import { readTranscript, writeTranscript } from "./cache.js";
import { matchDeps } from "./deps.js";
import type { MatchJob } from "./queue.js";

/** uncached：转写回来了，但这期间文件被挪 / 改名 / 改了，文本没记进缓存（Codex 审 segB10 P2） */
export type Heard2 = Heard & { failed?: true; uncached?: true };

async function sameFile(job: MatchJob): Promise<boolean> {
  const st = await fs.stat(job.path).catch(() => null);
  return Boolean(st && st.size === job.size && Math.trunc(st.mtimeMs) === job.mtime_ms);
}

export async function hear(dataDir: string, job: MatchJob, signal: AbortSignal): Promise<Heard2> {
  const cached = await readTranscript(dataDir, job.sha256);
  if (cached) return { text: cached.text };
  const t = matchDeps().transcriber;
  const notReady = t.notReady ? await t.notReady(dataDir) : null;
  if (notReady) return { text: null, why: `转写环境没装好（${notReady}）` };
  if (!(await sameFile(job))) return { text: null, why: "核对期间文件变了或不见了", failed: true };
  const out = await t.transcribe(job.path, signal).catch((e: unknown) => ({ ok: false as const, unavailable: false, reason: e instanceof Error ? e.message : String(e) }));
  // 环境问题（ffmpeg 没了、预检之后 ASR 没了）不是这份文件的失败：不带 failed，后台作业停在「暂不可用」不计次（Codex 审 segB13 P2）
  if (!out.ok && out.unavailable && !signal.aborted) return { text: null, why: `转写环境没装好（${out.reason}）` };
  if (!out.ok) return { text: null, why: signal.aborted ? `转写超时（${out.reason}）` : `转写失败：${out.reason}`, failed: true };
  // 转写期间字节变了：这份文本不能记在旧 sha 名下
  if (!(await sameFile(job))) return { text: out.text, uncached: true };
  await writeTranscript(dataDir, job.sha256, out.text);
  return { text: out.text };
}
