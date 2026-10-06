/**
 * 安全巡检（手动收件 spec 2026-10-06 规则 3）：启动一次 + 每 30 分钟，对账项目文件夹（换掉 / 删掉的文件、登记），
 * 再把创始人在「我的内容」里的改动同步回来。对话里「同步一下」立即跑一次。
 *
 * 单飞：正在跑时再叫 = 等这一轮的结果（不叠第二轮）。更新进行中跳过（runUnlessUpdating）；与 NAS 归档共用进程内互斥。
 * 出错不吞：返回值带错误，定时器记日志，对话里原样给创始人。
 */
import { getDataDir } from "../../storage/local-store.js";
import { syncMyContentView } from "../../storage/my-content-view.js";
import { runExclusive } from "../../storage/storage-mutex.js";
import { runUnlessUpdating } from "../update/active-work.js";
import { reconcileAll } from "./reconcile.js";

export const SWEEP_INTERVAL_MS = 30 * 60_000;

export interface SweepResult {
  /** 更新进行中，这一轮没跑 */
  skipped?: true;
  /** 对账没跑成（整轮失败）的原因 */
  error?: string;
  errors: Array<{ title: string; error: string }>;
  warnings: string[];
  /** 「我的内容」视图同步出错的地方 */
  view_errors: string[];
}

export type SweepRunner = (dataDir: string) => Promise<SweepResult>;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function sweepOnce(dataDir: string): Promise<SweepResult> {
  const out = await runUnlessUpdating("我的内容对账", () => runExclusive(async (): Promise<SweepResult> => {
    // 先对账再排文件夹（本体 §4）：未启用本体时对账只算影子差异、不写
    const r = await reconcileAll(dataDir).then((x) => ({ ok: true as const, x }), (e: unknown) => ({ ok: false as const, error: msg(e) }));
    // 「我的内容」是全库一份视图、归默认工作区所有（syncMyContentView 不传 dataDir = 默认工作区）：
    // 不管从哪个工作区触发都只同步它，别的工作区不能改写这份视图和它的清单
    const view = await syncMyContentView().then((v) => v.errors, (e: unknown) => [`我的内容没同步成：${msg(e)}`]);
    return r.ok
      ? { errors: r.x.errors.map((e) => ({ title: e.title, error: e.error })), warnings: r.x.warnings, view_errors: view }
      : { error: r.error, errors: [], warnings: [], view_errors: view };
  }));
  return out ?? { skipped: true, errors: [], warnings: [], view_errors: [] };
}

let runner: SweepRunner = sweepOnce;
const inFlight = new Map<string, Promise<SweepResult>>();

/** 测试注入；null = 恢复真巡检 */
export function setSweepRunner(fn: SweepRunner | null): void { runner = fn ?? sweepOnce; }

/** 跑一轮巡检（单飞：同一工作区正在跑就等它，返回同一份结果，joined=true） */
export async function runSweep(dataDir = getDataDir()): Promise<SweepResult & { joined?: true }> {
  const running = inFlight.get(dataDir);
  if (running) return { ...(await running), joined: true };
  const p = runner(dataDir).finally(() => inFlight.delete(dataDir));
  inFlight.set(dataDir, p);
  return p;
}

/** 最近一次定时巡检没跑起来的原因（比如资料库断开）；对话里 sync 一并给出，跑成一次就清掉 */
let scheduledError: { at: string; error: string } | null = null;
export function sweepHealth(): { at: string; error: string } | null { return scheduledError; }

function logResult(r: SweepResult): void {
  scheduledError = r.error ? { at: new Date().toISOString(), error: r.error } : null;
  if (r.error) console.error("[production] 对账失败:", r.error);
  if (r.errors.length) console.error(`[production] 对账有 ${r.errors.length} 条失败:${r.errors[0].title} ${r.errors[0].error}`);
  if (r.view_errors.length) console.error(`[my-content] 对账有 ${r.view_errors.length} 处出错:${r.view_errors[0]}`);
}

/** 守护进程用：启动跑一轮，之后每 30 分钟一轮。返回定时器（stop 时清掉） */
export function startSweepLoop(dataDir: () => string = () => getDataDir(), timers: { setInterval: typeof setInterval } = { setInterval }): NodeJS.Timeout {
  // 工作区在已捕获的异步链里解析：资料库断开时 getDataDir() 抛错只记下来，不把守护进程带走
  const tick = () => {
    void Promise.resolve().then(() => runSweep(dataDir())).then(logResult, (e: unknown) => {
      scheduledError = { at: new Date().toISOString(), error: msg(e) };
      console.error("[my-content] 对账失败:", msg(e));
    });
  };
  tick();
  const t = timers.setInterval(tick, SWEEP_INTERVAL_MS);
  t.unref?.();
  return t;
}
