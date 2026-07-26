import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createInboxWorker,
  getInboxWorker,
  resetInboxWorker,
  retryDelayMs,
  LEASE_MS,
  MAX_ATTEMPTS,
  type InboxWorker,
  type InboxWorkerDeps,
  type ProcessResult,
  type TimerHandle,
} from "./inbox-worker.js";
import { appendItem, getItem, listItems, updateItem, type InboxItem } from "./inbox-store.js";

let dataDir: string;
let workers: InboxWorker[] = [];

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-inbox-worker-"));
});

afterEach(async () => {
  for (const w of workers) w.stop();
  workers = [];
  resetInboxWorker();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** 收集被安排的退避重投，由测试手动触发——不让测试等真实定时器 */
interface FakeTimers {
  scheduled: Array<{ ms: number; fire: () => void }>;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
}

function fakeTimers(): FakeTimers {
  const scheduled: FakeTimers["scheduled"] = [];
  return {
    scheduled,
    setTimer: (fn, ms) => {
      const entry = { ms, fire: fn };
      scheduled.push(entry);
      return {
        cancel: () => {
          const at = scheduled.indexOf(entry);
          if (at >= 0) scheduled.splice(at, 1);
        },
      };
    },
  };
}

function makeWorker(over: Partial<InboxWorkerDeps> = {}): InboxWorker {
  const w = createInboxWorker({
    dataDir,
    processItem: async () => ({ status: "digested" }),
    setTimer: fakeTimers().setTimer,
    onError: () => {},
    ...over,
  });
  workers.push(w);
  return w;
}

const newItem = (over: Partial<InboxItem> = {}) =>
  appendItem({ source: "telegram", url: "https://example.com/a", ...over }, dataDir);

describe("happy path", () => {
  it("claims with fetching + claimedAt, then settles to digested", async () => {
    const seen: string[] = [];
    const worker = makeWorker({
      processItem: async (item) => {
        seen.push(item.status);
        // claim 已落盘：管线看到的是 fetching + 带 lease 的 item
        expect(item.claimedAt).toBeTruthy();
        expect((await getItem(item.id, dataDir))?.status).toBe("fetching");
        return { status: "digested", verdict: "both", targetIds: ["topic-1", "pat-1"] };
      },
    });

    const item = await newItem();
    worker.enqueue(item);
    await worker.idle();

    const settled = await getItem(item.id, dataDir);
    expect(seen).toEqual(["fetching"]);
    expect(settled).toMatchObject({
      status: "digested",
      verdict: "both",
      targetIds: ["topic-1", "pat-1"],
      attempts: 1,
      retryable: false,
    });
    expect(settled?.claimedAt).toBeUndefined(); // lease 释放
  });

  it("keeps the stage checkpoint across a retry (both 的断点续做)", async () => {
    const results: ProcessResult[] = [
      { status: "failed", stage: "card_done", errorCode: "net" },
      { status: "digested" },
    ];
    const worker = makeWorker({ processItem: async () => results.shift()! });

    const item = await newItem();
    worker.enqueue(item);
    await worker.idle();
    expect((await getItem(item.id, dataDir))?.stage).toBe("card_done");

    worker.requestRetry(item.id);
    await worker.idle();
    const done = await getItem(item.id, dataDir);
    expect(done).toMatchObject({ status: "digested", stage: "card_done", attempts: 2 });
  });

  it("does not reprocess a terminal item", async () => {
    let calls = 0;
    const worker = makeWorker({
      processItem: async () => {
        calls++;
        return { status: "rejected", failReason: "内容太薄" };
      },
    });

    const item = await newItem();
    worker.enqueue(item);
    await worker.idle();
    worker.requestRetry(item.id);
    worker.enqueue(item);
    await worker.idle();

    expect(calls).toBe(1);
    expect(await getItem(item.id, dataDir)).toMatchObject({ status: "rejected", retryable: false });
  });
});

describe("serial execution", () => {
  it("never interleaves two concurrently enqueued items", async () => {
    const trace: string[] = [];
    const worker = makeWorker({
      processItem: async (item) => {
        trace.push(`enter:${item.id}`);
        await new Promise((r) => setTimeout(r, 5));
        trace.push(`exit:${item.id}`);
        return { status: "digested" };
      },
    });

    const a = await newItem({ id: "inbox-a" });
    const b = await newItem({ id: "inbox-b" });
    worker.enqueue(a);
    worker.enqueue(b);
    await worker.idle();

    expect(trace).toEqual(["enter:inbox-a", "exit:inbox-a", "enter:inbox-b", "exit:inbox-b"]);
  });

  it("collapses duplicate deliveries of the same id already waiting in the queue", async () => {
    let calls = 0;
    const worker = makeWorker({
      processItem: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { status: "digested" };
      },
    });

    const a = await newItem({ id: "inbox-a" });
    const b = await newItem({ id: "inbox-b" });
    worker.enqueue(a);
    worker.enqueue(b);
    worker.enqueue(b); // 并发同链接第二次投递
    worker.requestRetry("inbox-b");
    await worker.idle();

    expect(calls).toBe(2);
  });

  it("keeps draining after one item throws", async () => {
    const errors: string[] = [];
    const worker = makeWorker({
      processItem: async (item) => {
        if (item.id === "inbox-a") throw new Error("抓取炸了");
        return { status: "digested" };
      },
      onError: (err) => errors.push(String(err)),
    });

    worker.enqueue(await newItem({ id: "inbox-a" }));
    worker.enqueue(await newItem({ id: "inbox-b" }));
    await worker.idle();

    // 管线抛错被翻译成可重试 failed 并留痕，而不是冒泡打断队列
    expect(errors).toEqual([]);
    expect(await getItem("inbox-a", dataDir)).toMatchObject({
      status: "failed",
      errorCode: "process_threw",
      failReason: "抓取炸了",
      retryable: true,
    });
    expect((await getItem("inbox-b", dataDir))?.status).toBe("digested");
  });
});

describe("attempts cap", () => {
  it("stops at failed after MAX_ATTEMPTS and refuses further deliveries", async () => {
    let calls = 0;
    const worker = makeWorker({
      processItem: async () => {
        calls++;
        return { status: "failed", errorCode: "timeout", failReason: "抓取超时" };
      },
    });

    const item = await newItem();
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      worker.requestRetry(item.id);
      await worker.idle();
    }

    expect(calls).toBe(MAX_ATTEMPTS);
    expect(await getItem(item.id, dataDir)).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      retryable: false,
      failReason: "抓取超时",
    });
  });

  it("becomes retryable again once attempts are reset on the ledger", async () => {
    const worker = makeWorker({ processItem: async () => ({ status: "digested" }) });
    const item = await newItem({ status: "failed", attempts: MAX_ATTEMPTS });

    worker.requestRetry(item.id);
    await worker.idle();
    expect((await getItem(item.id, dataDir))?.status).toBe("failed");

    await updateItem(item.id, { attempts: 0 }, dataDir);
    worker.requestRetry(item.id);
    await worker.idle();
    expect((await getItem(item.id, dataDir))?.status).toBe("digested");
  });

  it("schedules an exponential-backoff redelivery for retryable failures", async () => {
    const timers = fakeTimers();
    const outcomes: ProcessResult[] = [{ status: "failed", errorCode: "net" }, { status: "digested" }];
    const worker = makeWorker({
      processItem: async () => outcomes.shift()!,
      setTimer: timers.setTimer,
    });

    worker.enqueue(await newItem({ id: "inbox-a" }));
    await worker.idle();

    expect(timers.scheduled.map((t) => t.ms)).toEqual([retryDelayMs(1)]);
    timers.scheduled[0].fire();
    await worker.idle();
    expect((await getItem("inbox-a", dataDir))?.status).toBe("digested");
  });

  it("grows the backoff and caps it", () => {
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(2)).toBe(10_000);
    expect(retryDelayMs(3)).toBe(20_000);
    expect(retryDelayMs(50)).toBe(5 * 60_000);
  });
});

describe("blocked", () => {
  it("does not consume an attempt and is not auto-redelivered", async () => {
    const timers = fakeTimers();
    const worker = makeWorker({
      processItem: async () => ({ status: "blocked", errorCode: "missing_tikhub_key" }),
      setTimer: timers.setTimer,
    });

    const item = await newItem();
    worker.enqueue(item);
    await worker.idle();

    expect(await getItem(item.id, dataDir)).toMatchObject({
      status: "blocked",
      attempts: 0, // claim 时 +1，blocked 结论回滚——等外部条件不算一次尝试
      retryable: true,
      errorCode: "missing_tikhub_key",
    });
    expect(timers.scheduled).toHaveLength(0);
  });

  it("wakeBlocked requeues every blocked item and records why", async () => {
    const outcomes: ProcessResult[] = [
      { status: "blocked", errorCode: "missing_tikhub_key" },
      { status: "digested" },
    ];
    const worker = makeWorker({ processItem: async () => outcomes.shift()! });

    const item = await newItem();
    worker.enqueue(item);
    await worker.idle();

    worker.wakeBlocked("tikhub_key_saved");
    await worker.idle();

    const done = await getItem(item.id, dataDir);
    expect(done).toMatchObject({ status: "digested", attempts: 1 });
    // 台账里留下了「因为什么被唤醒」的那一行
    const raw = await fs.readFile(path.join(dataDir, "inbox", "inbox.jsonl"), "utf-8");
    expect(raw).toContain("tikhub_key_saved");
  });

  it("leaves non-blocked items alone when waking", async () => {
    let calls = 0;
    const worker = makeWorker({
      processItem: async () => {
        calls++;
        return { status: "digested" };
      },
    });
    await newItem({ id: "inbox-pending" });
    await newItem({ id: "inbox-done", status: "digested" });
    await newItem({ id: "inbox-failed", status: "failed", attempts: 1 });

    worker.wakeBlocked("engine_configured");
    await worker.idle();

    expect(calls).toBe(0);
    expect((await getItem("inbox-done", dataDir))?.status).toBe("digested");
    expect((await getItem("inbox-pending", dataDir))?.status).toBe("pending");
    expect((await getItem("inbox-failed", dataDir))?.status).toBe("failed");
  });
});

describe("lease reclaim", () => {
  it("resets fetching items whose lease expired back to pending", async () => {
    const stale = new Date(Date.now() - LEASE_MS - 1_000).toISOString();
    const item = await newItem({ status: "fetching", claimedAt: stale, attempts: 1 });
    const worker = makeWorker();

    const reclaimed = await worker.reclaimExpiredClaims();

    expect(reclaimed.map((i) => i.id)).toEqual([item.id]);
    expect(await getItem(item.id, dataDir)).toMatchObject({ status: "pending", attempts: 1 });
    expect((await getItem(item.id, dataDir))?.claimedAt).toBeUndefined();
  });

  it("leaves a live lease and every non-fetching status untouched", async () => {
    const fresh = await newItem({ id: "inbox-live", status: "fetching", claimedAt: new Date().toISOString() });
    await newItem({ id: "inbox-pending" });
    await newItem({ id: "inbox-digested", status: "digested" });
    const worker = makeWorker();

    expect(await worker.reclaimExpiredClaims()).toEqual([]);
    expect((await getItem(fresh.id, dataDir))?.status).toBe("fetching");
  });

  it("treats a fetching record with no claimedAt as expired (dirty write)", async () => {
    await newItem({ id: "inbox-dirty", status: "fetching" });
    const worker = makeWorker();
    expect((await worker.reclaimExpiredClaims()).map((i) => i.id)).toEqual(["inbox-dirty"]);
  });

  it("refuses to claim an item whose lease is still alive", async () => {
    let calls = 0;
    const worker = makeWorker({
      processItem: async () => {
        calls++;
        return { status: "digested" };
      },
    });
    const live = await newItem({ status: "fetching", claimedAt: new Date().toISOString() });

    worker.enqueue(live);
    await worker.idle();
    expect(calls).toBe(0);
  });

  it("reclaims an expired lease inline when the item is redelivered", async () => {
    const stale = new Date(Date.now() - LEASE_MS - 1_000).toISOString();
    const worker = makeWorker({ processItem: async () => ({ status: "digested" }) });
    const item = await newItem({ status: "fetching", claimedAt: stale, attempts: 1 });

    worker.enqueue(item);
    await worker.idle();
    // 崩溃重跑消耗一次 attempts —— 反复崩的 item 不会无限重跑
    expect(await getItem(item.id, dataDir)).toMatchObject({ status: "digested", attempts: 2 });
  });
});

describe("lifecycle", () => {
  it("idle resolves immediately when nothing is queued", async () => {
    await expect(makeWorker().idle()).resolves.toBeUndefined();
  });

  it("stop drops queued work, pending timers, and later deliveries", async () => {
    const timers = fakeTimers();
    let calls = 0;
    const worker = makeWorker({
      processItem: async () => {
        calls++;
        return { status: "failed", errorCode: "net" };
      },
      setTimer: timers.setTimer,
    });

    worker.enqueue(await newItem({ id: "inbox-a" }));
    await worker.idle();
    expect(timers.scheduled).toHaveLength(1);

    worker.stop();
    expect(timers.scheduled).toHaveLength(0);
    worker.enqueue(await newItem({ id: "inbox-b" }));
    await worker.idle();
    expect(calls).toBe(1);
  });

  it("getInboxWorker returns one process-wide instance until reset", () => {
    const deps: InboxWorkerDeps = { dataDir, processItem: async () => ({ status: "digested" }) };
    const first = getInboxWorker(deps);
    expect(getInboxWorker(deps)).toBe(first);
    resetInboxWorker();
    expect(getInboxWorker(deps)).not.toBe(first);
  });

  it("does not touch items that vanished from the ledger", async () => {
    const worker = makeWorker();
    worker.requestRetry("inbox-ghost");
    await worker.idle();
    expect(await listItems(dataDir)).toEqual([]);
  });
});

describe("onItemChanged（SSE 视图刷新用的写账后通知）", () => {
  it("claim 与 settle 各通知一次，末事件状态即台账终态", async () => {
    const events: string[] = [];
    const worker = makeWorker({ onItemChanged: (item) => events.push(item.status) });
    worker.enqueue(await newItem({ id: "inbox-evt" }));
    await worker.idle();
    expect(events).toEqual(["fetching", "digested"]);
    expect((await getItem("inbox-evt", dataDir))?.status).toBe("digested");
  });

  it("wake 的 blocked→pending 写账也通知；监听者每次都抛错也不影响消化", async () => {
    const events: string[] = [];
    const errPhases: string[] = [];
    let ready = false;
    const worker = makeWorker({
      processItem: async () =>
        ready ? { status: "digested" as const } : { status: "blocked" as const, errorCode: "engine_unavailable" },
      onItemChanged: (item) => {
        events.push(item.status);
        throw new Error("listener boom");
      },
      onError: (_e, ctx) => errPhases.push(ctx.phase),
    });
    worker.enqueue(await newItem({ id: "inbox-wake-evt" }));
    await worker.idle();
    expect(events).toEqual(["fetching", "blocked"]);
    ready = true;
    worker.wakeBlocked("test");
    await worker.idle();
    expect(events).toEqual(["fetching", "blocked", "pending", "fetching", "digested"]);
    expect((await getItem("inbox-wake-evt", dataDir))?.status).toBe("digested");
    expect(errPhases.filter((p) => p === "on_item_changed")).toHaveLength(events.length);
  });
});

describe("settledAt（「灵感段」计时：receivedAt → 落定）", () => {
  const AT = Date.parse("2026-07-20T08:00:00.000Z");
  const SETTLED: Array<ProcessResult["status"]> = ["digested", "rejected", "blocked", "failed"];

  for (const status of SETTLED) {
    it(`${status} 落定时盖 settledAt（四种终态一视同仁）`, async () => {
      const worker = makeWorker({ processItem: async () => ({ status }), now: () => AT });
      const item = await newItem({ id: `inbox-settled-${status}` });
      worker.enqueue(item);
      await worker.idle();

      const settled = await getItem(item.id, dataDir);
      expect(settled?.status).toBe(status);
      expect(settled?.settledAt).toBe(new Date(AT).toISOString());
    });
  }

  it("claim（fetching）不是落定：处理中不许有 settledAt", async () => {
    let midFlight: InboxItem | null = null;
    const worker = makeWorker({
      processItem: async (item) => {
        midFlight = await getItem(item.id, dataDir);
        return { status: "digested" };
      },
    });
    worker.enqueue(await newItem({ id: "inbox-settled-midflight" }));
    await worker.idle();

    expect(midFlight!.status).toBe("fetching");
    expect(midFlight!.settledAt).toBeUndefined();
    expect((await getItem("inbox-settled-midflight", dataDir))?.settledAt).toBeTruthy();
  });

  it("重试后再落终态：settledAt 更新成最近一次，不停在首次失败", async () => {
    let clock = AT;
    let attempt = 0;
    const worker = makeWorker({
      processItem: async () => (++attempt === 1 ? { status: "failed", errorCode: "timeout" } : { status: "digested" }),
      now: () => clock,
    });
    const item = await newItem({ id: "inbox-settled-retry" });

    worker.enqueue(item);
    await worker.idle();
    const firstSettled = (await getItem(item.id, dataDir))?.settledAt;
    expect(firstSettled).toBe(new Date(AT).toISOString());

    clock = AT + 90_000;
    worker.requestRetry(item.id);
    await worker.idle();

    const final = await getItem(item.id, dataDir);
    expect(final?.status).toBe("digested");
    expect(final?.settledAt).toBe(new Date(AT + 90_000).toISOString());
  });

  it("灵感段用时可算：receivedAt → settledAt 是一段真实时长", async () => {
    const worker = makeWorker({ processItem: async () => ({ status: "digested" }), now: () => AT });
    const item = await newItem({
      id: "inbox-settled-span",
      receivedAt: new Date(AT - 3 * 3600_000).toISOString(),
    });
    worker.enqueue(item);
    await worker.idle();

    const settled = await getItem(item.id, dataDir);
    expect(Date.parse(settled!.settledAt!) - Date.parse(settled!.receivedAt)).toBe(3 * 3600_000);
  });
});
