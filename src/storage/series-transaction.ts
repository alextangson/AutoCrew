import { AsyncLocalStorage } from "node:async_hooks";
const ownership = new AsyncLocalStorage<boolean>();
let tail: Promise<unknown> = Promise.resolve();
/** Single writer process: review check + registration and all content writes share this queue. */
export function seriesTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (ownership.getStore()) return fn();
  const next = tail.then(() => ownership.run(true, fn), () => ownership.run(true, fn));
  tail = next.then(() => {}, () => {});
  return next;
}
