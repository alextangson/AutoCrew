/**
 * 交接线按稿件串行（P6 §8「双击 / 重试」）：同一篇的 handoff / revoke / register 排队跑。
 *
 * 不复用 store 的 `serializeContentWrite`：这几个动作内部还要调 `updateContent` /
 * `transitionStatus`，那两者自己会取那把锁——套在同一把锁里就是自己等自己。
 * 两把锁的关系是固定的「外层交接线锁 → 内层稿件写锁」，不会反向，所以不会死锁。
 * 双击第二下排在第一下之后，进门先查重放，拿到的是第一下的结果。
 */
const chains = new Map<string, Promise<unknown>>();

export function serializeVideoLine<T>(contentId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(contentId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const settled = run.catch(() => undefined);
  chains.set(contentId, settled);
  void settled.then(() => {
    if (chains.get(contentId) === settled) chains.delete(contentId);
  });
  return run;
}
