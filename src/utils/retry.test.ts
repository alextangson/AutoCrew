import { describe, it, expect } from "vitest";
import { withRetry, RetryableError, checkFetchResponse } from "../utils/retry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
  });

  it("retries on RetryableError and succeeds", async () => {
    let attempt = 0;
    const result = await withRetry(
      async () => {
        attempt++;
        if (attempt < 3) throw new RetryableError("temp fail", 503);
        return "ok";
      },
      { maxRetries: 3, baseDelayMs: 10 },
    );
    expect(result).toBe("ok");
    expect(attempt).toBe(3);
  });

  it("throws after max retries exhausted", async () => {
    await expect(
      withRetry(
        async () => { throw new RetryableError("always fail", 500); },
        { maxRetries: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow("always fail");
  });

  it("does NOT retry non-retryable errors", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        async () => {
          attempt++;
          throw new Error("bad request");
        },
        { maxRetries: 3, baseDelayMs: 10 },
      ),
    ).rejects.toThrow("bad request");
    expect(attempt).toBe(1); // Only one attempt, no retry
  });

  it("retries on network-like TypeError", async () => {
    let attempt = 0;
    const result = await withRetry(
      async () => {
        attempt++;
        if (attempt < 2) throw new TypeError("fetch failed");
        return "recovered";
      },
      { maxRetries: 2, baseDelayMs: 10 },
    );
    expect(result).toBe("recovered");
  });
});

describe("checkFetchResponse", () => {
  it("does nothing for ok response", () => {
    const res = { ok: true, status: 200 } as Response;
    expect(() => checkFetchResponse(res, "test")).not.toThrow();
  });

  it("throws RetryableError for 429", () => {
    const res = { ok: false, status: 429 } as Response;
    expect(() => checkFetchResponse(res, "test")).toThrow(RetryableError);
  });

  it("throws RetryableError for 503", () => {
    const res = { ok: false, status: 503 } as Response;
    expect(() => checkFetchResponse(res, "test")).toThrow(RetryableError);
  });

  it("throws regular Error for 400", () => {
    const res = { ok: false, status: 400 } as Response;
    try {
      checkFetchResponse(res, "test");
      expect.unreachable();
    } catch (err) {
      expect(err).not.toBeInstanceOf(RetryableError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("throws regular Error for 401", () => {
    const res = { ok: false, status: 401 } as Response;
    try {
      checkFetchResponse(res, "test");
      expect.unreachable();
    } catch (err) {
      expect(err).not.toBeInstanceOf(RetryableError);
    }
  });
});
