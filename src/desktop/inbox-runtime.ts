/**
 * 收件箱运行时（spec §2.1「工作区归属」+ §3.1「并发与恢复」）——server 进程内的**单例**接线：
 * 配置 → 工作区 → worker（消化管线）→ TG 长轮询 poller。
 *
 * 四条纪律：
 * 1. **未配置 / 工作区缺失不是崩溃，是可见状态**：`not_configured` / `workspace_missing`
 *    照样返回，doctor（C3）与设置页（C2）据此提示，server 启动不受影响。
 * 2. **启动顺序不可换**：先回收过期 claim（把崩在 fetching 的 item 拉回 pending），
 *    再补扫 pending 入队，最后才开 poller——反过来会让新消息插在积压前面。
 * 3. **配置变更 = 热重启**：停旧 poller（不推进 offset）、按新配置重新接线，并唤醒
 *    blocked 项（等的可能正是刚补上的那个外部条件）。
 * 4. **所有生命周期操作串行**：start/stop/配置变更事件可能重叠，用一条 promise 链排队，
 *    避免两个 poller 同时消费同一个 getUpdates 游标（409）。
 */
import { getDataDir } from "../storage/local-store.js";
import { createDigestPipeline, type InboxUpdatedEvent } from "../modules/inbox/digest-pipeline.js";
import { getItem, listItems, updateItem, type InboxItem } from "../modules/inbox/inbox-store.js";
import {
  getInboxWorker,
  resetInboxWorker,
  MAX_ATTEMPTS,
  type InboxWorker,
  type ProcessResult,
} from "../modules/inbox/inbox-worker.js";
import {
  createTelegramPoller,
  type PollerStatus,
  type TelegramPoller,
  type TelegramPollerDeps,
} from "../modules/inbox/telegram-poller.js";
import { getInboxSettingsRaw, onInboxSettingsChanged, type InboxSettings } from "./settings-inbox.js";
import { onEngineSettingsChanged } from "./settings.js";
import { listWorkspaces } from "./workspace-store.js";

export type InboxRuntimeState = "not_configured" | "workspace_missing" | "running" | "stopped";

/** C3 doctor 与 C2 设置页的唯一读口 */
export interface InboxRuntimeStatus {
  state: InboxRuntimeState;
  targetWorkspaceId?: string;
  dataDir?: string;
  /** 人话原因（未配置缺什么、工作区缺哪个） */
  detail?: string;
  poller?: PollerStatus;
}

export interface InboxRuntimeOptions {
  /** 全局根（inbox.json 与 tg-offset.json 的落点）；缺省走 getDataDir() */
  rootDir?: string;
  /** 状态落定回调，C2 接 SSE（总线不在这层接） */
  onInboxEvent?: (evt: InboxUpdatedEvent) => void;
  /** 故障出口——不静默（默认 console.error） */
  onError?: (message: string) => void;
  /** 测试注入：假 poller */
  createPollerImpl?: (deps: TelegramPollerDeps) => TelegramPoller;
  /** 测试注入：替掉真消化管线 */
  processItemImpl?: (item: InboxItem) => Promise<ProcessResult>;
}

const SETTINGS_CHANGED = "settings_changed";

let options: InboxRuntimeOptions = {};
let poller: TelegramPoller | null = null;
let worker: InboxWorker | null = null;
let unsubscribeSettings: (() => void) | null = null;
let unsubscribeEngine: (() => void) | null = null;
let status: InboxRuntimeStatus = { state: "stopped" };
let chain: Promise<unknown> = Promise.resolve();

function report(message: string): void {
  (options.onError ?? ((m: string) => console.error(`[inbox-runtime] ${m}`)))(message);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 生命周期串行队列：前一步失败也不许卡住后一步 */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/** targetWorkspaceId → dataDir。注册表里没有 = 配置指向了一个被删掉的工作区 */
async function resolveWorkspaceDataDir(id: string): Promise<string | null> {
  const { workspaces } = await listWorkspaces();
  return workspaces.find((w) => w.id === id)?.dataDir ?? null;
}

function buildWorker(dataDir: string, settings: InboxSettings): InboxWorker {
  const processItem =
    options.processItemImpl ??
    createDigestPipeline({
      dataDir,
      telegram: {
        botToken: settings.botToken,
        ...(settings.proxyUrl ? { proxyUrl: settings.proxyUrl } : {}),
      },
      // 解析器 key 与 TG 代理不共用：justoneapi 直连（spec §3.2）。
      // 缺 key 时抖音链接落 blocked，配好保存 → 本函数重新接线 + wakeBlocked 自动重跑。
      parsers: { ...(settings.justoneapiKey ? { justoneapiKey: settings.justoneapiKey } : {}) },
      onError: report,
    });
  // 事件走 worker 的 onItemChanged（写账**之后**触发），不走 pipeline 的 onEvent——
  // 后者在 return 前发，消费方按 itemId 重读会抢到中间态
  return getInboxWorker({
    dataDir,
    processItem,
    onError: (err, ctx) => report(`worker ${ctx.phase} 失败（${ctx.itemId ?? "-"}）：${errText(err)}`),
    ...(options.onInboxEvent
      ? { onItemChanged: (item: InboxItem) => options.onInboxEvent?.({ type: "inbox:updated", itemId: item.id }) }
      : {}),
  });
}

/** 启动补扫：回收过的 fetching 此刻已是 pending，一并被这轮列表吃到 */
async function enqueuePending(active: InboxWorker, dataDir: string): Promise<number> {
  const pending = (await listItems(dataDir)).filter((it) => it.status === "pending");
  for (const item of pending) active.enqueue(item);
  return pending.length;
}

async function tearDown(): Promise<void> {
  if (poller) {
    try {
      await poller.stop();
    } catch (err) {
      report(`poller 停机失败：${errText(err)}`);
    }
    poller = null;
  }
  worker = null;
  resetInboxWorker(); // 停掉退避定时器并清单例，下次 get 按新 dataDir 重建
}

/**
 * 接线主流程。任何一步「条件不满足」都落成可见状态返回，不抛。
 * `wakeReason` 有值 = 这是配置变更后的热重启，顺带唤醒 blocked 项。
 */
async function bringUp(wakeReason?: string): Promise<InboxRuntimeStatus> {
  await tearDown();
  const settings = await getInboxSettingsRaw(options.rootDir);
  if (!settings) {
    status = { state: "not_configured", detail: "未配置 Telegram bot token（设置页 · 灵感收件箱）" };
    return status;
  }
  const dataDir = await resolveWorkspaceDataDir(settings.targetWorkspaceId);
  if (!dataDir) {
    status = {
      state: "workspace_missing",
      targetWorkspaceId: settings.targetWorkspaceId,
      detail: `目标工作区不存在：${settings.targetWorkspaceId}（去设置页重选，保存后自动恢复）`,
    };
    return status;
  }

  const active = buildWorker(dataDir, settings);
  worker = active;
  const reclaimed = await active.reclaimExpiredClaims();
  const pending = await enqueuePending(active, dataDir);
  if (reclaimed.length > 0) report(`回收 ${reclaimed.length} 条中断的处理中条目，已重排`);

  poller = (options.createPollerImpl ?? createTelegramPoller)({
    settings,
    dataDir,
    rootDir: getDataDir(options.rootDir),
    onItem: (item) => active.enqueue(item),
    onError: report,
  });
  poller.start();
  if (wakeReason) active.wakeBlocked(wakeReason);

  status = {
    state: "running",
    targetWorkspaceId: settings.targetWorkspaceId,
    dataDir,
    ...(pending > 0 ? { detail: `启动补扫 ${pending} 条待消化` } : {}),
  };
  return status;
}

/**
 * 启动（或按新配置重启）收件箱运行时。**幂等**：重复调用等于热重启。
 * 未配置时也会订阅配置变更——配好 token 保存那一刻自动起来，不用重启 server。
 */
export function startInboxRuntime(opts: InboxRuntimeOptions = {}): Promise<InboxRuntimeStatus> {
  options = opts;
  if (!unsubscribeSettings) {
    unsubscribeSettings = onInboxSettingsChanged(() => {
      void serialize(() => bringUp(SETTINGS_CHANGED)).catch((err) =>
        report(`配置变更后重启失败：${errText(err)}`),
      );
    });
  }
  // spec §3.3：blocked 由配置变更事件唤醒——引擎配置保存成功也是其中一种（等引擎的 item 在等它）
  if (!unsubscribeEngine) {
    unsubscribeEngine = onEngineSettingsChanged(() => wakeInboxBlocked("engine_settings_changed"));
  }
  return serialize(() => bringUp());
}

/** 外部条件变更（引擎配置、未来的解析器 key）→ 唤醒 blocked；runtime 未起时静默无事发生 */
export function wakeInboxBlocked(reason: string): void {
  worker?.wakeBlocked(reason);
}

/**
 * 人工重试一条 item（收件箱视图的「重试」按钮）。worker 实例是 runtime 私有的，
 * 通道 handler 只能经这道薄门进来。
 *
 * **attempts 超限先清零**：`requestRetry` 会被 worker 的 claim 门挡下（failed 且
 * attempts≥3 不再自动跑），不清零等于「点了没反应」——人工重试的语义就是重开额度。
 * 终态（digested/rejected）的复活由调用方先改状态，这里不替它做决定。
 *
 * 返回 false = runtime 没起来（未配置/工作区缺失）。调用方必须照实说
 * 「已排队，worker 起来后自动处理」，不许假装投递成功。
 */
export async function retryInboxItem(id: string): Promise<boolean> {
  const active = worker;
  const dataDir = status.dataDir;
  if (!active || !dataDir) return false;
  const item = await getItem(id, dataDir);
  if (!item) return false;
  if (item.attempts >= MAX_ATTEMPTS) await updateItem(id, { attempts: 0 }, dataDir);
  active.requestRetry(id);
  return true;
}

/** 停止运行时并退订配置变更；停机后状态恒为 stopped */
export function stopInboxRuntime(): Promise<InboxRuntimeStatus> {
  return serialize(async () => {
    unsubscribeSettings?.();
    unsubscribeSettings = null;
    unsubscribeEngine?.();
    unsubscribeEngine = null;
    await tearDown();
    status = { state: "stopped" };
    return status;
  });
}

/** doctor / 设置页读状态：poller 的心跳与停机原因现取，不缓存 */
export function getInboxRuntimeStatus(): InboxRuntimeStatus {
  return { ...status, ...(poller ? { poller: poller.getStatus() } : {}) };
}
