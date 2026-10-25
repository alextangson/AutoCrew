/**
 * 账号级每日快照（管线重规划 §4、§8-9）：`<dataDir>/account-snapshots.jsonl`，和作品账本 outcomes.jsonl 并排。
 *
 * - 只追加：每次抓取每个数据日写一行（平台、账号、数据日期=北京自然日、抓取时间、粉丝、当日新增粉丝、当日播放/阅读、是否完整）。
 * - 读：同一（平台, 数据日）多次抓取 → 逐字段取最新的非空值（小红书的粉丝总数只在最近一天上有，后来的抓取不能把它抹成空）。
 * - 账号抓取的健康单独记在 `<dataDir>/account-pull.json`，和作品抓取（metrics-pull.json）互不覆盖：
 *   作品抓成了、账号没抓成，首页要能分开说。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { assertManagedPathAvailable } from "../../storage/storage-roots.js";
import type { AccountDayRow, AccountPlatform } from "../../adapters/browser/account-stats.js";
import type { PullStatus } from "../../adapters/browser/pull-types.js";

export const SNAPSHOT_FILE = "account-snapshots.jsonl";
export const ACCOUNT_PULL_FILE = "account-pull.json";

/** 播放（视频平台）还是阅读（公众号）——首页按它写单位 */
export const VIEWS_KIND: Record<AccountPlatform, "plays" | "reads"> = { douyin: "plays", xiaohongshu: "plays", bilibili: "plays", wechat_mp: "reads" };

export interface AccountSnapshot extends AccountDayRow {
  platform: AccountPlatform;
  account: string | null;
  capturedAt: string;
  viewsKind: "plays" | "reads";
  /** 三个数都拿到了才算完整；不完整的照样存，首页只用拿到的那几个 */
  complete: boolean;
  source: "auto";
}

const snapPath = (dataDir?: string) => path.join(getDataDir(dataDir), SNAPSHOT_FILE);
const isComplete = (r: AccountDayRow) => r.followers !== null && r.newFollowers !== null && r.views !== null;

export function toSnapshots(platform: AccountPlatform, rows: AccountDayRow[], account: string | null, capturedAt: string): AccountSnapshot[] {
  return rows.map((r) => ({ platform, account, capturedAt, ...r, viewsKind: VIEWS_KIND[platform], complete: isComplete(r), source: "auto" }));
}

export async function appendSnapshots(rows: AccountSnapshot[], dataDir?: string): Promise<void> {
  if (rows.length === 0) return;
  assertManagedPathAvailable(snapPath(dataDir));
  await fs.mkdir(getDataDir(dataDir), { recursive: true });
  await fs.appendFile(snapPath(dataDir), rows.map((r) => JSON.stringify(r) + "\n").join(""), "utf-8");
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseLine(line: string): AccountSnapshot | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (typeof o.platform !== "string" || typeof o.metricDate !== "string" || typeof o.capturedAt !== "string") return null;
  return {
    platform: o.platform as AccountPlatform, account: typeof o.account === "string" ? o.account : null, capturedAt: o.capturedAt, metricDate: o.metricDate,
    followers: num(o.followers), newFollowers: num(o.newFollowers), views: num(o.views),
    viewsKind: o.viewsKind === "reads" ? "reads" : "plays", complete: o.complete === true, source: "auto",
  };
}

/**
 * 每（平台, 数据日）一行，逐字段取最新抓取的非空值。坏行跳过（只追加的账本，一行坏不拖垮其余）；
 * 文件不存在 = 还没抓过；真正的 IO 故障抛给调用方（「读不出来」不能说成「没有数据」）。
 */
export async function readAccountDays(dataDir?: string): Promise<AccountSnapshot[]> {
  let raw: string;
  try { raw = await fs.readFile(snapPath(dataDir), "utf-8"); } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const rows = raw.split("\n").filter(Boolean).map(parseLine).filter((r): r is AccountSnapshot => r !== null)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const by = new Map<string, AccountSnapshot>();
  for (const r of rows) {
    const key = `${r.platform}@${r.metricDate}`;
    const cur = by.get(key);
    const merged: AccountSnapshot = cur
      ? { ...r, account: r.account ?? cur.account, followers: r.followers ?? cur.followers, newFollowers: r.newFollowers ?? cur.newFollowers, views: r.views ?? cur.views }
      : r;
    by.set(key, { ...merged, complete: isComplete(merged) });
  }
  return [...by.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.metricDate.localeCompare(b.metricDate));
}

// ── 账号抓取健康（与作品抓取分开记） ─────────────────────────────────────────

export interface AccountPullHealth {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: PullStatus | "never";
  lastErrorCode?: string;
  /** 最近一次成功写进账本的数据日数 */
  lastDays?: number;
}

export type AccountPullState = Partial<Record<AccountPlatform, AccountPullHealth>>;

const statePath = (dataDir?: string) => path.join(getDataDir(dataDir), ACCOUNT_PULL_FILE);

/** 缓存不是账本：坏了就当没有（最多多抓一次），IO 故障照抛 */
export async function readAccountPullState(dataDir?: string): Promise<AccountPullState> {
  let raw: string;
  try { raw = await fs.readFile(statePath(dataDir), "utf-8"); } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return {};
    throw err;
  }
  try {
    const v = JSON.parse(raw) as { platforms?: AccountPullState };
    return v && typeof v.platforms === "object" && v.platforms ? v.platforms : {};
  } catch {
    return {};
  }
}

const chains = new Map<string, Promise<unknown>>();

/** 读-改-写在同一条队里：mutate 拿到上一份（没有就 null），返回新的一份 */
export async function updateAccountPullHealth(platform: AccountPlatform, mutate: (prev: AccountPullHealth | null) => AccountPullHealth, dataDir?: string): Promise<void> {
  const key = getDataDir(dataDir);
  const run = async () => {
    const state = await readAccountPullState(dataDir);
    state[platform] = mutate(state[platform] ?? null);
    await fs.mkdir(key, { recursive: true });
    await writeJsonAtomic(statePath(dataDir), { schemaVersion: 1, platforms: state });
  };
  const p = (chains.get(key) ?? Promise.resolve()).then(run, run);
  chains.set(key, p.then(() => undefined, () => undefined));
  await p;
}
