/**
 * 启动回收（设计 spec §3 纪律 3）——runner 的一块，与 runner-preview / runner-cleanup 同款切法。
 *
 * 回收要覆盖两种「上次崩在半路」：
 * 1. **有 job 行的**：心跳过期 10 分钟的 running → 同阶段重排 + attempts+1。
 * 2. **没有 job 行的**：ingest 不开 job（§3 只有五个 phase 值得开），崩在那儿就没人管它。
 *    用 `state.updatedAt` 兜底：running 且超过一个 lease 没动过 = 上次崩了。
 *    **有活 job 的 content 一律跳过**——长渲染的 state.updatedAt 本来就不会动，
 *    照着它回收会把正在出帧的渲染当成死的。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isContentId } from "../../storage/entity-id.js";
import {
  appendVideoJob,
  latestJobsView,
  readVideoJobs,
  readVideoState,
  recoverExpiredJobs,
  VIDEO_LEASE_MS,
} from "./video-store.js";
import type { VideoJob, VideoState } from "./types.js";

export interface RecoverDeps {
  dataDir: string;
  nowMs: () => number;
  writeState: (contentId: string, mutate: (cur: VideoState | null) => VideoState) => Promise<VideoState>;
  enqueue: (contentId: string) => void;
  /** 预览 job 的回收另有语义（不自动重排，只把「没跑完」说出来） */
  recoverPreview: (job: VideoJob) => Promise<void>;
}

async function requeueJob(ctx: RecoverDeps, job: VideoJob): Promise<void> {
  if (job.phase === "cut_preview") return ctx.recoverPreview(job);
  await appendVideoJob(ctx.dataDir, {
    ...job,
    status: "queued",
    attempts: job.attempts + 1,
    leaseOwner: undefined,
    claimedAt: undefined,
    heartbeatAt: undefined,
  });
  const { state } = await readVideoState(ctx.dataDir, job.contentId);
  if (state?.state === "running") await ctx.writeState(job.contentId, (cur) => ({ ...cur!, state: "queued" }));
  ctx.enqueue(job.contentId);
}

async function recoverStuckStates(ctx: RecoverDeps, skip: Set<string>): Promise<number> {
  let ids: string[];
  try {
    ids = await fs.readdir(path.join(ctx.dataDir, "contents"));
  } catch {
    return 0;
  }
  let count = 0;
  for (const contentId of ids) {
    // contents/ 下混着 .DS_Store 之类的东西；非法 id 会让 readVideoState 直接抛
    if (skip.has(contentId) || !isContentId(contentId)) continue;
    const { state } = await readVideoState(ctx.dataDir, contentId);
    if (!state || state.state !== "running") continue;
    if (ctx.nowMs() - Date.parse(state.updatedAt || "") <= VIDEO_LEASE_MS) continue;
    await ctx.writeState(contentId, (cur) => ({ ...cur!, state: "queued" }));
    ctx.enqueue(contentId);
    count += 1;
  }
  return count;
}

/** 返回回收条数（job 行 + state 兜底两类之和） */
export async function recoverExpired(ctx: RecoverDeps): Promise<number> {
  const jobs = await readVideoJobs(ctx.dataDir);
  const expired = recoverExpiredJobs(jobs, ctx.nowMs());
  const expiredIds = new Set(expired.map((j) => j.contentId));
  for (const job of expired) await requeueJob(ctx, job);
  const live = latestJobsView(jobs)
    .filter((j) => j.status === "running" && !expiredIds.has(j.contentId))
    .map((j) => j.contentId);
  return expired.length + (await recoverStuckStates(ctx, new Set([...expiredIds, ...live])));
}
