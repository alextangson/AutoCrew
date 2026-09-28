/** 进程内互斥：「我的内容」对账和 NAS 归档不能同时碰同一个项目，排队一个一个来。 */
let tail: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn);
  tail = next.catch(() => undefined);
  return next;
}
