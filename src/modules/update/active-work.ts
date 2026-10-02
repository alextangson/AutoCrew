/**
 * 本进程里正在跑的长任务（Codex 审第 2 轮 P1）：后台写稿 / 重写、封面与配图生图、公众号推送等。
 * 它们不登记对话轮、也不写 runs.json，所以要有一个统一的计数：每个长任务入口登记、结束释放；
 * 一键更新的预检、`/api/update/busy`、重启前确认都看它。更新锁在手时，新的长任务一律不开。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { updatingRefusal } from "./preflight.js";

const works = new Map<number, string>();
let seq = 0;

export function activeWorkCount(): number {
  return works.size;
}

export function activeWorkLabels(): string[] {
  return [...works.values()];
}

/**
 * 一次浏览器写请求已经整体算作「一件在跑的事」时，它里面再登记的同一件事（IPC 长通道、对话轮）不重复计数，
 * 否则一个对话轮会被说成「有 3 个任务正在跑」（e2e 1002 P3-G）。请求返回后还在后台跑的（trackWork）照常单算。
 */
const requestCtx = new AsyncLocalStorage<{ counted: true }>();
export function markRequestCounted(): void { requestCtx.enterWith({ counted: true }); }
export function insideCountedRequest(): boolean { return requestCtx.getStore()?.counted === true; }

/** 开一个长任务：正在更新就拒；返回 end（多次调用安全） */
export function beginWork(label: string): { ok: true; end: () => void } | { ok: false; error: string } {
  const refused = updatingRefusal();
  if (refused) return { ok: false, error: refused };
  if (insideCountedRequest()) return { ok: true, end: () => {} };
  const id = ++seq;
  works.set(id, label);
  return { ok: true, end: () => { works.delete(id); } };
}

/** 后台任务登记到 settle 为止（不管成功失败）；不做拒绝——拒绝在入口用 beginWork / assertNotUpdating 做 */
export function trackWork<T>(label: string, task: Promise<T>): Promise<T> {
  const id = ++seq;
  works.set(id, label);
  const done = () => { works.delete(id); };
  task.then(done, done);
  return task;
}

/** 入口闸：正在更新就抛（给 throw 风格的入口用） */
export function assertNotUpdating(): void {
  const refused = updatingRefusal();
  if (refused) throw new Error(refused);
}

/**
 * 服务里的定时周期用：正在更新就跳过这一拍（记一句日志，下一拍照常），否则登记成在跑直到这一拍结束。
 * 返回 null = 跳过了。
 */
export async function runUnlessUpdating<T>(label: string, fn: () => Promise<T>, log: (msg: string) => void = console.log): Promise<T | null> {
  const refused = updatingRefusal();
  if (refused) { log(`[update] 正在更新，这一拍「${label}」跳过，更新完下一拍照常跑`); return null; }
  // 先登记再起跑：fn 同步部分里看到的计数也已经包括自己
  const id = ++seq;
  works.set(id, label);
  try { return await fn(); } finally { works.delete(id); }
}

/** 只给测试 */
export function resetActiveWork(): void {
  works.clear();
}
