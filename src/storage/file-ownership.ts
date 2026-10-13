/**
 * 文件归属事务互斥（spec §7，Codex P1-5）：资料库单写者锁只防两个进程，不防同进程并发。
 * record 落位、候选确认、登记提交、重开文稿、对账写入都排这一队。
 *
 * 锁顺序固定：文件归属事务 → series 锁 → 稿件写锁。本锁在同一异步调用链内可重入（AsyncLocalStorage），
 * 这样对账在循环里包一层、单条 record 再包一层也不会自己等自己；稿件写锁仍不可重入，事务内只用不取锁的原语。
 */
import { AsyncLocalStorage } from "node:async_hooks";

const owner = new AsyncLocalStorage<true>();
let tail: Promise<unknown> = Promise.resolve();

export function holdsFileOwnership(): boolean {
  return owner.getStore() === true;
}

export function withFileOwnership<T>(fn: () => Promise<T>): Promise<T> {
  if (holdsFileOwnership()) return fn();
  const run = () => owner.run(true, fn);
  const next = tail.then(run, run);
  tail = next.catch(() => undefined);
  return next;
}

/** 限时排队的结果：拿到锁跑完 → ran；等超时 → busy（fn 不会再跑） */
export type TimedOwnership<T> = { ran: true; value: T } | { ran: false; busy: true };

/**
 * 只读路径用的限时版（打开稿件的本条快扫）：排队最多等 waitMs；等不到就退出队列、fn 永不执行，
 * 由调用方把「没跑」报出来。后台长任务（NAS 备份 / 归档大项目能占锁很久）不该把读稿挂死。
 */
export function tryWithFileOwnership<T>(fn: () => Promise<T>, waitMs: number): Promise<TimedOwnership<T>> {
  if (holdsFileOwnership()) return fn().then((value) => ({ ran: true as const, value }));
  let state: "waiting" | "running" | "abandoned" = "waiting";
  const queued = withFileOwnership(async (): Promise<TimedOwnership<T>> => {
    if (state === "abandoned") return { ran: false, busy: true };
    state = "running";
    return { ran: true, value: await fn() };
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<TimedOwnership<T>>((resolve) => {
    timer = setTimeout(() => {
      if (state !== "waiting") return; // 已经拿到锁在跑：等它跑完，不半途丢下
      state = "abandoned";
      resolve({ ran: false, busy: true });
    }, waitMs);
  });
  return Promise.race([queued, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 在归属锁之外起一段异步工作（1b §3-9）：后台比对工人必须在干净的异步上下文里跑，
 * 否则它从 record 的锁里继承 `owner` 标记，落结果时的 `withFileOwnership` 会当成重入、不排队。
 */
export function outsideFileOwnership<T>(fn: () => T): T {
  return owner.exit(fn);
}
