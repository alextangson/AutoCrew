/**
 * Inbox Worker — 进程内单例**串行**执行器（spec §3.1「并发与恢复」）。
 *
 * TG 入站、启动补扫、手动重试、配置变更唤醒，全部只是「往同一条队列投递请求」，
 * 谁都不自己处理——处理永远单线程串行，所以不需要跨请求的 claim 锁，
 * 同一条链接并发到两次也不会被处理两遍。
 *
 * 真正的消化管线（抓取 → LLM 分流 → 落库）由 `processItem` 注入，B4 阶段填充；
 * 本模块只管：claim / lease / attempts / 状态落盘 / 退避重投。
 */
import {
  getItem,
  listItems,
  updateItem,
  type InboxItem,
  type InboxPatch,
  type InboxStage,
  type InboxVerdict,
} from "./inbox-store.js";

/** fetching 租约 10 分钟：超时即认为处理进程已死，可被回收重跑（§3.1） */
export const LEASE_MS = 10 * 60 * 1000;
/** failed 的尝试上限；超限停在 failed，不再自动重投（§3.1） */
export const MAX_ATTEMPTS = 3;

/** 管线回执：只描述「这次处理的结论」，attempts/retryable/lease 由 worker 派生 */
export interface ProcessResult {
  status: "digested" | "rejected" | "blocked" | "failed";
  stage?: InboxStage;
  verdict?: InboxVerdict;
  targetIds?: string[];
  errorCode?: string;
  failReason?: string;
}

export interface TimerHandle {
  cancel(): void;
}

export interface InboxWorkerDeps {
  /** 固定工作区（§2.1 targetWorkspaceId），不跟随「当前工作区」 */
  dataDir: string;
  processItem: (item: InboxItem) => Promise<ProcessResult>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** 台账写失败等自身故障的出口——不静默（默认 console.error） */
  onError?: (err: unknown, ctx: { phase: string; itemId?: string }) => void;
  /**
   * worker 每次成功写台账后的通知（claim / settle / wake 三处），SSE 视图刷新用。
   * 在写盘**之后**触发——消费方按 itemId 重读永远读到已落定的状态，不是中间态。
   * 监听者抛错走 onError，不影响处理。
   */
  onItemChanged?: (item: InboxItem) => void;
}

export interface InboxWorker {
  /** 投递一条已落盘的 item；同 id 在队列里只排一次 */
  enqueue(item: InboxItem): void;
  /** 人工/自动重试；attempts 超限的 item 会被 claim 门挡下（先 updateItem 清零才能救回） */
  requestRetry(id: string): void;
  /** 外部条件就绪（补了 key、换了引擎）→ 全部 blocked 重新排队；不计入 attempts */
  wakeBlocked(reason: string): void;
  /** 启动时回收过期 claim：把僵在 fetching 的 item 重置 pending，返回被回收的项 */
  reclaimExpiredClaims(): Promise<InboxItem[]>;
  /** 队列排空且无在途任务时 resolve（测试与优雅停机用） */
  idle(): Promise<void>;
  /** 停止投递并取消待触发的退避重投；在途的 processItem 不打断 */
  stop(): void;
}

type Task = { kind: "item"; id: string } | { kind: "wake"; reason: string };

/** 5s → 10s → 20s，封顶 5 分钟（attempts 上限 3，实际只会用到前两档） */
export function retryDelayMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
}

function leaseAlive(item: InboxItem, nowMs: number): boolean {
  if (!item.claimedAt) return false; // 没有 claimedAt 的 fetching 是脏记录，按过期处理
  const at = Date.parse(item.claimedAt);
  return !Number.isNaN(at) && nowMs - at < LEASE_MS;
}

/** claim 门：终态不重跑、租约未过期的 fetching 不抢、attempts 超限的 failed 不再自动跑 */
function isClaimable(item: InboxItem, nowMs: number): boolean {
  switch (item.status) {
    case "pending":
    case "blocked":
      return true;
    case "failed":
      return item.attempts < MAX_ATTEMPTS;
    case "fetching":
      return !leaseAlive(item, nowMs);
    case "digested":
    case "rejected":
      return false;
  }
}

/**
 * 结论 → 落盘补丁。claimedAt 一律清空（释放租约）；
 * blocked 把 attempts 回滚到 claim 前——等外部条件不算一次尝试（§3.1）。
 * stage/verdict/targetIds 只在本次有值时覆盖：`both` 的 checkpoint 要跨重试存活。
 */
function outcomePatch(result: ProcessResult, prevAttempts: number): InboxPatch {
  const patch: InboxPatch = {
    status: result.status,
    claimedAt: undefined,
    errorCode: result.errorCode,
    failReason: result.failReason,
    retryable: result.status === "blocked" || (result.status === "failed" && prevAttempts + 1 < MAX_ATTEMPTS),
  };
  if (result.stage !== undefined) patch.stage = result.stage;
  if (result.verdict !== undefined) patch.verdict = result.verdict;
  if (result.targetIds !== undefined) patch.targetIds = result.targetIds;
  if (result.status === "blocked") patch.attempts = prevAttempts;
  return patch;
}

function defaultTimer(fn: () => void, ms: number): TimerHandle {
  const t = setTimeout(fn, ms);
  t.unref?.(); // 退避重投不该拖住进程退出
  return { cancel: () => clearTimeout(t) };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 串行执行器本体。所有对外入口都只是 `post()` 一条任务，消费只有 `drain()` 这一条路径——
 * 「谁都不自己处理」的纪律靠这个不变量兜底。
 */
class SerialInboxWorker implements InboxWorker {
  private readonly queue: Task[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly timers = new Set<TimerHandle>();
  private readonly idleWaiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly onError: NonNullable<InboxWorkerDeps["onError"]>;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: InboxWorkerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? defaultTimer;
    this.onError =
      deps.onError ??
      ((err, ctx) =>
        console.error(`[inbox-worker] ${ctx.phase} 失败（${ctx.itemId ?? "-"}）：${errText(err)}`));
  }

  enqueue(item: InboxItem): void {
    this.post({ kind: "item", id: item.id });
  }

  requestRetry(id: string): void {
    this.post({ kind: "item", id });
  }

  wakeBlocked(reason: string): void {
    this.post({ kind: "wake", reason });
  }

  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) t.cancel();
    this.timers.clear();
    this.queue.length = 0;
    this.queuedIds.clear();
  }

  /**
   * 启动专用：直接读写台账、不排队——此刻还没有在途处理，不会和 claim 抢同一条。
   * 运行期不要调（会把别人正在跑的 fetching 掀掉）。
   */
  async reclaimExpiredClaims(): Promise<InboxItem[]> {
    const nowMs = this.now();
    const reclaimed: InboxItem[] = [];
    for (const item of await listItems(this.deps.dataDir)) {
      if (item.status !== "fetching" || leaseAlive(item, nowMs)) continue;
      const next = await updateItem(
        item.id,
        {
          status: "pending",
          claimedAt: undefined,
          failReason: `处理中断（租约 ${LEASE_MS / 60_000} 分钟未完成），已回收重排`,
        },
        this.deps.dataDir,
      );
      if (next) reclaimed.push(next);
    }
    return reclaimed;
  }

  private post(task: Task): void {
    if (this.stopped) return;
    if (task.kind === "item") {
      if (this.queuedIds.has(task.id)) return; // 重复投递合并成一次处理
      this.queuedIds.add(task.id);
    }
    this.queue.push(task);
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
        const task = this.queue.shift()!;
        if (task.kind === "item") this.queuedIds.delete(task.id);
        await this.runTask(task);
      }
    } finally {
      this.running = false;
      for (const wake of this.idleWaiters.splice(0)) wake();
    }
  }

  /** 单条任务的故障隔离：一条炸掉不能拖垮整条队列，但必须可见 */
  private async runTask(task: Task): Promise<void> {
    try {
      if (task.kind === "wake") await this.runWake(task.reason);
      else await this.runItem(task.id);
    } catch (err) {
      this.onError(err, { phase: task.kind, itemId: task.kind === "item" ? task.id : undefined });
    }
  }

  private async runItem(id: string): Promise<void> {
    const { dataDir, processItem } = this.deps;
    const item = await getItem(id, dataDir);
    if (!item || !isClaimable(item, this.now())) return;

    const prevAttempts = item.attempts;
    const claimed = await updateItem(
      id,
      { status: "fetching", claimedAt: new Date(this.now()).toISOString(), attempts: prevAttempts + 1 },
      dataDir,
    );
    if (!claimed) return;
    this.notifyChanged(claimed);

    let result: ProcessResult;
    try {
      result = await processItem(claimed);
    } catch (err) {
      // 管线抛错 = 可重试故障；错误可见地写进台账，不静默降级
      result = { status: "failed", errorCode: "process_threw", failReason: errText(err) };
    }
    const settled = await updateItem(id, outcomePatch(result, prevAttempts), dataDir);
    if (settled?.status === "failed" && settled.retryable) this.scheduleRetry(settled);
    this.notifyChanged(settled);
  }

  private notifyChanged(item: InboxItem | null): void {
    if (!item || !this.deps.onItemChanged) return;
    try {
      this.deps.onItemChanged(item);
    } catch (err) {
      this.onError(err, { phase: "on_item_changed", itemId: item.id });
    }
  }

  /** blocked → pending 显式落一行：台账里看得见「因为什么被唤醒」，视图也能立刻反映 */
  private async runWake(reason: string): Promise<void> {
    for (const item of await listItems(this.deps.dataDir)) {
      if (item.status !== "blocked") continue;
      const woken = await updateItem(
        item.id,
        { status: "pending", failReason: `外部条件已变更（${reason}），重新排队` },
        this.deps.dataDir,
      );
      this.notifyChanged(woken);
      this.post({ kind: "item", id: item.id });
    }
  }

  private scheduleRetry(item: InboxItem): void {
    // 回调体在赋值之后才会执行，闭包引用自身 handle 是安全的
    const handle: TimerHandle = this.setTimer(() => {
      this.timers.delete(handle);
      this.post({ kind: "item", id: item.id });
    }, retryDelayMs(item.attempts));
    this.timers.add(handle);
  }
}

export function createInboxWorker(deps: InboxWorkerDeps): InboxWorker {
  return new SerialInboxWorker(deps);
}

// --- 进程内单例（§2.1：worker 是 server 进程内全局单例） ---

let singleton: InboxWorker | null = null;

/** 首次调用建实例并锁定 deps；后续调用忽略新 deps，返回同一实例 */
export function getInboxWorker(deps: InboxWorkerDeps): InboxWorker {
  if (!singleton) singleton = createInboxWorker(deps);
  return singleton;
}

/** 测试与「配置变更热重启」用：停掉旧实例，下次 get 重建 */
export function resetInboxWorker(): void {
  singleton?.stop();
  singleton = null;
}
