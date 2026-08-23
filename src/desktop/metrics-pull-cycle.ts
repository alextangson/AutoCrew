/**
 * 三平台自动回流的进程内调度（spec §4.3）——照 managed-host/radar-cycle 的范式：
 * 进程活着才滚，进程一关全停，不在用户机器上留后台任务。
 *
 * 一轮 tick = 读状态 → 按平台判「该不该抓」→ 命中的**串行**抓（平台间 ≥10s）。
 * 判据三道门：开关 / nextEligibleAt（退避）/ TTL（12h 内抓过就不重抓）+ 当日 ≤2 次红线。
 *
 * 写序（spec §4.3）：**先入库 outcomes，后写状态**。两写之间崩溃 → 状态偏旧 → 下轮按 TTL
 * 重抓 → 幂等键去重吸收。一致性靠幂等重放，不靠事务；状态写失败会如实报出来，不静默。
 *
 * single-flight 在本模块按平台统一管理：手动 IPC 与定时 tick 走同一入口 `pullPlatformNow`，
 * 同平台并发直接返回 in_flight——前端按钮置灰只是 UX，不是正确性来源（codex #19）。
 */
import {
  PULL_PLATFORMS,
  PULL_PLATFORM_LABELS,
  localDay,
  readPullState,
  updatePlatformPullState,
  type PlatformPullState,
  type PullPlatform,
} from "../modules/flywheel/pull-state.js";
import { importPerformanceRows } from "../modules/flywheel/row-import.js";
import type { PullResult, PullStatus } from "../adapters/browser/pull-types.js";
import { emitEngineEvent } from "./event-hub.js";

/** 30 分钟一 tick：比 12h TTL 密得多（错过窗口最多迟到半小时），又不至于让 tick 变噪音 */
export const METRICS_PULL_TICK_MS = 30 * 60_000;
/** 默认 TTL 12h：保守默认值（社区经验，不是事实断言，spec §0） */
export const PULL_TTL_MS = 12 * 3_600_000;
/** 平台间隔：不并发打三家后台 */
export const PLATFORM_GAP_MS = 10_000;
export const MAX_AUTO_PULLS_PER_DAY = 2;
export const MAX_FAILURES_PER_DAY = 3;
const RETRY_BACKOFF_MS = 3_600_000;
const NEXT_DAY_HOUR = 9;

export type PullTrigger = "auto" | "manual";

/** 一次抓取的结果快照（IPC 直接回给前端；status=in_flight 表示被单飞拦下，没真抓） */
export interface PullAttempt {
  platform: PullPlatform;
  status: PullStatus | "in_flight";
  rowCount: number;
  /** 真正入账的行数（rowCount 是抓回来的行数，两者可能因行级 rejected 不等） */
  imported?: number;
  errorCode?: string;
  /** 抓到分页上限：「至少还有更多」，不谎报精确丢弃数（codex #23） */
  hasMore?: boolean;
  /** 入库成功但状态没写住：下轮会重抓，重复导入无害——如实报出来，不静默 */
  persistError?: string;
}

export type PullFn = () => Promise<PullResult>;

export interface MetricsPullDeps {
  /** 抓取器注入点：默认动态 import 三个真实抓取器（测试塞假的，不连浏览器） */
  registry?: Partial<Record<PullPlatform, PullFn>>;
  importRows?: typeof importPerformanceRows;
  emit?: typeof emitEngineEvent;
  now?: () => Date;
  ttlMs?: number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (msg: string) => void;
}

export interface PullNowOptions extends MetricsPullDeps {
  dataDir?: string;
  trigger?: PullTrigger;
}

/** 默认抓取器：动态 import，测试与非视频线路径不为它们付启动成本（同 topic-radar 的手法） */
const DEFAULT_REGISTRY: Record<PullPlatform, PullFn> = {
  douyin: async () => (await import("../adapters/browser/douyin-stats.js")).pullDouyinStats(),
  wechat_video: async () => (await import("../adapters/browser/wechat-video-stats.js")).pullWechatVideoStats(),
  xiaohongshu: async () => (await import("../adapters/browser/xhs-stats.js")).pullXhsStats(),
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 纯函数：调度判定与状态推进（fake timer 下可直接锁行为） ────────────────────

/** 次日 09:00（本地时区）——「等人明早扫码」的锚点 */
export function nextDayAtNine(now: Date): string {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, NEXT_DAY_HOUR, 0, 0, 0);
  return next.toISOString();
}

export function isPullDue(state: PlatformPullState, now: Date, ttlMs = PULL_TTL_MS): boolean {
  if (!state.enabled) return false;
  if (state.nextEligibleAt && Date.parse(state.nextEligibleAt) > now.getTime()) return false;
  if (state.lastSuccessAt && now.getTime() - Date.parse(state.lastSuccessAt) <= ttlMs) return false;
  // 当日自动抓取红线：手动触发不计数，人明确要抓时不该被红线拦
  if (state.autoAttemptDate === localDay(now) && state.autoAttemptCount >= MAX_AUTO_PULLS_PER_DAY) return false;
  return true;
}

interface Landing {
  status: PullStatus;
  rowCount: number;
  imported?: number;
  errorCode?: string;
  batchId?: string;
  hasMore?: boolean;
}

/** 结果 → 下一份平台状态。退避语义全在这里，一个 switch 看全（spec §4.3） */
export function applyPullOutcome(
  prev: PlatformPullState,
  landing: Landing,
  now: Date,
  trigger: PullTrigger,
  ttlMs = PULL_TTL_MS,
): PlatformPullState {
  const day = localDay(now);
  const next: PlatformPullState = {
    ...prev,
    lastAttemptAt: now.toISOString(),
    lastStatus: landing.status,
    autoAttemptDate: trigger === "auto" ? day : prev.autoAttemptDate,
    autoAttemptCount:
      trigger === "auto" ? (prev.autoAttemptDate === day ? prev.autoAttemptCount + 1 : 1) : prev.autoAttemptCount,
  };
  if (landing.errorCode) next.lastErrorCode = landing.errorCode;
  else delete next.lastErrorCode;

  if (landing.status === "ok") {
    next.lastSuccessAt = now.toISOString();
    next.lastRowCount = landing.rowCount;
    next.failureCount = 0;
    next.failureDate = null;
    next.nextEligibleAt = new Date(now.getTime() + ttlMs).toISOString();
    if (landing.batchId) next.lastBatchId = landing.batchId;
    return next;
  }
  // needs_login 不算失败（等人扫码）；risk_control 当日不再碰这家——两者都锚到次日 09:00
  if (landing.status === "needs_login" || landing.status === "risk_control") {
    next.nextEligibleAt = nextDayAtNine(now);
    return next;
  }
  // 浏览器连不上是环境问题，不记到平台头上（三家都会是这个状态，记了只是三份噪音）
  if (landing.status === "browser_unreachable") {
    next.nextEligibleAt = new Date(now.getTime() + RETRY_BACKOFF_MS).toISOString();
    return next;
  }
  next.failureCount = prev.failureDate === day ? prev.failureCount + 1 : 1;
  next.failureDate = day;
  next.nextEligibleAt =
    next.failureCount >= MAX_FAILURES_PER_DAY
      ? nextDayAtNine(now)
      : new Date(now.getTime() + RETRY_BACKOFF_MS).toISOString();
  return next;
}

// ── 抓取执行 ─────────────────────────────────────────────────────────────────

function labelOf(platform: PullPlatform): string {
  return PULL_PLATFORM_LABELS[platform];
}

/** 事件文案：一行人话，说清发生了什么、人要不要动手（Report 页与工作日志共用） */
function eventLabel(attempt: PullAttempt): string {
  const name = labelOf(attempt.platform);
  switch (attempt.status) {
    case "ok":
      return `自动回流：${name} 抓回 ${attempt.rowCount} 条，入账 ${attempt.imported ?? 0} 条`;
    case "needs_login":
      return `${name}登录态过期——扫码后数据继续回流`;
    case "risk_control":
      return `${name}触发风控，今天不再自动抓取`;
    case "browser_unreachable":
      return "浏览器未连接（chrome-cdp），自动回流本轮暂停";
    case "schema_changed":
      return `${name}后台接口变了（${attempt.errorCode ?? "schema"}），本次零写入`;
    case "timeout":
      return `${name}抓取超时，稍后重试`;
    default:
      return `${name}抓取失败：${attempt.errorCode ?? "unknown"}`;
  }
}

/** 抓取器调用：抛错也要收敛成结构化状态码，绝不让异常穿出调度层 */
async function callFetcher(platform: PullPlatform, opts: PullNowOptions): Promise<PullResult> {
  const fetcher = opts.registry?.[platform] ?? DEFAULT_REGISTRY[platform];
  try {
    return await fetcher();
  } catch (err) {
    const code = err instanceof Error ? err.message.slice(0, 60) : "unknown";
    return { status: "error", rows: [], errorCode: `pull_threw:${code}` };
  }
}

/** 先入库后写状态：入库失败就当整次抓取失败（零写入），不给「抓到了但没落地」留模糊地带 */
async function land(platform: PullPlatform, result: PullResult, now: Date, opts: PullNowOptions): Promise<Landing> {
  const base: Landing = {
    status: result.status,
    rowCount: result.status === "ok" ? result.rows.length : 0,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.hasMore ? { hasMore: true } : {}),
  };
  if (result.status !== "ok" || result.rows.length === 0) return base;
  const batchId = `pull-${platform}-${now.getTime()}`;
  try {
    const report = await (opts.importRows ?? importPerformanceRows)(platform, result.rows, {
      source: "auto",
      dataDir: opts.dataDir,
    });
    return { ...base, imported: report.imported, batchId };
  } catch (err) {
    opts.warn?.(`[metrics-pull] ${platform} 入库失败：${err instanceof Error ? err.message : String(err)}`);
    return { status: "error", rowCount: 0, errorCode: "import_failed" };
  }
}

async function runPull(platform: PullPlatform, opts: PullNowOptions): Promise<PullAttempt> {
  const now = opts.now?.() ?? new Date();
  const trigger = opts.trigger ?? "manual";
  const landing = await land(platform, await callFetcher(platform, opts), now, opts);

  let persistError: string | undefined;
  try {
    await updatePlatformPullState(
      platform,
      (prev) => applyPullOutcome(prev, landing, now, trigger, opts.ttlMs ?? PULL_TTL_MS),
      opts.dataDir,
    );
  } catch (err) {
    persistError = err instanceof Error ? err.message : String(err);
  }

  const attempt: PullAttempt = {
    platform,
    status: landing.status,
    rowCount: landing.rowCount,
    ...(landing.imported !== undefined ? { imported: landing.imported } : {}),
    ...(landing.errorCode ? { errorCode: landing.errorCode } : {}),
    ...(landing.hasMore ? { hasMore: true } : {}),
    ...(persistError ? { persistError } : {}),
  };
  const emit = opts.emit ?? emitEngineEvent;
  void emit(
    {
      role: "analyst",
      kind: "metrics_pull",
      label: persistError ? `${eventLabel(attempt)}（状态未写住，下轮会重抓）` : eventLabel(attempt),
      metricsPull: { platform, status: attempt.status, rowCount: attempt.rowCount },
    },
    opts.dataDir,
  ).catch(() => {
    /* 观测层不得破坏执行层 */
  });
  return attempt;
}

// ── single-flight（手动与定时同一把锁） ──────────────────────────────────────

const inFlight = new Set<string>();

function flightKey(dataDir: string | undefined, platform: PullPlatform): string {
  return `${dataDir ?? "default"}:${platform}`;
}

export function inFlightPlatforms(dataDir?: string): PullPlatform[] {
  return PULL_PLATFORMS.filter((p) => inFlight.has(flightKey(dataDir, p)));
}

/** 手动 IPC 与定时 tick 的唯一入口：同平台并发直接返回 in_flight，不排队也不重复抓 */
export async function pullPlatformNow(platform: PullPlatform, opts: PullNowOptions = {}): Promise<PullAttempt> {
  const key = flightKey(opts.dataDir, platform);
  if (inFlight.has(key)) return { platform, status: "in_flight", rowCount: 0 };
  inFlight.add(key);
  try {
    return await runPull(platform, opts);
  } finally {
    inFlight.delete(key);
  }
}

// ── tick 与生命周期 ──────────────────────────────────────────────────────────

export async function runMetricsPullTick(dataDir?: string, deps: MetricsPullDeps = {}): Promise<PullAttempt[]> {
  const now = deps.now?.() ?? new Date();
  const state = await readPullState(dataDir, deps.warn);
  const due = PULL_PLATFORMS.filter((p) => isPullDue(state.platforms[p], now, deps.ttlMs ?? PULL_TTL_MS));
  const attempts: PullAttempt[] = [];
  for (const platform of due) {
    // 串行 + 间隔：不并发打三家后台（风控面最小）
    if (attempts.length > 0) await (deps.sleep ?? defaultSleep)(deps.gapMs ?? PLATFORM_GAP_MS);
    const attempt = await pullPlatformNow(platform, { ...deps, dataDir, trigger: "auto" });
    attempts.push(attempt);
    // 浏览器都连不上，逐个试只是白等 10 秒 × N，还把三家的状态刷成同一句废话
    if (attempt.status === "browser_unreachable") break;
  }
  return attempts;
}

export interface StartMetricsPullCycleOptions extends MetricsPullDeps {
  resolveDataDir: () => Promise<string | undefined>;
  tickIntervalMs?: number;
  /** 每轮跑完的回调（失败轮给空数组）：让「这一轮到底跑没跑完」可观测，而不是只能猜 */
  onTick?: (attempts: PullAttempt[]) => void;
}

/** 启动即跑一轮，之后每 30 分钟一轮；返回 stop（server close 时调用） */
export function startMetricsPullCycle(options: StartMetricsPullCycleOptions): () => void {
  const tickIntervalMs = Math.max(60_000, options.tickIntervalMs ?? METRICS_PULL_TICK_MS);
  let stopped = false;
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    let attempts: PullAttempt[] = [];
    try {
      attempts = await runMetricsPullTick(await options.resolveDataDir(), options);
    } catch (error) {
      console.error("[metrics-pull] tick 失败:", error instanceof Error ? error.message : error);
    } finally {
      ticking = false;
      options.onTick?.(attempts);
    }
  };
  const timer = setInterval(() => void tick(), tickIntervalMs);
  timer.unref(); // 定时器不该成为进程退不掉的理由
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
