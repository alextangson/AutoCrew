/**
 * 每天 09:00 自动抓一次（2026-10-03 创始人裁定）：拨着注入的时钟跑真 tick + 真状态文件，
 * 锁「到点抓 / 错过补抓且当天只补一次 / 失败按退避 / ego lite 没开不刷屏 / 手动不受限」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pullPlatformNow, runMetricsPullTick, type MetricsPullDeps } from "./metrics-pull-cycle.js";
import { defaultPlatformState, readPullState, writePullState, type PlatformPullState } from "../modules/flywheel/pull-state.js";
import type { PullResult, TypedRow } from "../adapters/browser/pull-types.js";

let dir: string;
const ROWS: TypedRow[] = [{ title: "视频一", publishedAt: "2026-08-20T10:00:00.000Z", platformItemId: "i1", metrics: { views: 100 } }];
const okResult = (): PullResult => ({ status: "ok", rows: ROWS });
const fail = (status: PullResult["status"], errorCode: string): PullResult => ({ status, rows: [], errorCode });

function deps(over: Partial<MetricsPullDeps>): MetricsPullDeps {
  return {
    importRows: vi.fn(async () => ({ total: 1, imported: 1, replaced: 0, matched: 1, historical: 0, needsReview: [], rejected: [] })),
    emit: vi.fn(async () => ({ ts: "", role: "analyst" as const, kind: "metrics_pull", label: "x" })),
    sleep: vi.fn(async () => {}),
    warn: () => {},
    ...over,
  };
}

async function seed(platform: "douyin", over: Partial<PlatformPullState> = {}): Promise<void> {
  const state = await readPullState(dir);
  state.platforms[platform] = { ...defaultPlatformState(), enabled: true, ...over };
  await writePullState(state, dir);
}

const stateOf = async (platform: "douyin"): Promise<PlatformPullState> => (await readPullState(dir)).platforms[platform];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pull-schedule-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("每天 09:00 自动抓一次（拨时钟）", () => {
  const at = (day: number, h: number, m = 0): Date => new Date(2026, 7, day, h, m);

  async function tickAt(now: Date, fetcher: () => Promise<PullResult>) {
    return runMetricsPullTick(dir, deps({ now: () => now, registry: { douyin: fetcher } }));
  }

  it("08:30 不抓，09:00 抓一次，09:30 / 15:00 不再抓，次日 09:00 再抓", async () => {
    await seed("douyin", { lastSuccessAt: at(22, 9).toISOString() });
    const fetcher = vi.fn(async () => okResult());
    expect(await tickAt(at(23, 8, 30), fetcher)).toHaveLength(0);
    expect(await tickAt(at(23, 9, 0), fetcher)).toHaveLength(1);
    expect(await tickAt(at(23, 9, 30), fetcher)).toHaveLength(0);
    expect(await tickAt(at(23, 15, 0), fetcher)).toHaveLength(0);
    expect(await tickAt(at(24, 9, 0), fetcher)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("错过 09:00（电脑睡到 14:00）：醒来第一次检查补抓，当天只补这一次", async () => {
    await seed("douyin", { lastSuccessAt: at(22, 9).toISOString() });
    const fetcher = vi.fn(async () => okResult());
    expect(await tickAt(at(23, 14, 0), fetcher)).toHaveLength(1);
    expect(await tickAt(at(23, 14, 30), fetcher)).toHaveLength(0);
    expect(await tickAt(at(23, 23, 30), fetcher)).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("09:00 那一抓失败：按退避 1 小时后重试，成功后当天不再抓", async () => {
    await seed("douyin");
    const fetcher = vi.fn().mockResolvedValueOnce(fail("error", "http:503")).mockResolvedValue(okResult());
    expect(await tickAt(at(23, 9, 0), fetcher)).toHaveLength(1);
    expect(await tickAt(at(23, 9, 30), fetcher)).toHaveLength(0); // 退避中
    expect(await tickAt(at(23, 10, 0), fetcher)).toHaveLength(1);
    expect(await tickAt(at(23, 11, 0), fetcher)).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ego lite 没开：一小时后再试，当天最多试 3 次就停（不刷屏），次日 09:00 照常", async () => {
    await seed("douyin");
    const fetcher = vi.fn(async () => fail("browser_unreachable", "ego_unreachable"));
    for (const h of [9, 10, 11, 12, 13]) await tickAt(at(23, h, 0), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await stateOf("douyin")).lastStatus).toBe("browser_unreachable");
    await tickAt(at(24, 9, 0), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("手动「立即抓取」随时可抓、一天多次也行，不影响当天 09:00 的定时抓取", async () => {
    await seed("douyin", { lastSuccessAt: at(22, 9).toISOString() });
    const fetcher = vi.fn(async () => okResult());
    for (const h of [7, 8]) {
      const a = await pullPlatformNow("douyin", { dataDir: dir, trigger: "manual", ...deps({ now: () => at(23, h), registry: { douyin: fetcher } }) });
      expect(a.status).toBe("ok");
    }
    expect(await tickAt(at(23, 9, 0), fetcher)).toHaveLength(1);
    const after = await pullPlatformNow("douyin", { dataDir: dir, trigger: "manual", ...deps({ now: () => at(23, 9, 5), registry: { douyin: fetcher } }) });
    expect(after.status).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

