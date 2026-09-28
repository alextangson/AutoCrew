/**
 * 系列登记锁（spec 2026-09-28 §3 B「核对加登记要一步完成」）。
 *
 * 两类动作共用这一把进程内锁：
 * - 稿件状态进入系列白名单（draft_ready…published）——也就是「进入快照范围」；
 * - 审稿结论落地前核对「快照有没有过时」再登记。
 * 这样核对和登记之间不会被另一条稿插进来。锁可重入（同一异步调用链内嵌套直接执行）。
 * 加锁顺序固定为：写手队列 → 系列锁 → 单稿写锁；transitionStatus 在取单稿写锁之前取本锁。
 * 单写者前提：同一资料目录只由一个 AutoCrew 进程写（见 profile-writer-lock）。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const SERIES_STATES: ReadonlySet<string> = new Set(["draft_ready", "approved", "editing", "publish_ready", "publishing", "published"]);

const owner = new AsyncLocalStorage<true>();
let tail: Promise<unknown> = Promise.resolve();

export function seriesTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (owner.getStore()) return fn();
  const run = () => owner.run(true, fn);
  const next = tail.then(run, run);
  tail = next.then(() => undefined, () => undefined);
  return next;
}
