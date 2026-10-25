import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendSnapshots, readAccountDays, readAccountPullState, SNAPSHOT_FILE, toSnapshots, updateAccountPullHealth } from "./account-snapshots.js";
import { accountTile, dayBefore } from "./account-view.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-acct-snap-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const day = (metricDate: string, followers: number | null, views: number | null, newFollowers: number | null = 1) => ({ metricDate, followers, newFollowers, views });

describe("账号快照账本", () => {
  it("没抓过 = 空；只追加；同一天逐字段取最新的非空值，完整标记跟着重算", async () => {
    expect(await readAccountDays(dir)).toEqual([]);
    await appendSnapshots(toSnapshots("xiaohongshu", [day("2026-10-24", 16302, 149, 0)], "号", "2026-10-25T01:00:00.000Z"), dir);
    await appendSnapshots(toSnapshots("xiaohongshu", [day("2026-10-24", null, 150, 0), day("2026-10-25", 16310, 90, 2)], "号", "2026-10-26T01:00:00.000Z"), dir);
    const days = await readAccountDays(dir);
    expect(days.map((d) => [d.metricDate, d.followers, d.views, d.complete])).toEqual([["2026-10-24", 16302, 150, true], ["2026-10-25", 16310, 90, true]]);
    expect(days[0].viewsKind).toBe("plays");
    const raw = await fs.readFile(path.join(dir, SNAPSHOT_FILE), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(3);
  });
  it("坏行跳过不拖垮；公众号记成阅读；缺字段的不完整", async () => {
    await fs.writeFile(path.join(dir, SNAPSHOT_FILE), "{坏\n");
    await appendSnapshots(toSnapshots("wechat_mp", [day("2026-10-24", 749, null, 0)], null, "2026-10-25T01:00:00.000Z"), dir);
    const [d] = await readAccountDays(dir);
    expect(d).toMatchObject({ platform: "wechat_mp", viewsKind: "reads", complete: false, views: null });
  });
  it("账号抓取健康单独存，失败不抹掉上次成功时间", async () => {
    await updateAccountPullHealth("douyin", () => ({ lastAttemptAt: "a", lastSuccessAt: "a", lastStatus: "ok", lastDays: 7 }), dir);
    await updateAccountPullHealth("douyin", (prev) => ({ lastAttemptAt: "b", lastSuccessAt: prev?.lastSuccessAt ?? null, lastStatus: "needs_login" }), dir);
    expect((await readAccountPullState(dir)).douyin).toEqual({ lastAttemptAt: "b", lastSuccessAt: "a", lastStatus: "needs_login" });
  });
});

describe("账号格的数", () => {
  const snaps = (rows: ReturnType<typeof day>[]) => toSnapshots("douyin", rows, null, "2026-10-25T01:00:00.000Z");
  it("只和真正的前一个自然日比", () => {
    const t = accountTile("douyin", snaps([day("2026-10-23", 1702, 2832), day("2026-10-24", 1721, 12745)]), null);
    expect(t).toMatchObject({ followersDelta: 19, compare: "ok", latest: { metricDate: "2026-10-24", views: 12745 } });
    expect(t.series).toEqual([{ date: "2026-10-23", views: 2832 }, { date: "2026-10-24", views: 12745 }]);
  });
  it("缺了前一天就不比（隔天的数不算「较昨天」）；只有一天也不比", () => {
    expect(accountTile("douyin", snaps([day("2026-10-22", 1700, 1), day("2026-10-24", 1721, 2)]), null)).toMatchObject({ followersDelta: null, compare: "no_prev" });
    expect(accountTile("douyin", snaps([day("2026-10-24", 1721, 2)]), null)).toMatchObject({ compare: "no_prev", series: [{ date: "2026-10-24", views: 2 }] });
    expect(accountTile("douyin", snaps([day("2026-10-23", null, 1), day("2026-10-24", 1721, 2)]), null).compare).toBe("no_prev");
  });
  it("没有快照 = no_data；别的平台的快照不串", () => {
    expect(accountTile("bilibili", snaps([day("2026-10-24", 1, 1)]), null)).toMatchObject({ latest: null, compare: "no_data" });
  });
  it("小折线只取最近 7 个自然日", () => {
    const rows = Array.from({ length: 10 }, (_, i) => day(dayBefore("2026-10-24", 9 - i), 100 + i, i));
    expect(accountTile("douyin", snaps(rows), null).series.map((s) => s.date)).toEqual(Array.from({ length: 7 }, (_, i) => dayBefore("2026-10-24", 6 - i)));
  });
});
