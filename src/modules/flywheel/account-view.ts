/**
 * 首页账号格的数（纯函数，管线重规划 §4–5、§8-9）：
 * - 「较昨天」只和**真正的前一个自然日**比；那天没有快照 → 不比（首页写「明天开始有对比」）。
 * - 小折线：最近 7 个自然日里有播放/阅读数的天，≥2 天才画。
 */
import type { AccountPlatform } from "../../adapters/browser/account-stats.js";
import type { AccountPullHealth, AccountSnapshot } from "./account-snapshots.js";

export interface AccountTile {
  platform: AccountPlatform;
  health: AccountPullHealth | null;
  latest: Pick<AccountSnapshot, "metricDate" | "followers" | "newFollowers" | "views" | "viewsKind" | "complete" | "account" | "capturedAt"> | null;
  /** 粉丝较前一个自然日；null = 没得比（看 compare） */
  followersDelta: number | null;
  compare: "ok" | "no_prev" | "no_data";
  /** 最近 7 天每天的播放/阅读（升序），只含有数的天 */
  series: Array<{ date: string; views: number }>;
}

export function dayBefore(date: string, n = 1): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function accountTile(platform: AccountPlatform, days: AccountSnapshot[], health: AccountPullHealth | null): AccountTile {
  const mine = days.filter((d) => d.platform === platform).sort((a, b) => a.metricDate.localeCompare(b.metricDate));
  const last = mine[mine.length - 1];
  if (!last) return { platform, health, latest: null, followersDelta: null, compare: "no_data", series: [] };
  const prev = mine.find((d) => d.metricDate === dayBefore(last.metricDate));
  const delta = prev && prev.followers !== null && last.followers !== null ? last.followers - prev.followers : null;
  const from = dayBefore(last.metricDate, 6);
  const series = mine.filter((d) => d.metricDate >= from && d.views !== null).map((d) => ({ date: d.metricDate, views: d.views as number }));
  const { metricDate, followers, newFollowers, views, viewsKind, complete, account, capturedAt } = last;
  return {
    platform, health,
    latest: { metricDate, followers, newFollowers, views, viewsKind, complete, account, capturedAt },
    followersDelta: delta,
    compare: delta === null ? "no_prev" : "ok",
    series,
  };
}
