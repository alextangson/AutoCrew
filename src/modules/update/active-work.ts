/**
 * 本进程里正在跑的长任务（Codex 审第 2 轮 P1）：后台写稿 / 重写、封面与配图生图、公众号推送等。
 * 它们不登记对话轮、也不写 runs.json，所以要有一个统一的计数：每个长任务入口登记、结束释放；
 * 一键更新的预检、`/api/update/busy`、重启前确认都看它。更新锁在手时，新的长任务一律不开。
 */
import { updatingRefusal } from "./preflight.js";

const works = new Map<number, string>();
let seq = 0;

export function activeWorkCount(): number {
  return works.size;
}

export function activeWorkLabels(): string[] {
  return [...works.values()];
}

/** 开一个长任务：正在更新就拒；返回 end（多次调用安全） */
export function beginWork(label: string): { ok: true; end: () => void } | { ok: false; error: string } {
  const refused = updatingRefusal();
  if (refused) return { ok: false, error: refused };
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

/** 只给测试 */
export function resetActiveWork(): void {
  works.clear();
}
