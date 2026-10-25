/**
 * 选题雷达的进程内调度（「让雷达滚起来」）——
 * 此前雷达的唯一触发点是 server 启动那一下,开着 app 不关就一天只滚一次,
 * 灵感库在下午就空转。这里把「刷新 → 入库 → 过期清理」收成一个周期函数:
 * 启动调一次,之后每 30 分钟调一次。
 *
 * 进程内调度,不是系统级 cron:桌面 app 常驻就够了,进程活着雷达才滚,进程一关全停——
 * 不在用户机器上留后台任务,也没有跨进程状态要维护。
 *
 * 两层节流,避免 30 分钟一轮变成 30 分钟烧一轮钱:
 *   1. in-flight guard:上一轮没跑完(慢源/慢模型),本 tick 直接跳过,不叠罗汉。
 *   2. TTL 门:refreshTopicRadarIfStale 6h 内不打源;缓存没变(skippedFresh)就连 intake
 *      都不做——同一批候选重评一次是白烧 LLM,还会把 7 天落选记忆填满、把新候选挤出去。
 *      所以真实入库节奏仍由 6h TTL 决定,tick 只是把"到点了自动跑"补上。
 *
 * 没配引擎(P6 §3.2):只抓源 + 建池冻结,不打分也不报错——池子等宿主定时会话
 * 用 autocrew_topic radar_pool / radar_score 在自己的额度上打分入库。配了引擎照旧两段打分,
 * 两条路共用 buildRadarPool + applyRadarResults 同一个池口径与入库段。
 */
import { refreshTopicRadar, refreshTopicRadarIfStale } from "../modules/radar/topic-radar.js";
import { DAILY_TARGET, readSupplyState, refillDue, todayRadarCount, writeSupplyState, type SupplyState } from "../modules/radar/daily-supply.js";
import { intakeRadarTopics } from "../modules/radar/radar-intake.js";
import { freezeCurrentRadarPool } from "../modules/radar/radar-host.js";
import { loadEngineConfigIfConfigured } from "../engine/config.js";
import { expireStaleTopics } from "./topic-expiry.js";
import { emitEngineEvent } from "./event-hub.js";

/** 30 分钟:比 6h TTL 密得多(错过刷新窗口最多迟到半小时),又不至于让 tick 本身变成噪音 */
export const RADAR_CYCLE_INTERVAL_MS = 30 * 60_000;

export interface RadarCycleDeps {
  refresh: typeof refreshTopicRadarIfStale;
  intake: typeof intakeRadarTopics;
  /** 引擎配好了没有:没配 = 不打分,只建池 */
  engineReady: () => Promise<boolean>;
  /** 无引擎时建池冻结,返回 pool_id(无候选为 null) */
  freezePool: () => Promise<string | null>;
  expire: typeof expireStaleTopics;
  /** 补抓用：不看 6h 缓存直接重抓 */
  forceRefresh: () => Promise<{ ok: boolean; itemCount: number; failedSources: string[] }>;
  readSupply: (now: number) => Promise<SupplyState>;
  writeSupply: (state: SupplyState) => Promise<void>;
  countToday: (now: number) => Promise<number>;
  now: () => number;
  emit: typeof emitEngineEvent;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface RadarCycleResult {
  /** 跳过原因:in_flight=上一轮还在跑;fresh=缓存新鲜,没真刷新,不重评 */
  skipped: "in_flight" | "fresh" | null;
  intakeCount: number;
  /** 无引擎时本轮冻结(或复用)的池,等宿主会话打分;有引擎或无候选为 null */
  poolId: string | null;
  expiredCount: number;
  failedSources: string[];
  /** 本轮补抓入库数（没补抓 = 0） */
  refillCount: number;
}

/**
 * 复用 P5-0 的「没配 vs 配坏了」口径:只有没配才走无引擎分支;
 * engine.json 写坏了照旧走引擎路径(judge 自己回退),并 warn 一行让人看得见。
 */
async function engineConfigured(): Promise<boolean> {
  try {
    return (await loadEngineConfigIfConfigured()) !== undefined;
  } catch (err) {
    console.warn(`[topic-radar] 引擎配置读取失败,按已配置处理: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

const defaults: RadarCycleDeps = {
  refresh: refreshTopicRadarIfStale,
  intake: intakeRadarTopics,
  engineReady: engineConfigured,
  freezePool: async () => (await freezeCurrentRadarPool()).pool?.pool_id ?? null,
  expire: expireStaleTopics,
  forceRefresh: () => refreshTopicRadar(),
  readSupply: (now) => readSupplyState(undefined, now),
  writeSupply: (state) => writeSupplyState(state),
  countToday: (now) => todayRadarCount(undefined, now),
  now: () => Date.now(),
  emit: emitEngineEvent,
  log: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
};

/** 有引擎:两段打分入库(有产出才发事件);没引擎:只建池冻结,等宿主会话打分。 */
async function markEngine(d: RadarCycleDeps, unavailable: boolean): Promise<void> {
  const state = await d.readSupply(d.now());
  if (state.engineUnavailable !== unavailable) await d.writeSupply({ ...state, engineUnavailable: unavailable });
}

async function scoreOrPool(d: RadarCycleDeps): Promise<{ intakeCount: number; poolId: string | null }> {
  if (!(await d.engineReady())) {
    // 没配引擎：只建池等宿主打分；记下来，选题列头照实说「今天只找到 N 条」而不是悄悄空着
    await markEngine(d, true);
    return { intakeCount: 0, poolId: await d.freezePool() };
  }
  await markEngine(d, false);
  const intake = await d.intake();
  if (intake.saved.length > 0) {
    await d.emit({
      role: "scout",
      kind: "work",
      label: `雷达入库 ${intake.saved.length} 条灵感:${intake.saved.map((t) => t.title).join("｜").slice(0, 80)}`,
    });
  }
  return { intakeCount: intake.saved.length, poolId: null };
}

/**
 * 每日补抓（daily-supply.ts）：当天雷达选题不够 10 条时，跳过 6h 缓存重抓并按差额入库。
 * 每天 ≤3 次、间隔 ≥3h；次数先落盘再动手。没配引擎不补（补了也打不了分），交给列头提示。
 */
async function topUp(d: RadarCycleDeps, justRefreshed: boolean): Promise<number> {
  const now = d.now();
  const [state, today] = await Promise.all([d.readSupply(now), d.countToday(now)]);
  if (!refillDue(state, today, now)) return 0;
  // 每次补抓前现查引擎：盘上的 engineUnavailable 只是给列头看的，跨零点会重置、配上引擎后也可能还是旧值
  if (!(await d.engineReady())) {
    await markEngine(d, true);
    return 0;
  }
  const attempt: SupplyState = { ...state, engineUnavailable: false, refills: state.refills + 1, lastRefillAt: new Date(now).toISOString(), lastError: null };
  await d.writeSupply(attempt);
  let lastError: string | null = null;
  let saved = 0;
  try {
    // 本轮刚抓过就不重抓：同一份缓存再入一次，拿上一段因名额满没进的过线候选
    const refreshed = justRefreshed ? { ok: true, itemCount: 0, failedSources: [] } : await d.forceRefresh();
    if (!refreshed.ok) lastError = refreshed.failedSources.length ? `源抓取失败：${refreshed.failedSources.join("、")}` : "没有可用的雷达源";
    else {
      const intake = await d.intake(undefined, { limit: DAILY_TARGET - today });
      saved = intake.saved.length;
      if (intake.filter === "keyword") lastError = "打分模型不可用，只按关键词收了中文候选";
      if (saved > 0) await d.emit({ role: "scout", kind: "work", label: `雷达补抓 ${saved} 条（今天第 ${attempt.refills} 轮补抓）` });
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
  if (lastError) {
    d.warn(`[topic-radar] 补抓第 ${attempt.refills} 轮：${lastError}`);
    await d.writeSupply({ ...attempt, lastError });
  }
  return saved;
}

/**
 * 造一轮雷达周期函数（闭包持 in-flight 状态）。
 * 返回的函数可被启动路径与 setInterval 共用——同一套行为,不给"启动特例"留后门。
 */
export function createRadarCycle(overrides?: Partial<RadarCycleDeps>): () => Promise<RadarCycleResult> {
  const d = { ...defaults, ...overrides };
  let inFlight = false;

  return async function runRadarCycle(): Promise<RadarCycleResult> {
    if (inFlight) return { skipped: "in_flight", intakeCount: 0, poolId: null, expiredCount: 0, failedSources: [], refillCount: 0 };
    inFlight = true;
    try {
      const refreshed = await d.refresh();
      if (refreshed.failedSources.length > 0) {
        d.warn(`[topic-radar] 部分源失败: ${refreshed.failedSources.join(", ")}`);
      }
      if (refreshed.skippedFresh) {
        // 缓存新鲜不重评，但当天不够数照样补抓（补抓自己会绕开缓存）
        const refillCount = await topUp(d, false);
        return { skipped: "fresh", intakeCount: 0, poolId: null, expiredCount: 0, failedSources: refreshed.failedSources, refillCount };
      }

      const scored = await scoreOrPool(d);
      const refillCount = await topUp(d, true);

      // 入库与清理同节奏:新灵感进来的同一轮把 7 天没打星也没选用的送回收站,灵感库才不会越滚越厚
      const swept = await d.expire();
      if (swept.total > 0) {
        d.log(`  [expiry] ${swept.total} 条超过 7 天未选用的灵感已移入回收站(可恢复)`);
      }
      return { skipped: null, ...scored, expiredCount: swept.total, failedSources: refreshed.failedSources, refillCount };
    } finally {
      inFlight = false;
    }
  };
}
