/**
 * 调度语义锁（回流 spec §4.3）：TTL 门 / 退避状态机 / single-flight / 写序。
 * 全程注入假抓取器（不连浏览器）+ 注入 now/sleep（不等真时间）；
 * 生命周期那一组用 fake timer 验「启动跑一轮 + 30 分钟再一轮 + stop 后不再跑」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  METRICS_PULL_TICK_MS,
  PLATFORM_GAP_MS,
  applyPullOutcome,
  isPullDue,
  nextDayAtNine,
  pullPlatformNow,
  runMetricsPullTick,
  startMetricsPullCycle,
  type MetricsPullDeps,
} from "./metrics-pull-cycle.js";
import {
  PULL_STATE_FILE,
  defaultPlatformState,
  readPullState,
  writePullState,
  type PlatformPullState,
  type PullPlatform,
} from "../modules/flywheel/pull-state.js";
import type { PullResult, TypedRow } from "../adapters/browser/pull-types.js";
import type { ImportReport } from "../modules/flywheel/row-import.js";

let dir: string;

const NOW = new Date(2026, 7, 23, 14, 0, 0); // 本地时区 2026-08-23 14:00
const ROWS: TypedRow[] = [
  { title: "视频一", publishedAt: "2026-08-20T10:00:00.000Z", platformItemId: "i1", metrics: { views: 100 } },
];

const okResult = (rows = ROWS): PullResult => ({ status: "ok", rows });
const fail = (status: PullResult["status"], errorCode?: string): PullResult => ({
  status,
  rows: [],
  ...(errorCode ? { errorCode } : {}),
});

function report(over: Partial<ImportReport> = {}): ImportReport {
  return { total: 1, imported: 1, replaced: 0, matched: 1, historical: 0, needsReview: [], rejected: [], ...over };
}

/** 默认注入：假抓取器 + 假入库 + 假事件 + 固定 now + 零等待 */
function deps(over: Partial<MetricsPullDeps> = {}): MetricsPullDeps {
  return {
    registry: {},
    importRows: vi.fn(async () => report()),
    emit: vi.fn(async () => ({ ts: NOW.toISOString(), role: "analyst" as const, kind: "metrics_pull", label: "x" })),
    now: () => NOW,
    sleep: vi.fn(async () => {}),
    warn: () => {},
    ...over,
  };
}

async function seed(platform: PullPlatform, over: Partial<PlatformPullState> = {}): Promise<void> {
  const state = await readPullState(dir);
  state.platforms[platform] = { ...defaultPlatformState(), enabled: true, ...over };
  await writePullState(state, dir);
}

const stateOf = async (platform: PullPlatform): Promise<PlatformPullState> =>
  (await readPullState(dir)).platforms[platform];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pull-cycle-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

// ── 纯函数：判定与退避 ───────────────────────────────────────────────────────

describe("isPullDue — 三道门", () => {
  const base = (over: Partial<PlatformPullState> = {}): PlatformPullState => ({
    ...defaultPlatformState(),
    enabled: true,
    ...over,
  });

  it("没开开关 = 永不自动抓", () => {
    expect(isPullDue(base({ enabled: false }), NOW)).toBe(false);
  });

  it("TTL 门：12h 内成功过就不重抓，超过才抓", () => {
    const sixHoursAgo = new Date(NOW.getTime() - 6 * 3_600_000).toISOString();
    const thirteenHoursAgo = new Date(NOW.getTime() - 13 * 3_600_000).toISOString();
    expect(isPullDue(base({ lastSuccessAt: sixHoursAgo }), NOW)).toBe(false);
    expect(isPullDue(base({ lastSuccessAt: thirteenHoursAgo }), NOW)).toBe(true);
  });

  it("nextEligibleAt 未到 = 退避中，不抓", () => {
    const later = new Date(NOW.getTime() + 3_600_000).toISOString();
    expect(isPullDue(base({ nextEligibleAt: later }), NOW)).toBe(false);
  });

  it("当日自动抓取满 2 次 = 红线拦下（次日重新计数）", () => {
    expect(isPullDue(base({ autoAttemptDate: "2026-08-23", autoAttemptCount: 2 }), NOW)).toBe(false);
    expect(isPullDue(base({ autoAttemptDate: "2026-08-23", autoAttemptCount: 1 }), NOW)).toBe(true);
    expect(isPullDue(base({ autoAttemptDate: "2026-08-22", autoAttemptCount: 9 }), NOW)).toBe(true);
  });
});

describe("applyPullOutcome — 退避状态机", () => {
  const prev = { ...defaultPlatformState(), enabled: true };

  it("ok：记成功时间/行数/批次，失败计数清零，下次 = now + TTL", () => {
    const next = applyPullOutcome(prev, { status: "ok", rowCount: 7, imported: 7, batchId: "b1" }, NOW, "auto");
    expect(next.lastSuccessAt).toBe(NOW.toISOString());
    expect(next.lastRowCount).toBe(7);
    expect(next.lastBatchId).toBe("b1");
    expect(next.failureCount).toBe(0);
    expect(Date.parse(next.nextEligibleAt!) - NOW.getTime()).toBe(12 * 3_600_000);
  });

  it("needs_login 不算失败：计数不动，下次 = 次日 09:00", () => {
    const withFailures = { ...prev, failureCount: 2, failureDate: "2026-08-23" };
    const next = applyPullOutcome(withFailures, { status: "needs_login", rowCount: 0 }, NOW, "auto");
    expect(next.failureCount).toBe(2);
    expect(next.nextEligibleAt).toBe(nextDayAtNine(NOW));
    expect(new Date(next.nextEligibleAt!).getHours()).toBe(9);
  });

  it("risk_control：当日不再碰这家 —— 下次 = 次日 09:00，失败计数不叠", () => {
    const next = applyPullOutcome(prev, { status: "risk_control", rowCount: 0, errorCode: "461" }, NOW, "auto");
    expect(next.nextEligibleAt).toBe(nextDayAtNine(NOW));
    expect(next.failureCount).toBe(0);
    expect(next.lastErrorCode).toBe("461");
  });

  it("browser_unreachable：环境问题不记到平台头上，1 小时后再试", () => {
    const next = applyPullOutcome(prev, { status: "browser_unreachable", rowCount: 0 }, NOW, "auto");
    expect(next.failureCount).toBe(0);
    expect(Date.parse(next.nextEligibleAt!) - NOW.getTime()).toBe(3_600_000);
  });

  it("普通失败：+1 退 1 小时；当日第 3 次 → 次日 09:00", () => {
    const one = applyPullOutcome(prev, { status: "timeout", rowCount: 0 }, NOW, "auto");
    expect(one.failureCount).toBe(1);
    expect(Date.parse(one.nextEligibleAt!) - NOW.getTime()).toBe(3_600_000);
    const two = applyPullOutcome(one, { status: "timeout", rowCount: 0 }, NOW, "auto");
    const three = applyPullOutcome(two, { status: "error", rowCount: 0 }, NOW, "auto");
    expect(three.failureCount).toBe(3);
    expect(three.nextEligibleAt).toBe(nextDayAtNine(NOW));
  });

  it("跨日重置失败计数（本地日期锚）", () => {
    const yesterday = { ...prev, failureCount: 3, failureDate: "2026-08-22" };
    const next = applyPullOutcome(yesterday, { status: "timeout", rowCount: 0 }, NOW, "auto");
    expect(next.failureCount).toBe(1);
    expect(next.failureDate).toBe("2026-08-23");
  });

  it("只有自动抓取计入当日红线，手动不计", () => {
    const auto = applyPullOutcome(prev, { status: "ok", rowCount: 1 }, NOW, "auto");
    expect(auto.autoAttemptCount).toBe(1);
    const manual = applyPullOutcome(auto, { status: "ok", rowCount: 1 }, NOW, "manual");
    expect(manual.autoAttemptCount).toBe(1);
  });
});

// ── 抓取 → 入库 → 落状态 ────────────────────────────────────────────────────

describe("pullPlatformNow — 入库与状态", () => {
  it("ok：rows 走 importPerformanceRows(source=auto)，状态记行数与批次", async () => {
    const importRows = vi.fn(async () => report({ imported: 1 }));
    const attempt = await pullPlatformNow("douyin", {
      dataDir: dir,
      trigger: "auto",
      ...deps({ registry: { douyin: async () => okResult() }, importRows }),
    });
    expect(attempt.status).toBe("ok");
    expect(attempt.rowCount).toBe(1);
    expect(attempt.imported).toBe(1);
    expect(importRows).toHaveBeenCalledWith("douyin", ROWS, { source: "auto", dataDir: dir });
    const state = await stateOf("douyin");
    expect(state.lastStatus).toBe("ok");
    expect(state.lastRowCount).toBe(1);
    expect(state.lastBatchId).toMatch(/^pull-douyin-/);
  });

  it("hasMore 一路带到结果里（界面只说「还有更多」）", async () => {
    const attempt = await pullPlatformNow("douyin", {
      dataDir: dir,
      ...deps({ registry: { douyin: async () => ({ status: "ok", rows: ROWS, hasMore: true }) } }),
    });
    expect(attempt.hasMore).toBe(true);
  });

  it("抓取器抛异常也收敛成结构化状态码，不穿出调度层", async () => {
    const attempt = await pullPlatformNow("xiaohongshu", {
      dataDir: dir,
      ...deps({
        registry: {
          xiaohongshu: async () => {
            throw new Error("socket hang up");
          },
        },
      }),
    });
    expect(attempt.status).toBe("error");
    expect(attempt.errorCode).toContain("pull_threw");
  });

  it("入库失败 = 整次抓取失败（零写入），不留「抓到了但没落地」的模糊态", async () => {
    const attempt = await pullPlatformNow("douyin", {
      dataDir: dir,
      ...deps({
        registry: { douyin: async () => okResult() },
        importRows: vi.fn(async () => {
          throw new Error("outcomes 写失败");
        }),
      }),
    });
    expect(attempt.status).toBe("error");
    expect(attempt.errorCode).toBe("import_failed");
    expect((await stateOf("douyin")).lastSuccessAt).toBeNull();
  });

  it("每次抓取都发事件，带 platform/status/rowCount", async () => {
    const emit = vi.fn(async () => ({ ts: "", role: "analyst" as const, kind: "metrics_pull", label: "" }));
    await pullPlatformNow("wechat_video", {
      dataDir: dir,
      ...deps({ registry: { wechat_video: async () => fail("needs_login") }, emit }),
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(event.kind).toBe("metrics_pull");
    expect(event.metricsPull).toEqual({ platform: "wechat_video", status: "needs_login", rowCount: 0 });
    expect(String(event.label)).toContain("视频号");
  });

  it("single-flight：同平台并发只真抓一次，后到的直接拿 in_flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = vi.fn(async () => {
      await gate;
      return okResult();
    });
    const options = { dataDir: dir, ...deps({ registry: { douyin: fetcher } }) };
    const first = pullPlatformNow("douyin", options);
    const second = await pullPlatformNow("douyin", options);
    expect(second.status).toBe("in_flight");
    release();
    expect((await first).status).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("single-flight 跨入口：手动抓着的时候，定时 tick 不重复打这家", async () => {
    await seed("douyin");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = vi.fn(async () => {
      await gate;
      return okResult();
    });
    const shared = deps({ registry: { douyin: fetcher } });
    const manual = pullPlatformNow("douyin", { dataDir: dir, trigger: "manual", ...shared });
    const ticked = await runMetricsPullTick(dir, shared);
    expect(ticked.map((a) => a.status)).toEqual(["in_flight"]);
    release();
    await manual;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("写序：入库成功但状态没写住 → 如实报出来，下轮重抓（幂等重放兜住）", async () => {
    // 把状态文件位置占成目录：入库照常，落状态必失败
    await fs.mkdir(path.join(dir, PULL_STATE_FILE));
    const importRows = vi.fn(async () => report());
    const shared = deps({ registry: { douyin: async () => okResult() }, importRows });
    const first = await pullPlatformNow("douyin", { dataDir: dir, trigger: "auto", ...shared });
    expect(first.status).toBe("ok");
    expect(first.persistError).toBeTruthy();

    // 障碍移除后状态仍是「从没成功过」→ 下一轮照抓，同一批行再进一次漏斗（幂等去重是漏斗的事）
    await fs.rmdir(path.join(dir, PULL_STATE_FILE));
    await seed("douyin");
    const attempts = await runMetricsPullTick(dir, shared);
    expect(attempts.map((a) => a.status)).toEqual(["ok"]);
    expect(importRows).toHaveBeenCalledTimes(2);
    expect(importRows.mock.calls[0][1]).toEqual(importRows.mock.calls[1][1]);
  });
});

// ── tick 编排 ────────────────────────────────────────────────────────────────

describe("runMetricsPullTick — 编排", () => {
  it("只抓到点的平台，串行且平台间隔 ≥10s", async () => {
    await seed("douyin");
    await seed("xiaohongshu");
    const sleep = vi.fn(async () => {});
    const attempts = await runMetricsPullTick(
      dir,
      deps({
        registry: { douyin: async () => okResult(), xiaohongshu: async () => okResult() },
        sleep,
      }),
    );
    expect(attempts.map((a) => a.platform)).toEqual(["douyin", "xiaohongshu"]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(PLATFORM_GAP_MS);
  });

  it("browser_unreachable：本 tick 剩下的平台直接跳过，不逐个白等", async () => {
    await seed("douyin");
    await seed("wechat_video");
    await seed("xiaohongshu");
    const others = vi.fn(async () => okResult());
    const attempts = await runMetricsPullTick(
      dir,
      deps({
        registry: {
          douyin: async () => fail("browser_unreachable", "cdp_unreachable"),
          wechat_video: others,
          xiaohongshu: others,
        },
      }),
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("browser_unreachable");
    expect(others).not.toHaveBeenCalled();
  });

  it("risk_control 当日停：同一天再 tick 一次也不碰这家", async () => {
    await seed("xiaohongshu");
    const fetcher = vi.fn(async () => fail("risk_control", "461"));
    const shared = deps({ registry: { xiaohongshu: fetcher } });
    await runMetricsPullTick(dir, shared);
    expect((await stateOf("xiaohongshu")).nextEligibleAt).toBe(nextDayAtNine(NOW));
    const second = await runMetricsPullTick(dir, shared);
    expect(second).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("needs_login 不算失败：状态记扫码态，失败计数保持 0", async () => {
    await seed("douyin");
    await runMetricsPullTick(dir, deps({ registry: { douyin: async () => fail("needs_login") } }));
    const state = await stateOf("douyin");
    expect(state.lastStatus).toBe("needs_login");
    expect(state.failureCount).toBe(0);
    expect(state.nextEligibleAt).toBe(nextDayAtNine(NOW));
  });

  it("当日自动抓取 ≤2 次：第 3 轮直接不出手", async () => {
    // 两次都失败(不改 lastSuccessAt)且 nextEligibleAt 已过 —— 只剩红线能拦住它
    await seed("douyin", { autoAttemptDate: "2026-08-23", autoAttemptCount: 2, failureCount: 1 });
    const fetcher = vi.fn(async () => okResult());
    const attempts = await runMetricsPullTick(dir, deps({ registry: { douyin: fetcher } }));
    expect(attempts).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("手动触发无视 nextEligibleAt（人明确要抓），也不吃当日红线", async () => {
    await seed("douyin", {
      nextEligibleAt: new Date(NOW.getTime() + 5 * 3_600_000).toISOString(),
      autoAttemptDate: "2026-08-23",
      autoAttemptCount: 2,
    });
    const fetcher = vi.fn(async () => okResult());
    const attempt = await pullPlatformNow("douyin", {
      dataDir: dir,
      trigger: "manual",
      ...deps({ registry: { douyin: fetcher } }),
    });
    expect(attempt.status).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ── 生命周期 ─────────────────────────────────────────────────────────────────

describe("startMetricsPullCycle — 生命周期", () => {
  // 只假造 interval：tick 内部要读真文件（真 I/O 不是定时器），setTimeout 保持真的才等得到它跑完
  const fakeInterval = (): void => void vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

  async function waitForCalls(spy: { mock: { calls: unknown[] } }, n: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (spy.mock.calls.length < n) {
      if (Date.now() > deadline) throw new Error(`等 tick 超时：只跑了 ${spy.mock.calls.length} 轮`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("启动即跑一轮，30 分钟再一轮；stop 之后不再跑", async () => {
    fakeInterval();
    const onTick = vi.fn();
    const stop = startMetricsPullCycle({ resolveDataDir: async () => dir, onTick, ...deps() });
    await waitForCalls(onTick, 1); // 等这一轮真跑完再拨表,否则撞上 ticking 双闸

    vi.advanceTimersByTime(METRICS_PULL_TICK_MS);
    await waitForCalls(onTick, 2);

    stop();
    vi.advanceTimersByTime(METRICS_PULL_TICK_MS * 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("上一轮没跑完，下一 tick 直接跳过（双闸，不叠罗汉）", async () => {
    fakeInterval();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const onTick = vi.fn();
    const resolveDataDir = vi.fn(async () => {
      await gate;
      return dir;
    });
    const stop = startMetricsPullCycle({ resolveDataDir, onTick, ...deps() });
    vi.advanceTimersByTime(METRICS_PULL_TICK_MS * 3);
    await new Promise((r) => setTimeout(r, 20));
    expect(resolveDataDir).toHaveBeenCalledTimes(1);
    expect(onTick).not.toHaveBeenCalled();
    release();
    await waitForCalls(onTick, 1);
    stop();
  });

  it("tick 里出错不炸进程（下一轮照常）", async () => {
    fakeInterval();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onTick = vi.fn();
    const stop = startMetricsPullCycle({
      resolveDataDir: async () => {
        throw new Error("工作区注册表挂了");
      },
      onTick,
      ...deps(),
    });
    await waitForCalls(onTick, 1);
    vi.advanceTimersByTime(METRICS_PULL_TICK_MS);
    await waitForCalls(onTick, 2);
    expect(spy).toHaveBeenCalled();
    stop();
    spy.mockRestore();
  });
});
