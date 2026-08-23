/**
 * 自动回流的调度状态 `<dataDir>/metrics-pull.json`（spec §4.3）。
 *
 * 它是**缓存不是账本**：真账在 outcomes.jsonl（幂等键去重）。所以文件损坏一律重建默认值
 * 并 warn——代价只是多抓一次，绝不让一个坏文件把整条调度卡死。
 *
 * 时间口径：所有「当日」判定用**本地时区自然日**（与 localDateStamp 同一把尺子），
 * 因为退避语义是给人看的「今天已经失败 3 次了」，不是 UTC 的某个抽象日。
 *
 * 并发：读改写全部走进程内单写队列 + writeJsonAtomic（同 hypotheses/outcome-store 的做法）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import type { PullStatus } from "../../adapters/browser/pull-types.js";

/** 自动回流覆盖的三平台（公众号走既有的 flywheel:wechat_pull，不在此列） */
export const PULL_PLATFORMS = ["douyin", "wechat_video", "xiaohongshu"] as const;
export type PullPlatform = (typeof PULL_PLATFORMS)[number];

export const PULL_STATE_FILE = "metrics-pull.json";
export const PULL_STATE_VERSION = 1;

/** 平台中文名（后端文案与待办用；前端另有 PLATFORM_CATALOG，值保持一致） */
export const PULL_PLATFORM_LABELS: Record<PullPlatform, string> = {
  douyin: "抖音",
  wechat_video: "视频号",
  xiaohongshu: "小红书",
};

/** 登录态过期时给人的扫码地址（各平台创作者后台） */
export const PULL_PLATFORM_CONSOLES: Record<PullPlatform, string> = {
  douyin: "https://creator.douyin.com",
  wechat_video: "https://channels.weixin.qq.com",
  xiaohongshu: "https://creator.xiaohongshu.com",
};

export interface PlatformPullState {
  enabled: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  nextEligibleAt: string | null;
  failureCount: number;
  /** 当日失败计数的日期锚（本地时区 YYYY-MM-DD）；跨日即重置 */
  failureDate: string | null;
  lastStatus: PullStatus | "never";
  /** 脱敏错误码，永不含响应原文（codex #22） */
  lastErrorCode?: string;
  /** 最近一次成功真正入账的行数，不是抓取器返回的原始行数 */
  lastRowCount?: number;
  lastBatchId?: string;
  /**
   * 「单平台自动抓取 ≤2 次/天」红线的当日计数锚（spec §4.3）。
   * 手动触发不计入——人明确要抓的时候，红线不该拦人。
   */
  autoAttemptDate: string | null;
  autoAttemptCount: number;
}

export interface MetricsPullState {
  schemaVersion: number;
  platforms: Record<PullPlatform, PlatformPullState>;
}

export function isPullPlatform(value: unknown): value is PullPlatform {
  return typeof value === "string" && (PULL_PLATFORMS as readonly string[]).includes(value);
}

/** 本地时区自然日 YYYY-MM-DD（localDateStamp 的任意时刻版） */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function defaultPlatformState(): PlatformPullState {
  return {
    enabled: false, // 首次使用三平台全关：Report 页引导人自己开（spec §6）
    lastSuccessAt: null,
    lastAttemptAt: null,
    nextEligibleAt: null,
    failureCount: 0,
    failureDate: null,
    lastStatus: "never",
    autoAttemptDate: null,
    autoAttemptCount: 0,
  };
}

export function defaultPullState(): MetricsPullState {
  return {
    schemaVersion: PULL_STATE_VERSION,
    platforms: {
      douyin: defaultPlatformState(),
      wechat_video: defaultPlatformState(),
      xiaohongshu: defaultPlatformState(),
    },
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** 逐字段容错：单个平台条目脏了只回退这一格，不牵连另外两个平台 */
function normalizePlatform(raw: unknown): PlatformPullState {
  const base = defaultPlatformState();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const status = typeof r.lastStatus === "string" ? (r.lastStatus as PlatformPullState["lastStatus"]) : "never";
  return {
    enabled: r.enabled === true,
    lastSuccessAt: str(r.lastSuccessAt),
    lastAttemptAt: str(r.lastAttemptAt),
    nextEligibleAt: str(r.nextEligibleAt),
    failureCount: num(r.failureCount),
    failureDate: str(r.failureDate),
    lastStatus: status,
    ...(str(r.lastErrorCode) ? { lastErrorCode: str(r.lastErrorCode) as string } : {}),
    ...(typeof r.lastRowCount === "number" ? { lastRowCount: num(r.lastRowCount) } : {}),
    ...(str(r.lastBatchId) ? { lastBatchId: str(r.lastBatchId) as string } : {}),
    autoAttemptDate: str(r.autoAttemptDate),
    autoAttemptCount: num(r.autoAttemptCount),
  };
}

/** 整体形状不认识（非对象/版本不符）→ null，调用方重建默认并 warn */
function normalizeState(raw: unknown): MetricsPullState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== PULL_STATE_VERSION) return null;
  const platformsRaw = (typeof r.platforms === "object" && r.platforms !== null ? r.platforms : {}) as Record<string, unknown>;
  const state = defaultPullState();
  for (const p of PULL_PLATFORMS) state.platforms[p] = normalizePlatform(platformsRaw[p]);
  return state;
}

function statePath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), PULL_STATE_FILE);
}

/**
 * 读状态。不存在 = 首次使用（默认值，不 warn）；损坏/版本不符 = 重建默认 + warn。
 * 只有真正的 IO 故障（权限/设备）才抛——那不是「没数据」，调用方要显式说「不可用」。
 */
export async function readPullState(
  dataDir?: string,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): Promise<MetricsPullState> {
  let raw: string;
  try {
    raw = await fs.readFile(statePath(dataDir), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return defaultPullState();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`[metrics-pull] ${PULL_STATE_FILE} 解析失败，已重建默认状态（缓存不是账本，最多多抓一次）`);
    return defaultPullState();
  }
  const state = normalizeState(parsed);
  if (!state) {
    warn(`[metrics-pull] ${PULL_STATE_FILE} 形状不认识（版本或结构不符），已重建默认状态`);
    return defaultPullState();
  }
  return state;
}

/** 进程内写队列：读-改-写不互相穿插（同 outcome-store/hypotheses 的做法） */
const writeChains = new Map<string, Promise<unknown>>();

function serializePullStateWrite<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = getDataDir(dataDir);
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(key, tail);
  void tail.then(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key);
  });
  return next;
}

export async function writePullState(state: MetricsPullState, dataDir?: string): Promise<void> {
  await serializePullStateWrite(dataDir, async () => {
    await fs.mkdir(getDataDir(dataDir), { recursive: true });
    await writeJsonAtomic(statePath(dataDir), state);
  });
}

/**
 * 读-改-写一次成型（整段在写队列内，两个并发更新不会互相吞掉）。
 * mutate 只改传入平台那一格，返回值是落盘后的完整状态。
 */
export async function updatePlatformPullState(
  platform: PullPlatform,
  mutate: (prev: PlatformPullState) => PlatformPullState,
  dataDir?: string,
): Promise<MetricsPullState> {
  return serializePullStateWrite(dataDir, async () => {
    const state = await readPullState(dataDir);
    state.platforms[platform] = mutate(state.platforms[platform]);
    await fs.mkdir(getDataDir(dataDir), { recursive: true });
    await writeJsonAtomic(statePath(dataDir), state);
    return state;
  });
}
