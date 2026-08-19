/**
 * 后台任务的进程内互斥（对话控制面设计 §Phase 2 / codex #16）。
 *
 * 对话里「再帮我做一次封面」很容易连点两下——查一下在不在跑再决定投不投，中间隔着
 * await，两次调用会双双查到「没在跑」然后各起一个任务。所以 claim 必须是
 * **同一同步 tick 内的 check-and-register**：`claimJob` 里没有任何 await，
 * 第二次调用在第一次返回后立刻就能看到已占位。
 *
 * 生命周期：claim 持有到后台任务 settle（成功/失败/同步抛）——`holdJobUntilSettled`
 * 把释放挂在任务的 finally 上；投递本身就没起来时调用方 finally 释放。
 * 进程内 Map 是刻意的：任务本身也活在这个进程里，进程没了任务也没了。
 */

const claimed = new Set<string>();

/** 同步 check-and-register。true = 占位成功（本次投递归你），false = 已经在跑。 */
export function claimJob(key: string): boolean {
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
}

export function releaseJob(key: string): void {
  claimed.delete(key);
}

export function isJobClaimed(key: string): boolean {
  return claimed.has(key);
}

/** 把 claim 绑到后台任务上：无论成功、失败还是拒绝，settle 即释放。 */
export function holdJobUntilSettled(key: string, task: Promise<unknown>): void {
  void task.then(
    () => releaseJob(key),
    () => releaseJob(key),
  );
}
