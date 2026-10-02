/**
 * Ctrl-C / SIGTERM / SIGHUP 落在更新中途（e2e P1-3、第 12 轮 P1）：不能就这么死掉留下半新半旧。
 * 第一次：请求中止——更新在下一个检查点停下，走正常退回（换回旧依赖、按安全规则退回代码），写结果、放锁再退出。
 * 之后再按：只提示「正在退回，请稍等」，不打断退回。
 */
/** 更新进程走到「新版已过健康检查、只剩收尾」：之后的 Ctrl-C 不再说「退回」 */
let finishing = false;
let restarting = false;
let rollingBack = false;
export function markFinishing(): void { finishing = true; }
/** 走到重启 / 健康检查：这一段不打断（检查不过本来就会自动退回），Ctrl-C 只说明情况 */
export function markRestarting(): void { restarting = true; }
/** 开始退回了：之后的 Ctrl-C 说「正在退回」，不再说新版在启动（第 17 轮 P3-3） */
export function markRollingBack(): void { restarting = false; finishing = false; rollingBack = true; }
/** 只给测试 */
export function resetFinishing(): void { finishing = false; restarting = false; rollingBack = false; }

export interface AbortHandle { signal: AbortSignal; onSignal: () => void; dispose: () => void }

export function createAbortHandle(write: (msg: string) => void = (m) => process.stderr.write(`${m}\n`)): AbortHandle {
  const controller = new AbortController();
  // 终端已经关了时写屏会出错（EIO / EPIPE）：说不出来也照样中止、照样退回，绝不能因为写屏把进程弄崩（第 12 轮 P1）
  const say = (m: string) => { try { write(m); } catch { /* 终端不在了 */ } };
  const onSignal = () => {
    if (rollingBack) { say("正在退回，请稍等"); return; }
    // 新版已经过了健康检查：没有可退回的了，接着收尾（e2e 1002b N3）
    if (finishing) { say("已经更新好了，正在收尾，不会退回，请稍等"); return; }
    if (restarting) { say("新版正在启动和检查，这一步不打断；检查不过会自动退回，请稍等"); return; }
    if (controller.signal.aborted) { say("正在退回，请稍等"); return; }
    say("收到中止：停下更新、退回原来的版本，别关窗口");
    controller.abort();
  };
  return { signal: controller.signal, onSignal, dispose: () => {} };
}

/** 接到进程信号上；dispose 摘掉 */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const swallow = () => { /* 终端关掉后的写屏错误：吞掉，退回照常跑完 */ };

/** 接到进程信号上（含 SIGHUP：关终端窗口 / ssh 断线也按中止走退回）；dispose 摘掉 */
export function installAbortHandlers(write?: (msg: string) => void): AbortHandle {
  const h = createAbortHandle(write);
  for (const s of SIGNALS) process.on(s, h.onSignal);
  process.stdout.on("error", swallow);
  process.stderr.on("error", swallow);
  return { ...h, dispose: () => { for (const s of SIGNALS) process.off(s, h.onSignal); } };
}
