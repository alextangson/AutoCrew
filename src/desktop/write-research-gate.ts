/**
 * 写作入口的调研闸口（深调研 §6 接线）——从灵感库开写时，没简报就先补一轮深调研再写。
 *
 * 闸口三纪律：
 * 1. **绝不阻断写作**：这个函数永不抛。触发被拒、调研失败、等到超时，一律收敛成一个
 *    outcome 交回写作执行体，稿子照写——闸口是给稿子垫底的增益，不是写作的前置条件，
 *    「调研机器坏了 → 今天一个字都写不出来」是不能接受的故障放大。
 * 2. **有旧简报直接用，不重跑**：`job.briefRevision` 是「当前有效简报」的唯一指针
 *    （台账 §2：重跑失败不回退指针），有指针就说明有简报能注入。简报是不是过期了由注入层
 *    标注，v1 不为「旧了」再烧一轮四视角——那是分钟级 + 联网花钱的事，得让人自己决定。
 * 3. **降级必留痕**：跑不了/失败/超时都带人话 note 回去，由写作侧 warn + 版本注记落痕。
 *    静默降级会让「这稿怎么这么水」查无可查。
 */
import { getDataDir } from "../storage/local-store.js";
import { getJob, isTerminalJobStatus } from "../modules/research/research-job-store.js";
import type { EnsureBriefOutcome } from "../modules/writing/generate-script.js";
import { emitEngineEvent } from "./event-hub.js";
import { triggerDeepResearch } from "./research-runtime.js";

/** 轮询间隔：四视角是分钟级任务，问得再勤也只是白读台账 */
const DEFAULT_POLL_MS = 5000;
/** 等待上限：超过就放行去写。宁可写一篇没简报的，也不让人盯着「生成中」等到怀疑死机 */
const DEFAULT_DEADLINE_MS = 12 * 60 * 1000;

/** 全是测试注入口；生产一个都不传，走真实现与真时钟 */
export interface WriteResearchGateOptions {
  pollMs?: number;
  deadlineMs?: number;
  getJobImpl?: typeof getJob;
  triggerImpl?: typeof triggerDeepResearch;
  emitImpl?: typeof emitEngineEvent;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
}

interface WaitContext {
  getJobImpl: typeof getJob;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs: number;
  deadlineMs: number;
}

/** 排队等简报这件事得让人看见——不然界面上只有一个不动的「生成中」，像卡死 */
async function announce(emit: typeof emitEngineEvent, dataDir: string): Promise<void> {
  try {
    await emit(
      { role: "scout", kind: "work", label: "调研员四视角侦察中，写稿排队等简报" },
      dataDir,
    );
  } catch {
    /* 观测层不得破坏执行层 */
  }
}

/** 盯台账等落定。终态有指针才算等到；没等到就照实说是失败还是超时 */
async function waitForBrief(topicId: string, dataDir: string, ctx: WaitContext): Promise<EnsureBriefOutcome> {
  const deadline = ctx.now() + ctx.deadlineMs;
  for (;;) {
    await ctx.sleep(ctx.pollMs);
    const job = await ctx.getJobImpl(topicId, dataDir);
    if (job && isTerminalJobStatus(job.status)) {
      if (job.briefRevision !== undefined) return { state: "ready" };
      return { state: "failed", note: job.failReason ?? job.errorCode ?? "调研失败" };
    }
    // 超时不等于失败：job 多半还在跑，下次开写就能用上它的简报
    if (ctx.now() >= deadline) return { state: "timeout" };
  }
}

/**
 * 造一个「开写前确保有简报」的闸口，注入给 startGenerateScript 的 deps。
 * dataDir 跟选题所在工作区走（与深调研运行时同一口径）。
 */
export function makeEnsureBrief(
  dataDir?: string,
  opts: WriteResearchGateOptions = {},
): (topicId: string) => Promise<EnsureBriefOutcome> {
  const getJobImpl = opts.getJobImpl ?? getJob;
  const trigger = opts.triggerImpl ?? triggerDeepResearch;
  const emit = opts.emitImpl ?? emitEngineEvent;
  const ctx: WaitContext = {
    getJobImpl,
    sleep: opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: opts.nowImpl ?? Date.now,
    pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
    deadlineMs: opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
  };

  return async (topicId: string): Promise<EnsureBriefOutcome> => {
    const dir = getDataDir(dataDir);
    try {
      const existing = await getJobImpl(topicId, dir);
      if (existing?.briefRevision !== undefined) return { state: "already" };
      const accepted = await trigger(topicId, dir);
      // 搜索 key 没配、运行时没起、选题不存在——投递口的人话理由原样带回去留痕
      if (!accepted.accepted) return { state: "unavailable", note: accepted.reason };
      await announce(emit, dir);
      return await waitForBrief(topicId, dir, ctx);
    } catch (err) {
      // 纪律 1 的兜底：台账读崩、依赖抛错，都只是「这轮没简报」，绝不冒泡进写作
      return { state: "unavailable", note: err instanceof Error ? err.message : String(err) };
    }
  };
}
