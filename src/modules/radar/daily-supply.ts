/**
 * 每日选题供给（spec §6 Q4 (b)）：每天目标 10 条新雷达选题。
 *
 * 雷达照常 6 小时一刷、每轮入 3 条；当天不够 10 条时，周期里额外「补抓」——
 * 不看 6 小时缓存直接重抓源、按差额入库。补抓每天最多 3 次、两次至少隔 3 小时，
 * 次数先落盘再动手（崩了也不会无限补）。3 次用完还不够，或雷达打分没接上（没配引擎时
 * 周期只冻结候选池，等 AI 会话打分），选题列头照实写「今天只找到 N 条」，不悄悄空着。
 *
 * 「今天」按本机日历日；计数含已进回收站的雷达选题（找到了、被你打低星的也算找到）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir, listTopics, listTrash, type Topic } from "../../storage/local-store.js";

export const DAILY_TARGET = 10;
export const MAX_REFILLS = 3;
export const REFILL_GAP_MS = 3 * 3600_000;
const FILE = "radar-daily-supply.json";

export interface SupplyState {
  date: string;
  refills: number;
  lastRefillAt: string | null;
  /** 今天有一轮因为没配打分引擎只建了池 */
  engineUnavailable: boolean;
  /** 最近一次补抓的失败原因（源全挂 / 打分出错） */
  lastError: string | null;
}

export interface SupplyView {
  today: number;
  target: number;
  refills: number;
  /** 列头要不要写「今天只找到 N 条」 */
  short: boolean;
  /** 为什么不够（给 title / 提示行） */
  reason: string | null;
}

export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const empty = (date: string): SupplyState => ({ date, refills: 0, lastRefillAt: null, engineUnavailable: false, lastError: null });

export async function readSupplyState(dataDir: string | undefined, now: number): Promise<SupplyState> {
  const date = localDate(now);
  try {
    const raw = JSON.parse(await fs.readFile(path.join(getDataDir(dataDir), FILE), "utf-8")) as Partial<SupplyState>;
    if (raw.date !== date) return empty(date);
    return { ...empty(date), ...raw, date };
  } catch {
    return empty(date);
  }
}

export async function writeSupplyState(state: SupplyState, dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, FILE), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function countToday(topics: Array<Pick<Topic, "source" | "createdAt">>, now: number): number {
  const date = localDate(now);
  return topics.filter((t) => t.source?.startsWith("radar:") && localDate(new Date(t.createdAt).getTime()) === date).length;
}

export async function todayRadarCount(dataDir: string | undefined, now: number): Promise<number> {
  const [active, trash] = await Promise.all([listTopics(dataDir), listTrash(dataDir)]);
  return countToday([...active, ...trash.topics], now);
}

/** 这一刻该不该补抓：不够数、还有次数、离上次补抓够久 */
export function refillDue(state: SupplyState, today: number, now: number): boolean {
  if (today >= DAILY_TARGET || state.refills >= MAX_REFILLS) return false;
  if (!state.lastRefillAt) return true;
  return now - new Date(state.lastRefillAt).getTime() >= REFILL_GAP_MS;
}

export function supplyView(state: SupplyState, today: number): SupplyView {
  const lacking = today < DAILY_TARGET;
  const exhausted = state.refills >= MAX_REFILLS;
  const short = lacking && (exhausted || state.engineUnavailable);
  const reason = !short ? null
    : state.engineUnavailable ? "雷达打分没接上：候选池在等 AI 会话打分（autocrew_topic radar_pool / radar_score）"
    : state.lastError ? `补抓 ${state.refills} 轮仍不够，最近一次：${state.lastError}`
    : `每天目标 ${DAILY_TARGET} 条，补抓 ${state.refills} 轮后仍不够`;
  return { today, target: DAILY_TARGET, refills: state.refills, short, reason };
}

export async function loadSupplyView(dataDir: string | undefined, now = Date.now()): Promise<SupplyView> {
  const [state, today] = await Promise.all([readSupplyState(dataDir, now), todayRadarCount(dataDir, now)]);
  return supplyView(state, today);
}
