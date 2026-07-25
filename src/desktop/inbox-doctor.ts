/**
 * 收件箱 doctor（spec §4「doctor 三项」+ §2.1「离线语义」）——三项检查：
 * 1. runtime/poller 健康（未配置是中性状态，401/409 是红）
 * 2. 积压时长（>30min 黄、>24h 红，红文案带 TG 24h 丢件语义）
 * 3. patterns 库可读（附卡片数，不含墓碑）
 *
 * 两条硬纪律：
 * - **绝不带外调用 Telegram getUpdates**（§2.1 明文禁止）——那会抢走正式消费者的游标，
 *   把真消息吞掉。bot 健康只从 runtime 状态与 poller 心跳读，一个字节都不发给上游。
 * - **检查本身不许抛**：doctor 是「出事时才跑」的工具，读不出来要变成红色结论，
 *   而不是让整条 doctor 命令崩掉，把其余检查项一起带走。
 */
import { getInboxRuntimeStatus, type InboxRuntimeStatus } from "./inbox-runtime.js";
import { listItems, type InboxItem } from "../modules/inbox/inbox-store.js";
import { listPatternCards, type PatternCard } from "../modules/patterns/pattern-store.js";

/** neutral = 「没配也没关系」，不进失败计数；error 才是 doctor 的退出码来源 */
export type DoctorLevel = "ok" | "warn" | "error" | "neutral";

export type InboxDoctorKey = "inboxRuntime" | "inboxBacklog" | "patternsLibrary";

export interface DoctorCheck {
  key: InboxDoctorKey;
  level: DoctorLevel;
  /** 一行结论（已含关键读数：心跳时间、update_id、条数、时长） */
  label: string;
  /** 人话下一步。没有可做的事就不给——空指引比没指引更糟 */
  hint?: string;
}

export interface InboxDoctorDeps {
  status?: () => InboxRuntimeStatus;
  listItemsImpl?: (dataDir: string) => Promise<InboxItem[]>;
  listPatternsImpl?: (dataDir?: string) => Promise<PatternCard[]>;
  now?: () => number;
}

/** 心跳阈值：长轮询 50s 一轮，5 分钟没有一次成功 = 至少连挂 5 轮，够黄了 */
const POLL_STALE_MS = 5 * 60_000;
const BACKLOG_WARN_MS = 30 * 60_000;
const BACKLOG_ERROR_MS = 24 * 60 * 60_000;

/** §2.1 离线语义：TG 侧只留 24h，这句必须出现在积压转红的那一刻 */
const TG_DROP_HINT =
  "积压已超 24h：Telegram 只保留未取更新 24h，同期没被取走的转发会被上游丢弃且找不回来——" +
  "先恢复轮询与消化，再请创始人补转关键链接。";

const MARKS: Record<DoctorLevel, string> = { ok: "✓", warn: "!", error: "✕", neutral: "·" };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function humanAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(0, minutes)} 分钟`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(ms / 86_400_000)} 天`;
}

/** 轮询健康：只读 poller 自报的心跳与停机原因（§2.1「不做带外积压探测」） */
function pollerCheck(status: InboxRuntimeStatus, now: number): DoctorCheck {
  const key: InboxDoctorKey = "inboxRuntime";
  const poller = status.poller;
  if (!poller) {
    return { key, level: "warn", label: "运行中，但轮询器未就绪", hint: "看 server 日志 [inbox-runtime] 段" };
  }
  const tail = `最后 update ${poller.lastUpdateId ?? "—"}`;
  switch (poller.state) {
    case "blocked_auth":
      return {
        key,
        level: "error",
        label: `Telegram token 失效（401），轮询已停 · ${tail}`,
        hint: "去设置页 · 灵感收件箱更新 bot token，保存即热重启" + (poller.lastError ? `（${poller.lastError}）` : ""),
      };
    case "conflict":
      return {
        key,
        level: "error",
        label: `同一 bot token 另有消费者（409），轮询已停 · ${tail}`,
        hint: "关掉另一处在跑的 AutoCrew/脚本，或换一个 bot；不自旋重试，恢复后需重启",
      };
    case "stopped":
      return {
        key,
        level: "warn",
        label: `轮询已停 · ${tail}`,
        hint: poller.lastError ?? "改配置或重启 AutoCrew 可重新拉起",
      };
    case "polling":
      return pollingCheck(poller.lastPollOkAt, tail, now);
  }
}

function pollingCheck(lastPollOkAt: string | undefined, tail: string, now: number): DoctorCheck {
  const key: InboxDoctorKey = "inboxRuntime";
  const okAt = lastPollOkAt ? Date.parse(lastPollOkAt) : NaN;
  if (!Number.isFinite(okAt)) {
    return {
      key,
      level: "warn",
      label: "轮询已启动，尚无成功轮询记录",
      hint: "长轮询一轮 50s，刚起可等一轮；持续为空看网络/代理（proxyUrl）",
    };
  }
  const age = now - okAt;
  const reading = `最近成功轮询 ${humanAge(age)}前（${lastPollOkAt}）· ${tail}`;
  if (age > POLL_STALE_MS) {
    return {
      key,
      level: "warn",
      label: `轮询可能卡住：${reading}`,
      hint: "超过 5 分钟没有一次成功轮询——查网络/代理（proxyUrl）与 server 日志",
    };
  }
  return { key, level: "ok", label: `轮询中 · ${reading}` };
}

/** 检查一：runtime 状态。未配置是中性——收件箱是可选能力，没配不该报错 */
function runtimeCheck(status: InboxRuntimeStatus, now: number): DoctorCheck {
  const key: InboxDoctorKey = "inboxRuntime";
  switch (status.state) {
    case "not_configured":
      return {
        key,
        level: "neutral",
        label: "未配置 Telegram bot（收件箱是可选能力，不影响其他流程）",
        hint: status.detail ?? "想用就去设置页 · 灵感收件箱填 bot token，保存后自动启动",
      };
    case "workspace_missing":
      return {
        key,
        level: "error",
        label: "目标工作区不存在，收件箱未启动（转发进来的消息无处落库）",
        hint: status.detail ?? "去设置页 · 灵感收件箱重选目标工作区，保存后自动恢复",
      };
    case "stopped":
      return {
        key,
        level: "warn",
        label: "收件箱运行时已停止",
        hint: status.detail ?? "执行 autocrew restart 重新拉起",
      };
    case "running":
      return pollerCheck(status, now);
  }
}

/** 检查二：积压。listItems 是旧→新序，第一条未决项即最老（§3.1） */
async function backlogCheck(
  status: InboxRuntimeStatus,
  deps: Required<Pick<InboxDoctorDeps, "listItemsImpl">>,
  now: number,
): Promise<DoctorCheck> {
  const key: InboxDoctorKey = "inboxBacklog";
  const dataDir = status.dataDir;
  if (!dataDir) {
    return { key, level: "neutral", label: "无目标工作区，积压未检查（先把 runtime 弄好）" };
  }
  let items: InboxItem[];
  try {
    items = await deps.listItemsImpl(dataDir);
  } catch (err) {
    return {
      key,
      level: "error",
      label: `收件箱台账读不出来：${errText(err)}`,
      hint: `检查 ${dataDir}/inbox/inbox.jsonl 的权限与磁盘`,
    };
  }
  const backlog = items.filter((it) => it.status === "pending" || it.status === "failed");
  if (backlog.length === 0) {
    return { key, level: "ok", label: `无积压（台账共 ${items.length} 条）` };
  }
  const oldest = backlog[0];
  const age = now - Date.parse(oldest.receivedAt);
  if (!Number.isFinite(age)) {
    return {
      key,
      level: "warn",
      label: `${backlog.length} 条待消化，最老一条时间戳不可解析（${oldest.id}）`,
      hint: "台账该行 receivedAt 已损坏，在收件箱视图重试这条",
    };
  }
  const reading = `${backlog.length} 条待消化，最老 ${humanAge(age)}（${oldest.id}）`;
  if (age >= BACKLOG_ERROR_MS) return { key, level: "error", label: reading, hint: TG_DROP_HINT };
  if (age >= BACKLOG_WARN_MS) {
    return { key, level: "warn", label: reading, hint: "消化像是卡住了——看 server 日志，或在收件箱视图重试该条" };
  }
  return { key, level: "ok", label: `${reading}，正常处理中` };
}

/** 检查三：patterns 库。dataDir 缺省时落当前工作区——写稿注入读的也是那一份 */
async function patternsCheck(
  status: InboxRuntimeStatus,
  deps: Required<Pick<InboxDoctorDeps, "listPatternsImpl">>,
): Promise<DoctorCheck> {
  const key: InboxDoctorKey = "patternsLibrary";
  try {
    const cards = await deps.listPatternsImpl(status.dataDir);
    return { key, level: "ok", label: `可读 · ${cards.length} 张拆解卡（不含已删墓碑）` };
  } catch (err) {
    return {
      key,
      level: "error",
      label: `拆解卡库读不出来：${errText(err)}`,
      hint: `检查 ${status.dataDir ?? "当前工作区"}/patterns/patterns.jsonl 的权限与磁盘`,
    };
  }
}

/** doctor 三项。任何一项内部失败都落成红色结论返回，本函数不抛 */
export async function collectInboxDoctorChecks(deps: InboxDoctorDeps = {}): Promise<DoctorCheck[]> {
  const now = (deps.now ?? Date.now)();
  const status = (deps.status ?? getInboxRuntimeStatus)();
  const listItemsImpl = deps.listItemsImpl ?? listItems;
  const listPatternsImpl = deps.listPatternsImpl ?? ((dataDir?: string) => listPatternCards({}, dataDir));
  return [
    runtimeCheck(status, now),
    await backlogCheck(status, { listItemsImpl }, now),
    await patternsCheck(status, { listPatternsImpl }),
  ];
}

/** CLI 文本：跟随既有 doctor 的 `✓ key: value` + `  → 指引` 版式 */
export function formatInboxDoctorChecks(checks: DoctorCheck[]): string {
  return checks
    .map((c) => `${MARKS[c.level]} ${c.key}: ${c.label}${c.hint ? `\n  → ${c.hint}` : ""}`)
    .join("\n");
}

/** IPC `doctor:inbox` —— CLI `autocrew doctor` 经 /api/invoke 读进程内的心跳 */
export async function inboxDoctorHandler(
  payload: Record<string, unknown>,
  deps?: InboxDoctorDeps,
): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const checks = await collectInboxDoctorChecks(deps);
    return {
      ok: true,
      data: {
        checks,
        text: formatInboxDoctorChecks(checks),
        failed: checks.some((c) => c.level === "error"),
      },
    };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}
