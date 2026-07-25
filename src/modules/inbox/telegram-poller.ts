/**
 * Telegram 长轮询 worker（spec §2.1）。server 进程内全局单例的**唯一** getUpdates 消费者。
 *
 * 全模块只为一件事服务——**不丢消息**：
 * 1. **offset 只越过已 fsync 落账的 update**。批内按序处理，`appendItem` 抛错立刻中断该批，
 *    offset 停在最后一条成功的 `update_id + 1`（`consumeBatch` 的 finally 保证这个前缀一定落盘）。
 *    崩溃窗口语义 = at-least-once，重复投递由幂等键吸收（§3.1）。
 * 2. **白名单外与不认识的 update 照样推进 offset**——不推进就等于毒丸：同一条永远排在队首，
 *    后面的真消息一条都取不到。
 * 3. **停机 abort 在途 poll 且不推进 offset**：没收到响应就没有 update，游标原地不动。
 *
 * poller 不碰消化管线：落账后调 `onItem(item)`，接线由后续阶段做。
 * 401/409 是停机态，靠外部（配置变更钩子）重新 `start()` 恢复——本模块只保证 stop 后可重 start。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { InboxSettings } from "../../desktop/settings-inbox.js";
import { getDataDir } from "../../storage/local-store.js";
import { appendItem, updateItem, type InboxItem } from "./inbox-store.js";
import {
  TelegramApiError,
  callTelegram,
  defaultSleep,
  errorText,
  redactSecrets,
  sendTelegramReceipt,
  type FetchLike,
  type SleepFn,
  type TelegramClientOptions,
} from "./telegram-api.js";

export { sendTelegramReceipt, type FetchLike, type TelegramClientOptions } from "./telegram-api.js";

/** 长轮询挂 50s（§2.1）；客户端硬超时留 15s 余量，防止半死连接把循环钉死 */
export const POLL_TIMEOUT_S = 50;
const POLL_HARD_TIMEOUT_MS = (POLL_TIMEOUT_S + 15) * 1_000;
const GETME_TIMEOUT_MS = 20_000;
/** 回执自带 3 次重试，这是整组的封顶 */
const RECEIPT_TIMEOUT_MS = 30_000;
const OFFSET_FILE = "tg-offset.json";

export const INTAKE_RECEIPT = "已收到，消化中";
export const UNSUPPORTED_RECEIPT = "v1 只吃链接和文字，这条先没收下";

/** 出现任一键即判为「带媒体」；其余无 text 的消息（进群、置顶等服务消息）静默放过 */
const MEDIA_KEYS = [
  "photo", "document", "sticker", "video", "video_note", "voice", "audio",
  "animation", "location", "contact", "poll", "venue", "dice", "game", "invoice",
];

const URL_RE = /https?:\/\/[^\s<>"'）)】」》]+/i;
/** 中文句读常紧贴 URL 末尾（「看这个 https://a.com/b。」），不剥会把它带进幂等键 */
const TRAILING_PUNCT_RE = /[.,;:!?。，、；：！？]+$/;

// --- Telegram 报文（只声明用得到的字段） ---

export interface TgEntity {
  type: string;
  /** UTF-16 码元偏移，与 JS 字符串下标同制，可直接 slice */
  offset: number;
  length: number;
  url?: string;
}

export interface TgMessage {
  message_id?: number;
  from?: { id?: number };
  chat?: { id?: number };
  text?: string;
  entities?: TgEntity[];
  [key: string]: unknown;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  [key: string]: unknown;
}

export type ParsedMessage =
  | { kind: "url"; url: string; note?: string }
  | { kind: "text"; text: string }
  | { kind: "unsupported" }
  | { kind: "ignore" };

// --- 解析（纯函数） ---

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

interface UrlHit {
  url: string;
  start: number;
  end: number;
}

/** entities 优先：`text_link` 的真实地址只存在于 entity 上，正则永远看不见它 */
function urlFromEntities(text: string, entities: TgEntity[]): UrlHit | null {
  for (const e of [...entities].sort((a, b) => a.offset - b.offset)) {
    if (e.type !== "url" && e.type !== "text_link") continue;
    const raw = e.type === "text_link" ? (e.url ?? "") : text.slice(e.offset, e.offset + e.length);
    if (isHttpUrl(raw)) return { url: raw, start: e.offset, end: e.offset + e.length };
  }
  return null;
}

/** 首个 http(s) 链接。裸域名（`example.com`，TG 也标成 url entity）不算——当纯文字笔记收 */
export function findFirstHttpUrl(text: string, entities?: TgEntity[]): UrlHit | null {
  const hit = entities?.length ? urlFromEntities(text, entities) : null;
  if (hit) return hit;
  const m = URL_RE.exec(text);
  if (!m) return null;
  const url = m[0].replace(TRAILING_PUNCT_RE, "");
  // end 用整段匹配长度（含被剥掉的句读）：句读既不该进 url，也不该留在备注里
  return isHttpUrl(url) ? { url, start: m.index, end: m.index + m[0].length } : null;
}

/**
 * 消息 → 入账形态。media 消息在 Telegram 里只有 `caption` 没有 `text`，
 * 所以「无 text」这一条就足以把图片/文件/贴纸挡在门外，不必逐类判。
 */
export function parseTelegramMessage(message: TgMessage): ParsedMessage {
  const text = typeof message.text === "string" ? message.text : "";
  if (!text.trim()) {
    return MEDIA_KEYS.some((k) => message[k] !== undefined) ? { kind: "unsupported" } : { kind: "ignore" };
  }
  const hit = findFirstHttpUrl(text, message.entities);
  if (!hit) return { kind: "text", text: text.trim() };
  const note = `${text.slice(0, hit.start)} ${text.slice(hit.end)}`.trim().replace(/\s+/g, " ");
  return note ? { kind: "url", url: hit.url, note } : { kind: "url", url: hit.url };
}

// --- offset 文件 ---

interface OffsetRecord {
  botId: string;
  offset: number;
}

function offsetPath(rootDir: string): string {
  return path.join(getDataDir(rootDir), "inbox", OFFSET_FILE);
}

/**
 * 读不出来（首次 / 坏文件 / 无权限）一律当「没有游标」→ 归零重取。
 * 最坏结果是把 TG 侧还留着的 24h 未确认更新重投一遍，全部被幂等键吸收；
 * 反过来「猜一个 offset」会真丢消息。
 */
async function readOffsetRecord(rootDir: string): Promise<OffsetRecord | null> {
  try {
    const raw = JSON.parse(await fs.readFile(offsetPath(rootDir), "utf-8")) as Partial<OffsetRecord>;
    if (typeof raw?.botId !== "string" || !Number.isInteger(raw.offset)) return null;
    return { botId: raw.botId, offset: raw.offset as number };
  } catch {
    return null;
  }
}

/** 临时文件 + rename：崩在写一半也不会留下半截 JSON（丢的那次写只会导致重投，不会丢消息） */
async function writeOffsetRecord(rootDir: string, record: OffsetRecord): Promise<void> {
  const file = offsetPath(rootDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record)}\n`, "utf-8");
  await fs.rename(tmp, file);
}

// --- 退避 ---

/** 1s→60s 封顶，半抖动（[base/2, base]）——多实例/多次重连不齐步撞上游 */
export function backoffDelayMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + rand() * 0.5));
}

// --- 对外契约 ---

export type PollerState = "polling" | "stopped" | "blocked_auth" | "conflict";

/** C3 doctor 消费：最近成功 poll 时间 / 最后 update_id / 停机原因 */
export interface PollerStatus {
  state: PollerState;
  lastPollOkAt?: string;
  lastUpdateId?: number;
  lastError?: string;
}

export interface TelegramPollerDeps {
  settings: InboxSettings;
  /** 固定落 targetWorkspaceId 指定的工作区（§2.1） */
  dataDir: string;
  /** 全局根：offset 文件不随工作区走 */
  rootDir: string;
  onItem: (item: InboxItem) => void;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** 测试注入假 TG server */
  apiBaseUrl?: string;
  sleep?: SleepFn;
  random?: () => number;
  /** 故障出口——不静默（默认 console.error） */
  onError?: (message: string) => void;
}

export interface TelegramPoller {
  start(): void;
  /** abort 在途 poll 并等循环退出；401/409 的停机原因不会被覆盖掉 */
  stop(): Promise<void>;
  getStatus(): PollerStatus;
}

class Poller implements TelegramPoller {
  private readonly allowed: Set<string>;
  private readonly now: () => number;
  private readonly sleepFn: SleepFn;
  private readonly random: () => number;
  private readonly report: (message: string) => void;
  private controller = new AbortController();
  private loop: Promise<void> | null = null;
  private botId: string | null = null;
  private offset = 0;
  private failures = 0;
  private status: PollerStatus = { state: "stopped" };

  constructor(private readonly deps: TelegramPollerDeps) {
    this.allowed = new Set(deps.settings.allowedUserIds);
    this.now = deps.now ?? (() => Date.now());
    this.sleepFn = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.report = deps.onError ?? ((m) => console.error(`[tg-poller] ${m}`));
  }

  start(): void {
    if (this.loop) return;
    this.controller = new AbortController();
    this.botId = null; // 重启可能是因为换了 token，botId 必须重新 getMe
    this.failures = 0;
    this.status = { ...this.status, state: "polling", lastError: undefined };
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    const loop = this.loop;
    if (this.status.state === "polling") this.status.state = "stopped";
    await loop;
  }

  getStatus(): PollerStatus {
    return { ...this.status };
  }

  private get stopping(): boolean {
    return this.controller.signal.aborted;
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopping) {
        try {
          await this.cycle();
          this.failures = 0;
        } catch (err) {
          if (this.stopping) break;
          if (!(await this.recover(err))) break;
        }
      }
    } finally {
      this.loop = null;
    }
  }

  private async cycle(): Promise<void> {
    if (!this.botId) await this.initBot();
    const updates = await this.withTimeout(POLL_HARD_TIMEOUT_MS, (signal) =>
      callTelegram<TgUpdate[]>(
        "getUpdates",
        { offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message"] },
        this.client(signal),
      ),
    );
    this.status.lastPollOkAt = new Date(this.now()).toISOString();
    this.status.lastError = undefined;
    await this.consumeBatch(Array.isArray(updates) ? updates : []);
  }

  /** 换 bot = 换 update_id 序列，旧游标必然对不上，只能归零并把新身份写回文件 */
  private async initBot(): Promise<void> {
    const me = await this.withTimeout(GETME_TIMEOUT_MS, (signal) =>
      callTelegram<{ id: number }>("getMe", {}, this.client(signal)),
    );
    const botId = String(me.id);
    const saved = await readOffsetRecord(this.deps.rootDir);
    if (saved && saved.botId === botId) {
      this.offset = saved.offset;
    } else {
      this.offset = 0;
      await writeOffsetRecord(this.deps.rootDir, { botId, offset: 0 });
    }
    this.botId = botId;
  }

  /**
   * offset 纪律的落点。`finally` 是关键：中途 appendItem 抛错时，已成功的连续前缀
   * 仍会写盘，错误再上抛去走退避——既不丢也不会跳过没落账的那条。
   */
  private async consumeBatch(updates: TgUpdate[]): Promise<void> {
    let advanced = 0;
    try {
      for (const update of updates) {
        if (!Number.isInteger(update?.update_id)) continue;
        await this.handleUpdate(update);
        this.offset = update.update_id + 1;
        this.status.lastUpdateId = update.update_id;
        advanced += 1;
      }
    } finally {
      if (advanced > 0) await this.persistOffset();
    }
  }

  private async persistOffset(): Promise<void> {
    try {
      await writeOffsetRecord(this.deps.rootDir, { botId: this.botId ?? "", offset: this.offset });
    } catch (err) {
      // item 已 fsync 落账，写不进游标只会让重启后重投一次（幂等键吸收）；但必须可见
      this.fail(`offset 落盘失败（重启后可能重复投递）：${errorText(err)}`);
    }
  }

  /** 返回即代表「这条可以推进 offset」；抛错 = 没落账，批到此为止 */
  private async handleUpdate(update: TgUpdate): Promise<void> {
    const message = update.message;
    if (!message) return; // 非 message 类 update：推进，不回执
    const fromId = message.from?.id;
    if (fromId === undefined || !this.allowed.has(String(fromId))) return; // 白名单外静默跳过，不回执
    const chatId = message.chat?.id;
    const parsed = parseTelegramMessage(message);
    if (parsed.kind === "ignore") return;
    if (parsed.kind === "unsupported") {
      if (chatId !== undefined) await this.receipt(chatId, UNSUPPORTED_RECEIPT);
      return;
    }
    await this.intake(update.update_id, chatId, parsed);
  }

  private async intake(
    updateId: number,
    chatId: number | undefined,
    parsed: Extract<ParsedMessage, { kind: "url" | "text" }>,
  ): Promise<void> {
    const payload = parsed.kind === "url" ? { url: parsed.url, ...(parsed.note ? { note: parsed.note } : {}) } : { text: parsed.text };
    const item = await appendItem(
      { source: "telegram", receiptStatus: "pending", updateId, ...(chatId !== undefined ? { chatId } : {}), ...payload },
      this.deps.dataDir,
    );
    // 回执与 receiptStatus 都写在交给 worker **之前**：worker 也是 read-modify-append
    // 同一条 item，两边并发写会互相把字段覆盖掉。
    const sent = chatId === undefined ? false : await this.receipt(chatId, INTAKE_RECEIPT);
    await this.markReceipt(item.id, sent);
    try {
      this.deps.onItem(item);
    } catch (err) {
      this.fail(`onItem 回调抛错（${item.id} 已落账，启动补扫会兜住）：${errorText(err)}`);
    }
  }

  private async markReceipt(id: string, sent: boolean): Promise<void> {
    try {
      await updateItem(id, { receiptStatus: sent ? "sent" : "failed" }, this.deps.dataDir);
    } catch (err) {
      this.fail(`回执状态写台账失败（${id}）：${errorText(err)}`);
    }
  }

  private receipt(chatId: number, text: string): Promise<boolean> {
    return this.withTimeout(RECEIPT_TIMEOUT_MS, (signal) => sendTelegramReceipt(chatId, text, this.client(signal)));
  }

  /** 返回 false = 循环终止（停机态） */
  private async recover(err: unknown): Promise<boolean> {
    const api = err instanceof TelegramApiError ? err : null;
    const detail = errorText(err);
    if (api?.status === 401) {
      return this.halt("blocked_auth", `bot token 被 Telegram 拒绝（401），去设置页重填后会自动重启：${detail}`);
    }
    if (api?.status === 409) {
      return this.halt("conflict", `同一个 bot token 另有消费者在轮询（409），关掉它再重启：${detail}`);
    }
    this.fail(detail);
    if (api?.status === 429) {
      // 限流是上游节流，不是本地故障：睡够 retry_after 即可，不升退避档位
      await this.sleepFn(api.retryAfterMs ?? 1_000, this.controller.signal);
      return true;
    }
    this.failures += 1;
    await this.sleepFn(backoffDelayMs(this.failures, this.random), this.controller.signal);
    return true;
  }

  private halt(state: PollerState, message: string): false {
    this.status.state = state;
    this.fail(message);
    return false;
  }

  private fail(message: string): void {
    const clean = this.redact(message);
    this.status.lastError = clean;
    this.report(clean);
  }

  private redact(text: string): string {
    const { botToken, proxyUrl } = this.deps.settings;
    return redactSecrets(text, { botToken, ...(proxyUrl ? { proxyUrl } : {}) });
  }

  private client(signal: AbortSignal): TelegramClientOptions {
    const { settings, fetchImpl, apiBaseUrl } = this.deps;
    return {
      botToken: settings.botToken,
      signal,
      sleep: this.sleepFn,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(settings.proxyUrl ? { proxyUrl: settings.proxyUrl } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    };
  }

  /**
   * 把「停机」与「硬超时」合成一个中止源。超时定时器用完即清——挂着的 65s 定时器
   * 会在 stop() 之后继续拖住进程退出。
   */
  private withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    const onStop = (): void => ctl.abort(new Error("poller 已停机"));
    if (this.stopping) onStop();
    else this.controller.signal.addEventListener("abort", onStop, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error(`请求超过 ${ms}ms 未返回`)), ms);
    timer.unref?.();
    return run(ctl.signal).finally(() => {
      clearTimeout(timer);
      this.controller.signal.removeEventListener("abort", onStop);
    });
  }
}

export function createTelegramPoller(deps: TelegramPollerDeps): TelegramPoller {
  return new Poller(deps);
}
