/**
 * Ctrl-C / SIGTERM 落在更新中途（e2e P1-3）：不能就这么死掉留下半新半旧。
 * 第一次：请求中止——更新在下一个检查点停下，走正常退回（换回旧依赖、按安全规则退回代码），写结果、放锁再退出。
 * 之后再按：只提示「正在退回，请稍等」，不打断退回。
 */
export interface AbortHandle { signal: AbortSignal; onSignal: () => void; dispose: () => void }

export function createAbortHandle(write: (msg: string) => void = (m) => process.stderr.write(`${m}\n`)): AbortHandle {
  const controller = new AbortController();
  const onSignal = () => {
    if (controller.signal.aborted) { write("正在退回，请稍等"); return; }
    write("收到中止：停下更新、退回原来的版本，别关窗口");
    controller.abort();
  };
  return { signal: controller.signal, onSignal, dispose: () => {} };
}

/** 接到进程信号上；dispose 摘掉 */
export function installAbortHandlers(write?: (msg: string) => void): AbortHandle {
  const h = createAbortHandle(write);
  process.on("SIGINT", h.onSignal);
  process.on("SIGTERM", h.onSignal);
  return { ...h, dispose: () => { process.off("SIGINT", h.onSignal); process.off("SIGTERM", h.onSignal); } };
}
