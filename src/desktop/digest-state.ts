/**
 * 每日选题摘要的落盘状态（spec §2.3）——`<dataDir>/digest-state.json`。
 *
 * 它只回答四个问题：今天发过没（`lastSentDate`）、上一份清单是什么（`lastDigest`，
 * 回复按它算）、今天试了几次（`attemptsToday`）、上次为什么没发出去（`lastError/At`）。
 *
 * 两条纪律：
 * 1. **幂等按本地日期**，不按 24 小时窗口——「今天的那份」是人的概念，跨夜重启也不该补发昨天的。
 * 2. **原子写**：调度器每分钟碰它，半截 JSON 会让「今天发过没」变成未知，进而重发一份。
 *    读不出来一律当「全新状态」（宁可多发一份，也不要因为一个坏文件从此再不发）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../storage/json-atomic.js";
import { getDataDir } from "../storage/local-store.js";
import type { LastDigest } from "../modules/inbox/daily-digest.js";

export const DIGEST_STATE_FILE = "digest-state.json";

export interface DigestState {
  /** 本地日期 YYYY-MM-DD；等于今天 = 今天已发，不再自动发 */
  lastSentDate?: string;
  lastSentAt?: string;
  lastDigest?: LastDigest;
  /** 今天试了几次（成功也计），跨日归零；上限 3（§2.3） */
  attemptsToday?: number;
  /** attemptsToday 属于哪一天——没有它就无法区分「今天 3 次」和「上周 3 次」 */
  attemptsDate?: string;
  /** 最近一次尝试时刻，重试间隔（10 分钟）按它算 */
  lastAttemptAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export function digestStatePath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), DIGEST_STATE_FILE);
}

/** 本地日期键 YYYY-MM-DD（不是 UTC——「今天」是用户挂钟上的今天） */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地时钟的小时（0–23） */
export function localHour(ms: number): number {
  return new Date(ms).getHours();
}

/** 今天 `hour` 点整的时间戳（本地时区） */
export function localHourAt(ms: number, hour: number, dayOffset = 0): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** 读不出来 = 全新状态（坏文件不该让摘要从此哑掉） */
export async function loadDigestState(dataDir?: string): Promise<DigestState> {
  try {
    const raw = JSON.parse(await fs.readFile(digestStatePath(dataDir), "utf-8")) as DigestState;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export async function saveDigestState(state: DigestState, dataDir?: string): Promise<void> {
  const file = digestStatePath(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, state);
}

/** 局部更新：读—改—写一次落定（同进程内只有调度器与回复处理两个写者，且都很稀疏） */
export async function patchDigestState(
  patch: Partial<DigestState>,
  dataDir?: string,
): Promise<DigestState> {
  const next = { ...(await loadDigestState(dataDir)), ...patch };
  await saveDigestState(next, dataDir);
  return next;
}

/** 今天的尝试次数（跨日自动归零，不需要一个「每天 0 点清零」的定时器） */
export function attemptsOn(state: DigestState, date: string): number {
  return state.attemptsDate === date ? (state.attemptsToday ?? 0) : 0;
}
