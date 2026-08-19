/**
 * Retry utility — exponential backoff for external API calls.
 *
 * Retries on network errors and transient upstream status codes.
 * Does NOT retry on 400/401/403/404 (client errors).
 *
 * 524/520/522/408 = Cloudflare 边缘瞬时超时（relay 在 CF 后面时长文生成常触发）。
 * dogfood 实测:公众号长文单次调用曾 524 直接终止——加入重试集。
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * 用户中止信号（对话控制面设计 §Phase 3）：signal.aborted 时的失败一律不重试。
   * 中止本来就长得像瞬时网络错误（AbortError / "aborted"），不特判就会被重试通道
   * 原样重放一遍——用户点了停止，模型却又被叫起来跑一次。
   */
  signal?: AbortSignal;
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);

export class RetryableError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  if (err instanceof TypeError && err.message.includes("fetch")) return true; // Network error
  // 每轮硬超时中止（AbortSignal.timeout）:relay 挂起,中止后应重试整轮
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return true;
  if (err instanceof Error) {
    const m = err.message;
    // undici 流式连接被中途掐断（relay 长流时会发生,dogfood 实测）+ 空闲超时中止 + 常见网络瞬时错误
    if (m === "terminated" || m.includes("other side closed") || m.includes("UND_ERR")) return true;
    if (m.includes("idle timeout") || m.includes("aborted") || m.includes("ECONNREFUSED") || m.includes("ECONNRESET") || m.includes("ETIMEDOUT") || m.includes("EPIPE")) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with exponential backoff retry.
 *
 * @example
 * const result = await withRetry(() => callGeminiAPI(prompt), { maxRetries: 3 });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 1000;
  const maxDelay = opts?.maxDelayMs ?? 10000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // 用户中止：这次失败是我们自己掐的，重试等于无视用户的「停止」
      if (opts?.signal?.aborted || attempt === maxRetries || !isRetryable(err)) {
        throw err;
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelay * 2 ** attempt + Math.random() * 500, maxDelay);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Wrap a fetch response check — throws RetryableError for retryable status codes.
 */
export function checkFetchResponse(res: Response, context: string): void {
  if (res.ok) return;

  if (RETRYABLE_STATUS_CODES.has(res.status)) {
    throw new RetryableError(`${context}: HTTP ${res.status}`, res.status);
  }

  // Non-retryable error — throw a regular error
  throw new Error(`${context}: HTTP ${res.status}`);
}
