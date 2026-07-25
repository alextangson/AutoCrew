/**
 * Telegram Bot API 客户端 — 只负责「一次调用」：拼 URL、发请求、把 Telegram 的错误形状
 * 收敛成 TelegramApiError（带 status 与 retryAfterMs）。轮询循环、offset 纪律、消息解析
 * 都在 telegram-poller.ts；回执发送在这里，因为 B4 的消化管线也要独立用它。
 *
 * 三条硬约束：
 * 1. **bot token 在 URL 路径里**——任何进日志/状态的错误文本都必须过 `redactSecrets`，
 *    否则一次 fetch 失败就能把 token 打出去。
 * 2. **代理必须显式**：Node fetch 不读系统代理，大陆网络下不配 `proxyUrl` 就是连不上。
 *    ProxyAgent 按 proxyUrl 缓存复用——每请求新建会漏 socket。
 * 3. **回执失败不抛**：回执是旁路，发不出去只标记 receiptStatus，绝不回滚消化结果（§2.1）。
 */
import { ProxyAgent } from "undici";

export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

/** 回执重试 3 次（§2.1），退避 0.5s → 1s */
export const RECEIPT_ATTEMPTS = 3;
const RECEIPT_BACKOFF_MS = 500;
/** 确定性错误：重试也不会变（400 参数错 / 401 token 废 / 403 被拉黑 / 404 chat 不存在） */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404]);
const JSON_HEADERS = { "content-type": "application/json" };

/** scheme://user[:pass]@host —— 只吃凭证段，端口/路径原样保留（与 settings-inbox 同款） */
const PROXY_CRED_RE = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]+@/i;

export interface TelegramRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  /** undici ProxyAgent：Node 全局 fetch 认这个扩展字段，标准 RequestInit 类型里没有 */
  dispatcher?: ProxyAgent;
}

/** 测试注入点：假 TG server 只需实现这个签名 */
export type FetchLike = (url: string, init: TelegramRequestInit) => Promise<Response>;

/** 中止即 resolve（不 reject）——调用方靠自己的 stopping 标志决定下一步，不用 catch 兜 abort */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface TelegramClientOptions {
  botToken: string;
  apiBaseUrl?: string;
  proxyUrl?: string;
  fetchImpl?: FetchLike;
  sleep?: SleepFn;
  signal?: AbortSignal;
}

export class TelegramApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

interface TelegramEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

// --- 脱敏 ---

/** 代理串凭证段脱敏；无凭证或不成串则原样回——它不是密钥，不瞎猜 */
export function maskProxyUrl(url: string): string {
  return PROXY_CRED_RE.test(url) ? url.replace(PROXY_CRED_RE, "$1***:***@") : url;
}

/** 错误文本出模块前的最后一道闸：token 整体抹掉、代理凭证脱敏。split/join 免去正则转义 */
export function redactSecrets(text: string, secrets: { botToken?: string; proxyUrl?: string }): string {
  let out = text;
  if (secrets.botToken) out = out.split(secrets.botToken).join("***");
  if (secrets.proxyUrl) out = out.split(secrets.proxyUrl).join(maskProxyUrl(secrets.proxyUrl));
  return out;
}

/** fetch 的真实原因藏在 cause 里（ECONNREFUSED 之类），带上才可诊断 */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && cause.message ? `${err.message}（${cause.message}）` : err.message;
}

// --- 传输 ---

const dispatcherCache = new Map<string, ProxyAgent>();

/** 按 proxyUrl 缓存 ProxyAgent；地址不合法时抛脱敏后的错，不让原串进异常文本 */
export function proxyDispatcher(proxyUrl?: string): ProxyAgent | undefined {
  if (!proxyUrl) return undefined;
  const cached = dispatcherCache.get(proxyUrl);
  if (cached) return cached;
  let agent: ProxyAgent;
  try {
    agent = new ProxyAgent(proxyUrl);
  } catch {
    throw new Error(`代理地址无法使用：${maskProxyUrl(proxyUrl)}`);
  }
  dispatcherCache.set(proxyUrl, agent);
  return agent;
}

const nativeFetch: FetchLike = (url, init) => fetch(url, init as Parameters<typeof fetch>[1]);

function retryAfterMs(body: TelegramEnvelope<unknown>, res: Response): number | undefined {
  const fromBody = body.parameters?.retry_after;
  if (typeof fromBody === "number" && fromBody >= 0) return Math.round(fromBody * 1000);
  // 头缺失时不能直接 Number()——Number(null) 是 0，会被当成「立刻重试」，退化成热循环
  const header = res.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/**
 * 调一次 Bot API。业务失败（ok=false / 非 2xx）一律抛 TelegramApiError；
 * 网络与 abort 原样上抛，由调用方按 `signal.aborted` 区分「停机」与「断网」。
 */
export async function callTelegram<T>(
  method: string,
  params: Record<string, unknown>,
  opts: TelegramClientOptions,
): Promise<T> {
  const base = (opts.apiBaseUrl ?? DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, "");
  const dispatcher = proxyDispatcher(opts.proxyUrl);
  const res = await (opts.fetchImpl ?? nativeFetch)(`${base}/bot${opts.botToken}/${method}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(params),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  });

  const raw = await res.text();
  let body: TelegramEnvelope<T>;
  try {
    body = JSON.parse(raw) as TelegramEnvelope<T>;
  } catch {
    throw new TelegramApiError(res.status, undefined, `${method} 响应不是合法 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || body.ok !== true) {
    const status = res.ok ? (body.error_code ?? res.status) : res.status;
    throw new TelegramApiError(
      status,
      retryAfterMs(body, res),
      `${method} 失败（HTTP ${status}）：${body.description ?? (raw.slice(0, 200) || "无描述")}`,
    );
  }
  return body.result as T;
}

/** 默认 sleep：中止即提前 resolve，且不拖住进程退出 */
export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener("abort", finish, { once: true });
  });

/**
 * 发一条回执。重试 `RECEIPT_ATTEMPTS` 次后返回 false，**永不抛**——
 * 回执是旁路：发不出去只标 receiptStatus=failed，消化结果照落（§2.1）。
 * 确定性错误（400/401/403/404）当场放弃，不空转三轮。
 */
export async function sendTelegramReceipt(
  chatId: number,
  text: string,
  opts: TelegramClientOptions,
): Promise<boolean> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= RECEIPT_ATTEMPTS; attempt++) {
    try {
      await callTelegram("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }, opts);
      return true;
    } catch (err) {
      if (opts.signal?.aborted) return false;
      const api = err instanceof TelegramApiError ? err : null;
      if (api && NON_RETRYABLE_STATUS.has(api.status)) return false;
      if (attempt === RECEIPT_ATTEMPTS) return false;
      await sleep(api?.retryAfterMs ?? RECEIPT_BACKOFF_MS * attempt, opts.signal);
    }
  }
  return false;
}
