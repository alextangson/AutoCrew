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
