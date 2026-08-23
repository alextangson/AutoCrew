/**
 * 控制面三通道的契约（spec §4.4）+ 假设台账只读通道。
 * 重点锁两件事：坏 platform 在边界被拒；状态读失败显式报错，不谎报成「都没抓过」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pullStatusHandler, pullNowHandler, pullToggleHandler } from "./metrics-pull-handlers.js";
import { hypothesesListHandler } from "./goal-retro-handlers.js";
import { PULL_STATE_FILE, readPullState, writePullState, defaultPullState } from "../modules/flywheel/pull-state.js";
import { appendHypotheses, type Hypothesis } from "../modules/retro/hypotheses.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pull-ipc-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface StatusRow {
  platform: string;
  label: string;
  consoleUrl: string;
  inFlight: boolean;
  enabled: boolean;
  lastStatus: string;
}

const rowsOf = (res: Record<string, unknown>): StatusRow[] =>
  ((res.data as { platforms: StatusRow[] }).platforms);

describe("flywheel:pull_status", () => {
  it("首次使用：三平台全关、从未运行、都不在飞", async () => {
    const res = await pullStatusHandler({ _dataDir: dir });
    expect(res.ok).toBe(true);
    const rows = rowsOf(res);
    expect(rows.map((r) => r.platform)).toEqual(["douyin", "wechat_video", "xiaohongshu"]);
    expect(rows.every((r) => r.enabled === false && r.lastStatus === "never" && r.inFlight === false)).toBe(true);
    expect(rows[0].label).toBe("抖音");
    expect(rows[2].consoleUrl).toContain("creator.xiaohongshu.com");
  });

  it("状态文件读不出来 → 显式 ok:false（界面显示「不可用」，不是「没抓过」）", async () => {
    await fs.mkdir(path.join(dir, PULL_STATE_FILE));
    const res = await pullStatusHandler({ _dataDir: dir });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("回流状态读取失败");
  });
});

describe("flywheel:pull_toggle", () => {
  it("开关落盘；打开时清掉上一次失败留下的冷却锚点", async () => {
    const seeded = defaultPullState();
    seeded.platforms.douyin.nextEligibleAt = "2099-01-01T00:00:00.000Z";
    await writePullState(seeded, dir);

    const res = await pullToggleHandler({ _dataDir: dir, platform: "douyin", enabled: true });
    expect(res.ok).toBe(true);
    const state = await readPullState(dir);
    expect(state.platforms.douyin.enabled).toBe(true);
    expect(state.platforms.douyin.nextEligibleAt).toBeNull();
  });

  it("关掉不清退避锚点（关了就是关了，没必要动别的字段）", async () => {
    await pullToggleHandler({ _dataDir: dir, platform: "xiaohongshu", enabled: true });
    const res = await pullToggleHandler({ _dataDir: dir, platform: "xiaohongshu", enabled: false });
    expect(res.ok).toBe(true);
    expect((await readPullState(dir)).platforms.xiaohongshu.enabled).toBe(false);
  });

  it("坏 platform / 非布尔 enabled 在边界拒收", async () => {
    expect((await pullToggleHandler({ _dataDir: dir, platform: "wechat_mp", enabled: true })).ok).toBe(false);
    const bad = await pullToggleHandler({ _dataDir: dir, platform: "douyin", enabled: "yes" });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("enabled");
  });
});

describe("flywheel:pull_now", () => {
  it("坏 platform 直接拒，不去碰浏览器", async () => {
    const res = await pullNowHandler({ _dataDir: dir, platform: "bilibili" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("douyin");
  });
});

describe("flywheel:hypotheses_list", () => {
  const hypothesis = (over: Partial<Hypothesis>): Hypothesis => ({
    id: "h1",
    statement: "开头 5s 抛问题的视频完播率高于账号基线",
    metricFocus: "completionRate",
    direction: "up",
    scope: {},
    contentIds: [],
    proposedAt: "2026-08-20T10:00:00.000Z",
    retroRunId: "retro-weekly-2026-08-20T100000",
    status: "open",
    ...over,
  });

  it("open 与已裁决分两组回；已裁决按裁决时间新→旧", async () => {
    await appendHypotheses(
      [
        hypothesis({ id: "h1" }),
        hypothesis({ id: "h2", status: "supported", verdictAt: "2026-08-21T10:00:00.000Z" }),
        hypothesis({ id: "h3", status: "refuted", verdictAt: "2026-08-22T10:00:00.000Z" }),
      ],
      dir,
    );
    const res = await hypothesesListHandler({ _dataDir: dir });
    expect(res.ok).toBe(true);
    const data = res.data as { open: Hypothesis[]; judged: Hypothesis[] };
    expect(data.open.map((h) => h.id)).toEqual(["h1"]);
    expect(data.judged.map((h) => h.id)).toEqual(["h3", "h2"]);
  });

  it("台账为空 = 两组都空（不是错）", async () => {
    const res = await hypothesesListHandler({ _dataDir: dir });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ open: [], judged: [] });
  });
});
