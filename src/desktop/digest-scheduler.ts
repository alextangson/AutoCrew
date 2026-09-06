/**
 * 每日选题摘要调度（spec §2.3）——进程内调度，与雷达同款（`radar-cycle.ts`）：
 * 每分钟看一眼「已启用 && 本地时间到点 && 今天还没发」，到了就发一份到创始人的 Telegram。
 *
 * 四条纪律：
 * 1. **幂等按本地日期**：`lastSentDate === 今天` 就不再发。改小时、重启、手动补发都不破例。
 * 2. **只补今天**：服务 14 点才起、设定 9 点 → 启动那一 tick 就把今天这份补上；
 *    昨天漏的不补（补一份昨天的清单没人会去点）。
 * 3. **失败可见**：发不出去 → `lastError/lastErrorAt` + 引擎事件，10 分钟后重试，一天最多 3 次。
 *    静默重试到天黑等于「以为发了其实没发」，那比不发更糟。
 * 4. **没配 bot 就不调度**：token 缺失时 tick 直接返回，不写状态、不报错——那不是故障，是没开这个功能。
 *
 * 时钟与发送都可注入：测试里不碰网络、不等真实的一分钟。
 */
import type { Topic } from "../storage/local-store.js";
import { listTopics } from "../storage/local-store.js";
import { loadRadarSources } from "../modules/radar/topic-radar.js";
import { callTelegram, redactSecrets } from "../modules/inbox/telegram-api.js";
import {
  digestItemsSent,
  pickDigestTopics,
  renderDigest,
  renderEmptyDigest,
  DIGEST_LIMIT,
  FIRST_WINDOW_MS,
  type DigestItem,
} from "../modules/inbox/daily-digest.js";
import { emitEngineEvent } from "./event-hub.js";
import {
  getInboxSettingsRaw,
  onInboxSettingsChanged,
  DEFAULT_DIGEST_HOUR,
  type InboxSettings,
} from "./settings-inbox.js";
import {
  attemptsOn,
  loadDigestState,
  localDateKey,
  localHourAt,
  patchDigestState,
  type DigestState,
} from "./digest-state.js";

export const DIGEST_TICK_MS = 60_000;
export const DIGEST_RETRY_MS = 10 * 60_000;
export const DIGEST_MAX_ATTEMPTS = 3;
/** 「现在发一份」的防呆窗口（§3 防呆：连点两次） */
export const SEND_NOW_GUARD_MS = 60_000;
/** 缺省小时的事实源在 settings-inbox（读侧回显也认它），这里只是转口 */
export { DEFAULT_DIGEST_HOUR };

const NO_RECIPIENT =
  "白名单为空——摘要没有收件人（设置页 · 接入更多 · Telegram 收件箱里填你自己的 user id）";

export interface DigestSchedulerOptions {
  /** 选题与 digest-state.json 的落点（工作区 dataDir） */
  dataDir?: string;
  /** inbox.json 所在的全局根（settings 读口用） */
  rootDir?: string;
  loadSettings?: (rootDir?: string) => Promise<InboxSettings | null>;
  listTopicsImpl?: (dataDir?: string) => Promise<Topic[]>;
  /** 扫了几个源；拿不到就回 undefined——空摘要那句话宁可不带数字，也不编一个 */
  countSourcesImpl?: (dataDir?: string) => Promise<number | undefined>;
  sendImpl?: (text: string, settings: InboxSettings) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  emit?: typeof emitEngineEvent;
  onError?: (message: string) => void;
}

export interface DigestStatus {
  enabled: boolean;
  hour: number;
  /** 下一次预定发送时刻；未配置 bot 或已关闭 = null */
  nextAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  attemptsToday: number;
}

export interface DigestSendResult {
  ok: boolean;
  error?: string;
  /** 这一份里有几条选题（空摘要 = 0） */
  count?: number;
}

let opts: DigestSchedulerOptions = {};
let timer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;
let ticking = false;

function clock(): number {
  return (opts.now ?? Date.now)();
}

function report(message: string): void {
  (opts.onError ?? ((m: string) => console.error(`[digest] ${m}`)))(message);
}

function settingsOf(): Promise<InboxSettings | null> {
  return (opts.loadSettings ?? getInboxSettingsRaw)(opts.rootDir);
}

/** 调度器绑定的工作区——回复处理要读同一份 digest-state.json，不能各读各的 */
export function digestDataDir(): string | undefined {
  return opts.dataDir;
}

export function digestHourOf(settings: InboxSettings): number {
  const h = settings.digestHour;
  return Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23 ? (h as number) : DEFAULT_DIGEST_HOUR;
}

function digestEnabledOf(settings: InboxSettings): boolean {
  return settings.digestEnabled !== false;
}

async function defaultSend(text: string, settings: InboxSettings): Promise<void> {
  const chatId = settings.allowedUserIds[0];
  if (!chatId) throw new Error(NO_RECIPIENT);
  // chat_id 传字符串：TG user id 已越过 JS 安全整数区间，转 number 会丢精度
  await callTelegram(
    "sendMessage",
    { chat_id: chatId, text, disable_web_page_preview: true },
    { botToken: settings.botToken, ...(settings.proxyUrl ? { proxyUrl: settings.proxyUrl } : {}) },
  );
}

async function countSources(dataDir?: string): Promise<number | undefined> {
  try {
    return (await loadRadarSources(dataDir)).filter((s) => s.enabled !== false).length;
  } catch {
    return undefined; // 读不到就不说「扫了 N 个源」
  }
}

/**
 * 组装这一份摘要。`since` 缺省 = 上一份发出的时刻；手动补发走 24h 窗口
 * （「今天再来一份」如果只看上一份之后，多半是空的——那不是创始人按下按钮想看到的东西）。
 */
async function buildDigest(
  state: DigestState,
  now: number,
  date: string,
  manual: boolean,
  dir: string | undefined,
): Promise<{ text: string; items: DigestItem[] }> {
  const topics = await (opts.listTopicsImpl ?? listTopics)(dir);
  const since = manual ? now - FIRST_WINDOW_MS : state.lastSentAt;
  const picked = pickDigestTopics(topics, { ...(since !== undefined ? { since } : {}), now, limit: DIGEST_LIMIT });
  const scanned = await (opts.countSourcesImpl ?? countSources)(dir);
  const render = { date, now, ...(scanned !== undefined ? { sourcesScanned: scanned } : {}) };
  if (picked.length === 0) return { text: renderEmptyDigest(render), items: [] };
  return { text: renderDigest(picked, render), items: digestItemsSent(picked, render) };
}

function errText(err: unknown, settings: InboxSettings): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw, {
    botToken: settings.botToken,
    ...(settings.proxyUrl ? { proxyUrl: settings.proxyUrl } : {}),
  });
}

/** 一次投递：先记尝试（崩了也不会无限重试），再发，再落定。任何失败都写进状态且发事件 */
async function deliver(
  settings: InboxSettings,
  now: number,
  manual: boolean,
  dir: string | undefined,
): Promise<DigestSendResult> {
  const date = localDateKey(now);
  const state = await loadDigestState(dir);
  const attempts = attemptsOn(state, date) + 1;
  await patchDigestState(
    { attemptsToday: attempts, attemptsDate: date, lastAttemptAt: new Date(now).toISOString() },
    dir,
  );
  try {
    const { text, items } = await buildDigest(state, now, date, manual, dir);
    await (opts.sendImpl ?? defaultSend)(text, settings);
    const sentAt = new Date(now).toISOString();
    await patchDigestState(
      {
        lastSentDate: date,
        lastSentAt: sentAt,
        lastDigest: { date, sentAt, items: items.map(({ n, topicId, title }) => ({ n, topicId, title })) },
        lastError: undefined,
        lastErrorAt: undefined,
      },
      dir,
    );
    await emitDigest("work", `每日选题摘要已发出：${items.length} 条候选`);
    return { ok: true, count: items.length };
  } catch (err) {
    const message = errText(err, settings);
    await patchDigestState({ lastError: message, lastErrorAt: new Date(now).toISOString() }, dir);
    report(`摘要发送失败（今天第 ${attempts} 次）：${message}`);
    await emitDigest("run_failed", `每日选题摘要发送失败（今天第 ${attempts}/${DIGEST_MAX_ATTEMPTS} 次）：${message}`);
    return { ok: false, error: message };
  }
}

async function emitDigest(kind: "work" | "run_failed", label: string): Promise<void> {
  try {
    await (opts.emit ?? emitEngineEvent)({ role: "scout", kind, label }, opts.dataDir);
  } catch {
    /* 观测层不得破坏执行层 */
  }
}

/** 到点判定（§2.3）。返回 null = 这一刻不该发，字符串仅用于测试与日志的可读性 */
function dueReason(settings: InboxSettings, state: DigestState, now: number): string | null {
  if (!digestEnabledOf(settings)) return null;
  const date = localDateKey(now);
  if (state.lastSentDate === date) return null; // 今天已发
  if (now < localHourAt(now, digestHourOf(settings))) return null; // 还没到点
  const attempts = attemptsOn(state, date);
  if (attempts >= DIGEST_MAX_ATTEMPTS) return null;
  if (attempts > 0) {
    const last = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : NaN;
    if (Number.isFinite(last) && now - last < DIGEST_RETRY_MS) return null; // 重试还没到 10 分钟
  }
  return attempts > 0 ? "retry" : "due";
}

/** 一个 tick。重入保护：上一轮还在发（网络慢）时这一轮直接跳过 */
export async function runDigestTick(): Promise<DigestSendResult | null> {
  if (ticking) return null;
  ticking = true;
  try {
    const settings = await settingsOf();
    if (!settings?.botToken) return null; // 没配 bot = 不调度（§3 状态）
    const now = clock();
    const state = await loadDigestState(opts.dataDir);
    if (!dueReason(settings, state, now)) return null;
    return await deliver(settings, now, false, opts.dataDir);
  } catch (err) {
    report(`摘要 tick 失败：${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    ticking = false;
  }
}

/**
 * 起调度。**幂等**：重复调用 = 按新参数重起。启动就跑一 tick（当天补发），
 * 之后每分钟一次；配置变更立刻再看一眼（改小时/开关不用等下一分钟）。
 */
export function startDigestScheduler(options: DigestSchedulerOptions = {}): Promise<DigestSendResult | null> {
  stopDigestScheduler();
  opts = options;
  timer = setInterval(() => void runDigestTick(), options.intervalMs ?? DIGEST_TICK_MS);
  timer.unref?.(); // 定时器不该成为进程退不掉的理由
  unsubscribe = onInboxSettingsChanged(() => void runDigestTick());
  return runDigestTick();
}

export function stopDigestScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribe?.();
  unsubscribe = null;
  opts = {};
}

/**
 * 「现在发一份」（§2.5）：绕过日期幂等与到点判定，但 60 秒内连点第二次会被挡下——
 * 两条一模一样的摘要连着到手机上，人只会以为系统坏了。
 */
export async function sendDigestNow(dataDir?: string): Promise<DigestSendResult> {
  const dir = dataDir ?? opts.dataDir;
  const settings = await settingsOf();
  if (!settings?.botToken) return { ok: false, error: "还没配 Telegram bot——先在这张卡上填 bot token" };
  const now = clock();
  const state = await loadDigestState(dir);
  const lastAt = state.lastSentAt ? Date.parse(state.lastSentAt) : NaN;
  if (Number.isFinite(lastAt) && now - lastAt < SEND_NOW_GUARD_MS) {
    return { ok: false, error: `刚发过（${Math.max(1, Math.round((now - lastAt) / 1000))} 秒前）` };
  }
  return deliver(settings, now, true, dir);
}

/** 下一次预定发送：今天还没发且已过点 = 今天那个点（已逾期，下一 tick 就发） */
function nextAtOf(settings: InboxSettings, state: DigestState, now: number): string | null {
  if (!digestEnabledOf(settings)) return null;
  const hour = digestHourOf(settings);
  const today = localHourAt(now, hour);
  // 今天还没发 → 就是今天那个点（已过点 = 逾期，下一 tick 立刻发）；发过了 → 明天同一个点
  const sentToday = state.lastSentDate === localDateKey(now);
  return new Date(sentToday ? localHourAt(now, hour, 1) : today).toISOString();
}

/** `inbox:status.digest` 的唯一读口——现读状态文件，不缓存 */
export async function getDigestStatus(dataDir?: string): Promise<DigestStatus> {
  const dir = dataDir ?? opts.dataDir;
  const [settings, state] = await Promise.all([settingsOf(), loadDigestState(dir)]);
  const now = clock();
  const enabled = settings ? digestEnabledOf(settings) : true;
  const hour = settings ? digestHourOf(settings) : DEFAULT_DIGEST_HOUR;
  return {
    enabled,
    hour,
    nextAt: settings?.botToken ? nextAtOf(settings, state, now) : null,
    lastSentAt: state.lastSentAt ?? null,
    lastError: state.lastError ?? null,
    lastErrorAt: state.lastErrorAt ?? null,
    attemptsToday: attemptsOn(state, localDateKey(now)),
  };
}
