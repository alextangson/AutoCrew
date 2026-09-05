/**
 * Research Runner — 深调研任务的进程内单例**串行**执行器（spec §2「执行」）。
 *
 * 选题卡按钮、总编辑 `deep_research` 工具、以后的托管触发，全部只是「投递一次任务」，
 * 谁都不自己跑：`trigger()` 落一条 queued 台账就返回（聊天绝不被调研阻塞），
 * 真正的四视角检索由 `runJob` 注入（W3 填），本模块只管
 * claim / lease / 状态落盘 / briefRevision 指针 / 启动回收。
 *
 * 同选题重复触发的防重是**两层**：投递口按台账拒（非终态一律「研究进行中」，
 * full 与 angles 共用这一道门），跨进程/重启靠 job 的 claimedAt lease（30 分钟）
 * ——台账那一眼拦不住「上一个进程崩在半路」，租约过期的 running 才允许被捡回重排。
 */
import { getTopic, updateTopic } from "../../storage/local-store.js";
import {
  getJob,
  isTerminalJobStatus,
  listJobs,
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type PerspectiveState,
  type ResearchJob,
  type ResearchJobKind,
} from "./research-job-store.js";

/** running 租约 30 分钟（§2）：超时即认为跑它的进程已死，可回收重排 */
export const RESEARCH_LEASE_MS = 30 * 60 * 1000;

/**
 * 一次调研的回执契约（W3 的返回值）：只描述「这轮跑出了什么」，
 * claimedAt/settledAt/指针推进规则由 runner 派生，W3 不用管。
 *
 * - `perspectives`：四视角的最终状态（失败的带 errorCode，供选题卡逐条点名）。
 * - `briefRevision`：本轮产出的简报版本；**只在 succeeded/partial 时被采纳**，
 *   failed 时给了也忽略——重跑失败不许把有效简报指针带回退（§2）。
 */
export interface JobOutcome {
  status: "succeeded" | "partial" | "failed";
  perspectives: PerspectiveState[];
  briefRevision?: number;
  errorCode?: string;
  failReason?: string;
}

export interface ResearchRunnerDeps {
  /** 选题所在工作区，不跟随「当前工作区」 */
  dataDir: string;
  runJob: (job: ResearchJob) => Promise<JobOutcome>;
  now?: () => number;
  /** 台账写失败等自身故障的出口——不静默（默认 console.error） */
  onError?: (err: unknown, ctx: { phase: string; topicId?: string }) => void;
  /**
   * 每次成功写台账后的通知（queued / running / settled 三处），SSE `research:updated` 用。
   * 在写盘**之后**触发——消费方按 topicId 重读永远读到已落定的状态，不是中间态。
   * 监听者抛错走 onError，不影响执行。
   */
  onJobChanged?: (job: ResearchJob) => void;
  /** 选题续期钩子（默认摸一下 topic.renewedAt）；测试打桩用 */
  renewTopic?: (topicId: string, dataDir: string) => Promise<void>;
}

/**
 * 投递结果。`accepted:false` = 连 job 都没落（选题没了 / 这条选题正在研究中）；
 * `inFlight:true` 是后者的判别位——调用方要说「研究进行中」而不是「投递失败」。
 * `deduped:true` = 捡回了一条**租约已过期**的 running（跑它的进程死了），没有新开一轮。
 */
export type TriggerResult =
  | { accepted: true; deduped: boolean; job: ResearchJob }
  | { accepted: false; reason: string; inFlight?: true };

export interface ResearchRunner {
  /**
   * 投递一次研究任务（`full` = 四视角深调研，`angles` = 只重跑立意）。
   * 同选题已有在途任务 → **拒绝**（不合并、不排队）：两种 kind 共用这一道门，
   * angles job 因此永远不会和 full job 抢同一条选题的简报指针（§3.5）。
   */
  trigger(topicId: string, kind?: ResearchJobKind): Promise<TriggerResult>;
  /** 启动用：回收 lease 过期的 running（→ queued）并把所有非终态 job 重新排队，返回被回收的项 */
  reclaimStaleJobs(): Promise<ResearchJob[]>;
  /** 队列排空且无在途任务时 resolve（测试与优雅停机用） */
  idle(): Promise<void>;
  /** 停止投递；在途的 runJob 不打断 */
  stop(): void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 默认续期实现：任务启动即给选题「续一次命」（§2），否则 3 天回收会把正在深调研的
 * 选题扫进回收站。灵感库的过期锚是 `renewedAt ?? createdAt`（见 topic-expiry）。
 */
async function touchTopic(topicId: string, dataDir: string): Promise<void> {
  await updateTopic(topicId, { renewedAt: new Date().toISOString() }, dataDir);
}

function leaseAlive(job: ResearchJob, nowMs: number): boolean {
  if (!job.claimedAt) return false; // 没有 claimedAt 的 running 是脏记录，按过期处理
  const at = Date.parse(job.claimedAt);
  return !Number.isNaN(at) && nowMs - at < RESEARCH_LEASE_MS;
}

/** claim 门：终态不重跑（重跑走 trigger 落新 job），租约未过期的 running 不抢 */
function isClaimable(job: ResearchJob, nowMs: number): boolean {
  if (job.status === "queued") return true;
  if (job.status === "running") return !leaseAlive(job, nowMs);
  return false;
}

/** 「这条选题正在研究中」的人话（chat 与 IPC 共用一句，别在别处再造一套） */
function inFlightReason(job: ResearchJob): string {
  const what = job.kind === "angles" ? "重新立意" : "深调研";
  const where = job.status === "queued" ? "还在队列里" : "正在跑";
  return `研究进行中：这条选题的${what}${where}，等它落定再派下一轮（进度在选题卡上）`;
}

/**
 * 回执 → 落定后的完整记录。claimedAt 清空（释放租约）；
 * briefRevision **只在 succeeded/partial 且本轮真出了简报时**推进，其余保留旧指针。
 *
 * angles job 多一道 **CAS**（§3.5/§5）：它是拿「起跑那一刻的简报」重算的卡，
 * 落定时指针要是已经被别人推过（跨进程的晚到结算、租约回收后的重排），
 * 这版卡就是长在旧简报上的——照推等于让**更新的**那版简报被旧立意覆盖。
 * 所以指针不等即作废：failed + `stale_pointer`，指针原样保留。
 * full job 语义不变：它自己产的是**新版**简报（revision 由 nextBriefRevision 现算，
 * 只会更大），推进不会把新的盖成旧的。
 */
function settledJob(
  claimed: ResearchJob,
  latest: ResearchJob,
  outcome: JobOutcome,
  settledAt: string,
): ResearchJob {
  const next: ResearchJob = {
    ...latest,
    status: outcome.status,
    settledAt,
    claimedAt: undefined,
    perspectives: outcome.perspectives,
    errorCode: outcome.errorCode,
    failReason: outcome.failReason,
  };
  if (outcome.status === "failed" || outcome.briefRevision === undefined) return next;
  if (claimed.kind === "angles" && latest.briefRevision !== claimed.briefRevision) {
    return {
      ...next,
      status: "failed",
      errorCode: "stale_pointer",
      failReason: `这轮立意基于简报 v${claimed.briefRevision ?? "-"}，落定时生效的已经是 v${latest.briefRevision ?? "-"}——本轮结果作废，请在新简报上重新立意`,
    };
  }
  next.briefRevision = outcome.briefRevision;
  return next;
}

class SerialResearchRunner implements ResearchRunner {
  private readonly queue: string[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly idleWaiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly onError: NonNullable<ResearchRunnerDeps["onError"]>;
  private readonly renewTopic: NonNullable<ResearchRunnerDeps["renewTopic"]>;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: ResearchRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.renewTopic = deps.renewTopic ?? touchTopic;
    this.onError =
      deps.onError ??
      ((err, ctx) =>
        console.error(`[research-runner] ${ctx.phase} 失败（${ctx.topicId ?? "-"}）：${errText(err)}`));
  }

  async trigger(topicId: string, kind: ResearchJobKind = "full"): Promise<TriggerResult> {
    const { dataDir } = this.deps;
    const topic = await getTopic(topicId, dataDir);
    if (!topic) return { accepted: false, reason: `选题不存在：${topicId}` };
    if (topic.deletedAt) {
      return { accepted: false, reason: `选题已在回收站，先恢复再深调研：${topicId}` };
    }

    const existing = await getJob(topicId, dataDir);
    if (existing && !isTerminalJobStatus(existing.status)) {
      // 真的有人在跑（排队中 / 租约还活着）：**拒**，两种 kind 同一道门（§3.5）——
      // 合并成同一条 job 会让「重新立意」悄悄变成「深调研」（反之亦然），
      // 而并排两条 job 又会让两轮结算抢同一个简报指针
      if (existing.status === "queued" || leaseAlive(existing, this.now())) {
        return { accepted: false, reason: inFlightReason(existing), inFlight: true };
      }
      // running 但租约过期 = 跑它的进程已经死了：把这条捡回队列重跑，不新开一轮
      // （它自己的 kind 说了算——半路换 kind 等于凭空改写一条在册任务）
      await this.renewOnce(topicId); // 真的要跑了，选题照样续一次命
      this.post(topicId);
      return { accepted: true, deduped: true, job: existing };
    }

    const job: ResearchJob = {
      topicId,
      status: "queued",
      ...(kind === "angles" ? { kind } : {}),
      startedAt: this.nowIso(),
      // angles job 不跑视角：空数组是它的正确形状，不是「四路都还没开始」
      perspectives: kind === "angles" ? [] : pendingPerspectives(),
      topicHash: topicHashOf(topic.title, topic.description),
      // 重跑期间旧简报继续有效：指针跟着新 job 走，不因为「又开了一轮」而失效
      // （对 angles job 这还是 CAS 的起点：落定时拿它跟当前指针比）
      ...(existing?.briefRevision !== undefined ? { briefRevision: existing.briefRevision } : {}),
    };
    await this.write(job);
    await this.renewOnce(topicId);
    this.post(topicId);
    return { accepted: true, deduped: false, job };
  }

  /**
   * 启动专用：此刻还没有在途处理，直接读写台账不会和 claim 抢同一条。
   * 过期 running → queued（可见标注），随后把**所有非终态 job**重新排队——
   * 崩在 queued 的那些没人回收，只能靠这轮补扫。运行期不要调。
   */
  async reclaimStaleJobs(): Promise<ResearchJob[]> {
    const nowMs = this.now();
    const reclaimed: ResearchJob[] = [];
    for (const job of await listJobs(this.deps.dataDir)) {
      if (isTerminalJobStatus(job.status)) continue;
      if (job.status === "running" && !leaseAlive(job, nowMs)) {
        reclaimed.push(
          await this.write({
            ...job,
            status: "queued",
            claimedAt: undefined,
            failReason: `处理中断已回收（租约 ${RESEARCH_LEASE_MS / 60_000} 分钟未完成），已重新排队`,
          }),
        );
      }
      this.post(job.topicId);
    }
    return reclaimed;
  }

  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.queuedIds.clear();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** 唯一写账口：写盘 → 通知。顺序反过来的话消费方重读会抢到中间态 */
  private async write(job: ResearchJob): Promise<ResearchJob> {
    const saved = await upsertJob(job, this.deps.dataDir);
    if (this.deps.onJobChanged) {
      try {
        this.deps.onJobChanged(saved);
      } catch (err) {
        this.onError(err, { phase: "on_job_changed", topicId: saved.topicId });
      }
    }
    return saved;
  }

  /** 续期失败不该拖垮投递：任务照跑，故障从 onError 冒出来（最坏结果是选题被 3 天回收） */
  private async renewOnce(topicId: string): Promise<void> {
    try {
      await this.renewTopic(topicId, this.deps.dataDir);
    } catch (err) {
      this.onError(err, { phase: "renew_topic", topicId });
    }
  }

  private post(topicId: string): void {
    if (this.stopped) return;
    if (this.queuedIds.has(topicId)) return; // 重复投递合并成一次处理
    this.queuedIds.add(topicId);
    this.queue.push(topicId);
    void this.drain();
  }

  /**
   * 单一消费者：running 期间任何 post 都只是入队，由本循环继续吃掉。
   * while 判断与 running=false 之间没有 await，不存在「刚投递就漏跑」的窗口。
   */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const topicId = this.queue.shift()!;
        this.queuedIds.delete(topicId);
        try {
          await this.runTopic(topicId);
        } catch (err) {
          // 一条炸掉（多半是台账写不进去）不能拖垮整条队列，但必须可见
          this.onError(err, { phase: "run_job", topicId });
        }
      }
    } finally {
      this.running = false;
      for (const wake of this.idleWaiters.splice(0)) wake();
    }
  }

  private async runTopic(topicId: string): Promise<void> {
    const job = await getJob(topicId, this.deps.dataDir);
    if (!job || !isClaimable(job, this.now())) return;

    const claimed = await this.write({ ...job, status: "running", claimedAt: this.nowIso() });
    let outcome: JobOutcome;
    try {
      outcome = await this.deps.runJob(claimed);
    } catch (err) {
      // 管线抛错 = 这轮失败；错误可见地写进台账，不静默降级
      outcome = {
        status: "failed",
        perspectives: claimed.perspectives,
        errorCode: "run_threw",
        failReason: errText(err),
      };
    }
    // 落定前**重读**台账：这轮跑了几分钟，期间可能有人往这条记录上打过标
    // （回流轮的 originConversationId 就是聊天那边事后回填的）。拿 claim 那一刻的快照
    // 去写等于把这些标悄悄抹掉——状态与视角仍以本轮 outcome 为准，其余字段照最新的走。
    const latest = (await getJob(topicId, this.deps.dataDir)) ?? claimed;
    // 选题中途被删由 W3 报错上来（failed），本层不特判：台账照常落定，简报文件保留
    await this.write(settledJob(claimed, latest, outcome, this.nowIso()));
  }
}

export function createResearchRunner(deps: ResearchRunnerDeps): ResearchRunner {
  return new SerialResearchRunner(deps);
}

// --- 进程内单例（§2：runner 是 server 进程内全局单例） ---

let singleton: ResearchRunner | null = null;

/** 首次调用建实例并锁定 deps；后续调用忽略新 deps，返回同一实例 */
export function getResearchRunner(deps: ResearchRunnerDeps): ResearchRunner {
  if (!singleton) singleton = createResearchRunner(deps);
  return singleton;
}

/** 测试与「工作区切换热重启」用：停掉旧实例，下次 get 重建 */
export function resetResearchRunner(): void {
  singleton?.stop();
  singleton = null;
}
