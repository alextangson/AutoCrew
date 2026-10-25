/**
 * 账号级每日快照的抓取（管线重规划 §4、§8-9）：挂在作品抓取同一轮、同一把单飞锁后面，结果单独记健康。
 *
 * - 作品抓取遇到 要登录 / 风控 / 浏览器连不上：账号这次不再打开后台（同一个登录态、同一个浏览器），健康照实记成同一个状态。
 * - 其余情况（含作品抓取出错）：隔一段时间后单独开一次后台首页，只读页面自己收到的概览响应。
 * - 写序同作品：先入账（account-snapshots.jsonl），后写健康（account-pull.json）。
 */
import { isAccountPlatform, pullAccountStats, type AccountPlatform, type AccountPullResult } from "../adapters/browser/account-stats.js";
import type { PullStatus } from "../adapters/browser/pull-types.js";
import { appendSnapshots, toSnapshots, updateAccountPullHealth, type AccountPullHealth } from "../modules/flywheel/account-snapshots.js";

export type AccountFn = () => Promise<AccountPullResult>;

export interface AccountAttempt {
  status: PullStatus;
  days: number;
  errorCode?: string;
}

interface AccountDeps {
  dataDir?: string;
  registry?: Partial<Record<string, unknown>>;
  accountRegistry?: Partial<Record<string, AccountFn>>;
  sleep?: (ms: number) => Promise<void>;
  gapMs?: number;
  warn?: (msg: string) => void;
}

const SHARED_SESSION_STOPS: ReadonlySet<string> = new Set(["needs_login", "risk_control", "browser_unreachable"]);
const ACCOUNT_GAP_MS = 10_000;

async function fetchAccount(platform: AccountPlatform, deps: AccountDeps): Promise<AccountPullResult> {
  const fn = deps.accountRegistry?.[platform] ?? (() => pullAccountStats(platform));
  try {
    return await fn();
  } catch (err) {
    return { status: "error", rows: [], account: null, errorCode: `pull_threw:${err instanceof Error ? err.message.slice(0, 60) : "unknown"}` };
  }
}

/** 没接账号抓取的平台（视频号）返回 undefined：首页按「还不能抓账号数据」说 */
export async function runAccountPull(platform: string, workStatus: PullStatus, now: Date, deps: AccountDeps): Promise<AccountAttempt | undefined> {
  if (!isAccountPlatform(platform)) return undefined;
  // 注入了假作品抓取器（测试）却没注入账号抓取器：不去开真浏览器
  if (deps.registry?.[platform] && !deps.accountRegistry?.[platform]) return undefined;
  const at = now.toISOString();
  let result: AccountPullResult;
  if (SHARED_SESSION_STOPS.has(workStatus)) {
    result = { status: workStatus, rows: [], account: null, errorCode: "same_as_work_pull" };
  } else {
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(deps.gapMs ?? ACCOUNT_GAP_MS);
    result = await fetchAccount(platform, deps);
  }
  let days = 0;
  let status = result.status;
  let errorCode = result.errorCode;
  if (result.status === "ok") {
    try {
      const rows = toSnapshots(platform, result.rows, result.account, at);
      await appendSnapshots(rows, deps.dataDir);
      days = rows.length;
    } catch (err) {
      status = "error";
      errorCode = err instanceof Error && err.message.startsWith("library_writer_lost") ? "library_writer_lost" : "import_failed";
    }
  }
  const health = (prev: AccountPullHealth | null): AccountPullHealth => ({
    lastAttemptAt: at,
    lastSuccessAt: status === "ok" ? at : prev?.lastSuccessAt ?? null,
    lastStatus: status,
    ...(errorCode ? { lastErrorCode: errorCode } : {}),
    ...(status === "ok" ? { lastDays: days } : prev?.lastDays !== undefined ? { lastDays: prev.lastDays } : {}),
  });
  try {
    await updateAccountPullHealth(platform, health, deps.dataDir);
  } catch (err) {
    (deps.warn ?? console.warn)(`[account-pull] ${platform} 健康状态没写住：${err instanceof Error ? err.message : String(err)}`);
  }
  return { status, days, ...(errorCode ? { errorCode } : {}) };
}
