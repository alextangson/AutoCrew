/**
 * Retry utility — exponential backoff for external API calls.
 *
 * Retries on network errors and 429/500/502/503 status codes.
 * Does NOT retry on 400/401/403/404 (client errors).
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

export class RetryableError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  if (err instanceof TypeError && err.message.includes("fetch")) return true; // Network error
  if (err instanceof Error && err.message.includes("ECONNREFUSED")) return true;
  if (err instanceof Error && err.message.includes("ETIMEDOUT")) return true;
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

      if (attempt === maxRetries || !isRetryable(err)) {
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
