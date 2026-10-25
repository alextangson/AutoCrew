/**
 * 回流跟运营平台勾选走（管线重规划 §4、§8-10）+ 同一轮顺带抓账号快照。全程假抓取器，不连浏览器。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pullPlatformNow, runMetricsPullTick, type MetricsPullDeps } from "./metrics-pull-cycle.js";
import { defaultPlatformState, readPullState, writePullState, type PullPlatform } from "../modules/flywheel/pull-state.js";
import { readAccountDays, readAccountPullState } from "../modules/flywheel/account-snapshots.js";
import { pullNowHandler, pullStatusHandler } from "./metrics-pull-handlers.js";
import type { PullResult } from "../adapters/browser/pull-types.js";

let dir: string;
const NOW = new Date(2026, 9, 25, 10, 0, 0);
const ok: PullResult = { status: "ok", rows: [{ title: "视频一", publishedAt: "2026-10-24T10:00:00.000Z", platformItemId: "i1", metrics: { views: 100 } }] };

const pick = async (platforms: string[]) => fs.writeFile(path.join(dir, "creator-profile.json"), JSON.stringify({ platforms }));
async function enable(...ps: PullPlatform[]) {
  const s = await readPullState(dir);
  for (const p of ps) s.platforms[p] = { ...defaultPlatformState(), enabled: true };
  await writePullState(s, dir);
}
function deps(over: Partial<MetricsPullDeps> = {}): MetricsPullDeps {
  return {
    importRows: vi.fn(async () => ({ total: 1, imported: 1, replaced: 0, matched: 1, historical: 0, needsReview: [], rejected: [] })),
    emit: vi.fn(async () => ({}) as never),
    now: () => NOW,
    sleep: vi.fn(async () => {}),
    warn: () => {},
    ...over,
  };
}

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pull-picker-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("回流范围 = 勾选 ∩ 有抓取器", () => {
  it("定时：开了开关但没勾的平台不抓；勾了的照常抓", async () => {
    await pick(["douyin"]);
    await enable("douyin", "xiaohongshu");
    const douyin = vi.fn(async () => ok), xhs = vi.fn(async () => ok);
    const attempts = await runMetricsPullTick(dir, deps({ registry: { douyin, xiaohongshu: xhs } }));
    expect(attempts.map((a) => a.platform)).toEqual(["douyin"]);
    expect(xhs).not.toHaveBeenCalled();
  });
  it("勾了但开关关着：定时不抓（开关仍是这家的退出口），手动照抓", async () => {
    await pick(["douyin"]);
    const douyin = vi.fn(async () => ok);
    expect(await runMetricsPullTick(dir, deps({ registry: { douyin } }))).toEqual([]);
    expect((await pullPlatformNow("douyin", { ...deps({ registry: { douyin } }), dataDir: dir })).status).toBe("ok");
  });
  it("手动「立即抓取」走同一道闸：没勾 = not_picked，不打开后台、不写状态", async () => {
    await pick(["douyin"]);
    const xhs = vi.fn(async () => ok);
    const a = await pullPlatformNow("xiaohongshu", { ...deps({ registry: { xiaohongshu: xhs } }), dataDir: dir });
    expect(a).toEqual({ platform: "xiaohongshu", status: "not_picked", rowCount: 0 });
    expect(xhs).not.toHaveBeenCalled();
    expect((await readPullState(dir)).platforms.xiaohongshu.lastStatus).toBe("never");
    const ipc = await pullNowHandler({ _dataDir: dir, platform: "xiaohongshu" });
    expect(ipc).toMatchObject({ ok: true, data: { status: "not_picked" } });
  });
  it("没有档案 = 什么都没勾 = 都不抓", async () => {
    await enable("douyin");
    const douyin = vi.fn(async () => ok);
    expect(await runMetricsPullTick(dir, deps({ registry: { douyin } }))).toEqual([]);
  });
});

describe("账号快照跟着同一轮抓", () => {
  it("作品抓成后再开一次首页：快照入账、健康单独记、pull_status 带出账号格", async () => {
    await pick(["bilibili"]);
    const account = vi.fn(async () => ({ status: "ok" as const, account: "号", rows: [{ metricDate: "2026-10-24", followers: 8, newFollowers: 1, views: 23 }] }));
    const a = await pullPlatformNow("bilibili", { ...deps({ registry: { bilibili: async () => ok }, accountRegistry: { bilibili: account } }), dataDir: dir });
    expect(a.account).toEqual({ status: "ok", days: 1 });
    expect((await readAccountDays(dir))[0]).toMatchObject({ platform: "bilibili", followers: 8, complete: true });
    expect((await readAccountPullState(dir)).bilibili).toMatchObject({ lastStatus: "ok", lastDays: 1 });
    const status = await pullStatusHandler({ _dataDir: dir });
    const rows = (status.data as { platforms: Array<{ platform: string; account: unknown }> }).platforms;
    expect(rows.find((r) => r.platform === "bilibili")!.account).toMatchObject({ latest: { followers: 8 }, compare: "no_prev" });
    expect(rows.find((r) => r.platform === "wechat_video")!.account).toBeNull();
  });
  it("作品抓取要登录：账号这次不再打开后台，健康记成同一状态，不留旧数字冒充", async () => {
    await pick(["douyin"]);
    const account = vi.fn();
    const a = await pullPlatformNow("douyin", { ...deps({ registry: { douyin: async () => ({ status: "needs_login", rows: [] }) }, accountRegistry: { douyin: account } }), dataDir: dir });
    expect(account).not.toHaveBeenCalled();
    expect(a.account).toMatchObject({ status: "needs_login", days: 0 });
    expect((await readAccountPullState(dir)).douyin).toMatchObject({ lastStatus: "needs_login", lastSuccessAt: null });
  });
  it("账号抓取失败只记账号健康，作品结果不受影响", async () => {
    await pick(["douyin"]);
    const a = await pullPlatformNow("douyin", { ...deps({ registry: { douyin: async () => ok }, accountRegistry: { douyin: async () => ({ status: "schema_changed" as const, rows: [], account: null, errorCode: "missing:data.fans/play" }) } }), dataDir: dir });
    expect(a.status).toBe("ok");
    expect(a.account).toMatchObject({ status: "schema_changed" });
    expect((await readPullState(dir)).platforms.douyin.lastStatus).toBe("ok");
    expect(await readAccountDays(dir)).toEqual([]);
  });
});
