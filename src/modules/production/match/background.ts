/**
 * 自己去找的比对（1b §4 / §5 / §6）：对账 tick 只发现与入队，不等转写完成。
 *
 * 作业只负责把开头转写放进按完整 sha 的缓存（同一份字节只转写一次，收件箱 / 监视文件夹 / 导出目录共用）；
 * 判定每个 tick 用缓存转写对当时的池重算——池变了（新稿认稿、正文改了）只重打分，不重转（§2）。
 * 失败按队列退避（1 小时后，最多 3 次），之后停在可见的失败态。
 */
import { readTranscript } from "./cache.js";
import { decide, type Heard, type MatchDecision, type PoolEntry } from "./decide.js";
import { matchDeps } from "./deps.js";
import { hear } from "./hear.js";
import { enqueueMatchJob, registerMatchHandler, requeueMatchJob, type Priority } from "./queue.js";

export const TRANSCRIBE = "transcribe_head";

registerMatchHandler(TRANSCRIBE, async ({ dataDir, job, signal }) => {
  const h = await hear(dataDir, job, signal);
  // 转写期间文件被挪 / 改名：没进缓存就不是「已缓存」——停在可重来的状态，不计次；新路径上再发现时重新排上
  if (h.text !== null && h.uncached) return { state: "unavailable", reason: "转写期间文件被挪了或改名了，等重新发现" };
  if (h.text !== null) return { state: "done", outcome: "转写已缓存" };
  if (h.failed) return { state: "retry", error: h.why };
  // 转写临时没就绪：不是终态，恢复后再来（Codex 审 segB6 P2）
  return { state: "unavailable", reason: h.why };
});

export interface Found { file: string; name: string; sha256: string; size: number; mtime_ms: number }

export type Verdict =
  | { kind: "decided"; d: MatchDecision; note?: string }
  | { kind: "checking" }
  | { kind: "failed"; reason: string };

/**
 * 一个文件现在能下什么结论：L1 唯一强命中 → 直接判；缓存里有转写 → 按当前池判；转写没就绪 / 不许转写 → 只比文件名（带原因）；
 * 否则入队（低优先级）等下一轮，失败到头了给「没核对成」。
 */
export async function fileVerdict(dataDir: string, f: Found, pool: readonly PoolEntry[], opts: { transcribe: boolean; why?: string; priority?: Priority } = { transcribe: true }): Promise<Verdict> {
  const t = matchDeps().thresholds;
  const nameOnly = (why: string): Verdict => ({ kind: "decided", d: decide({ fileName: f.name, sha256: f.sha256, pool, heard: { text: null, why } }, t) });
  const byName = nameOnly("还没转写");
  if (byName.kind === "decided" && byName.d.winner) return byName;
  const cached = await readTranscript(dataDir, f.sha256);
  if (cached) return { kind: "decided", d: decide({ fileName: f.name, sha256: f.sha256, pool, heard: { text: cached.text } satisfies Heard }, t) };
  if (!opts.transcribe) return nameOnly(opts.why ?? "没转写");
  const tr = matchDeps().transcriber;
  const notReady = tr.notReady ? await tr.notReady(dataDir) : null;
  if (notReady) return nameOnly(`转写环境没装好（${notReady}）`);
  const prev = await enqueueMatchJob(dataDir, { purpose: TRANSCRIBE, priority: opts.priority ?? "background", sha256: f.sha256, path: f.file, size: f.size, mtime_ms: f.mtime_ms, target: "head", payload: {} });
  const job = prev;
  if (job.state === "failed") return { kind: "failed", reason: job.error ?? "转写失败" };
  // 持续暂不可用（Codex 审 segB14 P2）：这一批先按文件名判、把原因带出去，不挡整批；一小时后再试
  if (job.state === "unavailable") return { ...nameOnly(job.error ?? "转写环境没装好"), note: job.error ?? "转写环境没装好" } as Verdict;
  // 已判但缓存里没有（缓存被清 / 当初没写上）：重新排，不让「只比了文件名」变成永久结论（Codex 审 segB10 P2）
  if (job.state === "done" && (await requeueMatchJob(dataDir, job.id))) return { kind: "checking" };
  if (job.state === "done") return nameOnly(job.outcome ?? "没转写");
  // 失败过、在退避等重试（冷启动第一次转写超时最常见）：这一小时算「没核对成」，看得见原因，不挡整批（verifier 2a P2）
  if (job.state === "queued" && job.attempts > 0 && job.error) return { kind: "failed", reason: `转写没成（${job.error}），只比了文件名，稍后自动再试` };
  return { kind: "checking" };
}
