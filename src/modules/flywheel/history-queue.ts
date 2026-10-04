/**
 * 历史记录相关写入的共用串行边界：建 / 删历史记录、无编号认领在同一进程内排一条队，
 * 否则并发的认领可能在删除之后又把认领写回去（Codex 评审 P1）。
 */
import { getDataDir } from "../../storage/local-store.js";

const historyChains = new Map<string, Promise<unknown>>();

export function serializeHistory<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = getDataDir(dataDir);
  const next = (historyChains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(() => undefined, () => undefined);
  historyChains.set(key, tail);
  void tail.then(() => { if (historyChains.get(key) === tail) historyChains.delete(key); });
  return next;
}
