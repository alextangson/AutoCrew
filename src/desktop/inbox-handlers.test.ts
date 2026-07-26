import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inboxDeleteHandler,
  inboxListHandler,
  inboxReingestHandler,
  inboxRetryHandler,
  inboxStatusHandler,
} from "./inbox-handlers.js";
import { startInboxRuntime, stopInboxRuntime, type InboxRuntimeOptions } from "./inbox-runtime.js";
import { appendItem, getItem, type InboxItem, type NewInboxItem } from "../modules/inbox/inbox-store.js";
import type { PollerStatus, TelegramPoller, TelegramPollerDeps } from "../modules/inbox/telegram-poller.js";

let tmpHome: string;
let savedEnv: string | undefined;
let processed: string[];

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-inbox-handlers-"));
  savedEnv = process.env.AUTOCREW_DATA_DIR;
  process.env.AUTOCREW_DATA_DIR = tmpHome;
  processed = [];
});

afterEach(async () => {
  await stopInboxRuntime();
  if (savedEnv === undefined) delete process.env.AUTOCREW_DATA_DIR;
  else process.env.AUTOCREW_DATA_DIR = savedEnv;
  await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** runtime 未起时 handler 回退到 _dataDir——server 注入的当前工作区 */
const here = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ _dataDir: tmpHome, ...extra });

async function seed(input: Partial<NewInboxItem>): Promise<InboxItem> {
  return appendItem({ source: "telegram", ...input } as NewInboxItem, tmpHome);
}

function data(reply: Record<string, unknown>): Record<string, unknown> {
  expect(reply.ok).toBe(true);
  return reply.data as Record<string, unknown>;
}

function items(reply: Record<string, unknown>): InboxItem[] {
  return data(reply).items as InboxItem[];
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** runtime 起来才有 worker——重试是否真投递到队列只能这样验 */
async function startRuntime(): Promise<void> {
  await fs.writeFile(
    path.join(tmpHome, "inbox.json"),
    JSON.stringify({ botToken: "123:abc", allowedUserIds: ["7"], targetWorkspaceId: "default" }),
    "utf-8",
  );
  const fakePoller = (deps: TelegramPollerDeps): TelegramPoller => {
    void deps;
    const status: PollerStatus = { state: "polling" };
    return { start: () => {}, stop: async () => {}, getStatus: () => status };
  };
  const opts: InboxRuntimeOptions = {
    createPollerImpl: fakePoller,
    processItemImpl: async (item: InboxItem) => {
      processed.push(item.id);
      return { status: "digested" as const, targetIds: ["topic-1"] };
    },
    onError: () => {},
  };
  await startInboxRuntime(opts);
}

describe("inbox:list", () => {
  it("倒序返回（新的在前）并带各态计数", async () => {
    const old = await seed({ url: "https://example.com/1", receivedAt: "2026-07-01T00:00:00.000Z" });
    const mid = await seed({ url: "https://example.com/2", receivedAt: "2026-07-02T00:00:00.000Z", status: "failed" });
    const fresh = await seed({ url: "https://example.com/3", receivedAt: "2026-07-03T00:00:00.000Z", status: "failed" });

    const reply = await inboxListHandler(here());

    expect(items(reply).map((it) => it.id)).toEqual([fresh.id, mid.id, old.id]);
    expect(data(reply).counts).toEqual({ pending: 1, failed: 2 });
    expect(data(reply)).toMatchObject({ total: 3, hidden: 0 });
  });

  it("默认滤掉已移除项；include_hidden 才带出来", async () => {
    const kept = await seed({ url: "https://example.com/keep" });
    const gone = await seed({ url: "https://example.com/gone" });
    await inboxDeleteHandler(here({ id: gone.id }));

    const visible = await inboxListHandler(here());
    const all = await inboxListHandler(here({ include_hidden: true }));

    expect(items(visible).map((it) => it.id)).toEqual([kept.id]);
    expect(data(visible).hidden).toBe(1);
    expect(items(all).map((it) => it.id)).toEqual([gone.id, kept.id]);
  });

  it("空台账返回空列表而不是报错（首次使用就是这个态）", async () => {
    expect(items(await inboxListHandler(here()))).toEqual([]);
  });
});

describe("inbox:delete — 隐藏而非物理删", () => {
  it("台账留痕：hiddenAt 落在记录上，条目仍可读", async () => {
    const item = await seed({ url: "https://example.com/x" });

    const reply = await inboxDeleteHandler(here({ id: item.id }));

    expect(data(reply).hidden).toBe(true);
    const stored = await getItem(item.id, tmpHome);
    expect(stored?.hiddenAt).toBeTruthy();
    expect(stored?.status).toBe("pending"); // 状态机没被借用
  });

  it("终态条目一样能移除——移除与状态迁移正交", async () => {
    const done = await seed({ url: "https://example.com/done", status: "digested", targetIds: ["topic-9"] });

    expect(data(await inboxDeleteHandler(here({ id: done.id }))).hidden).toBe(true);
    expect((await getItem(done.id, tmpHome))?.status).toBe("digested");
  });

  it("restore 清掉 hiddenAt——移除有后悔药", async () => {
    const item = await seed({ url: "https://example.com/undo" });
    await inboxDeleteHandler(here({ id: item.id }));

    const reply = await inboxDeleteHandler(here({ id: item.id, restore: true }));

    expect(data(reply).hidden).toBe(false);
    expect((await getItem(item.id, tmpHome))?.hiddenAt).toBeUndefined();
    expect(items(await inboxListHandler(here())).map((it) => it.id)).toEqual([item.id]);
  });

  it("不存在的 id 报错，不静默成功", async () => {
    expect(await inboxDeleteHandler(here({ id: "inbox-nope" }))).toMatchObject({ ok: false });
  });
});

describe("inbox:retry", () => {
  it("rejected 翻回 pending（人工复活），并保留 stage 断点", async () => {
    const item = await seed({
      url: "https://example.com/r",
      status: "rejected",
      stage: "card_done",
      failReason: "内容太薄",
      errorCode: "unusable",
    });

    const reply = await inboxRetryHandler(here({ id: item.id }));

    expect(data(reply).queued).toBe(false); // runtime 没起来，照实说
    expect(data(reply).note).toContain("worker");
    const stored = await getItem(item.id, tmpHome);
    expect(stored).toMatchObject({ status: "pending", stage: "card_done" });
    expect(stored?.failReason).toBeUndefined();
  });

  it("digested 拒绝重试并指向「重新消化」", async () => {
    const item = await seed({ url: "https://example.com/d", status: "digested" });

    expect(await inboxRetryHandler(here({ id: item.id }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("重新消化"),
    });
  });

  it("处理中的条目不许被掀翻（worker 正握着租约）", async () => {
    const item = await seed({ url: "https://example.com/f", status: "fetching", claimedAt: new Date().toISOString() });

    expect(await inboxRetryHandler(here({ id: item.id }))).toMatchObject({ ok: false });
    expect(await inboxReingestHandler(here({ id: item.id }))).toMatchObject({ ok: false });
  });

  it("attempts 超限的 failed 项：清零后真的被 worker 重跑", async () => {
    const item = await seed({ url: "https://example.com/exhausted", status: "failed", attempts: 3 });
    await startRuntime();

    const reply = await inboxRetryHandler({ id: item.id });

    expect(data(reply).queued).toBe(true);
    await waitFor(() => processed.includes(item.id), "超限项被重跑");
    expect((await getItem(item.id, tmpHome))?.status).toBe("digested");
  });
});

describe("inbox:reingest", () => {
  it("digested 重新消化：清 stage 与 attempts、回 pending，落点先留着", async () => {
    const item = await seed({
      url: "https://example.com/again",
      status: "digested",
      stage: "topic_done",
      attempts: 2,
      verdict: "both",
      targetIds: ["pat-x", "topic-x"],
      failReason: "上一轮的旧话",
    });

    await inboxReingestHandler(here({ id: item.id }));

    const stored = await getItem(item.id, tmpHome);
    expect(stored).toMatchObject({ status: "pending", attempts: 0, verdict: "both", targetIds: ["pat-x", "topic-x"] });
    expect(stored?.stage).toBeUndefined();
    expect(stored?.failReason).toBeUndefined();
  });

  it("runtime 起来时直接进队列并跑完", async () => {
    const item = await seed({ url: "https://example.com/redo", status: "rejected" });
    await startRuntime();

    expect(data(await inboxReingestHandler({ id: item.id })).queued).toBe(true);
    await waitFor(() => processed.includes(item.id), "重新消化真的跑了");
  });
});

describe("工作区归属与状态透传", () => {
  it("runtime 已接线时读 targetWorkspace 的台账，不跟随传入的 _dataDir", async () => {
    const item = await seed({ url: "https://example.com/target" });
    await startRuntime();
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-other-ws-"));

    const reply = await inboxListHandler({ _dataDir: elsewhere });

    expect(items(reply).map((it) => it.id)).toEqual([item.id]);
    await fs.rm(elsewhere, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("inbox:status 透传 runtime 状态——未配置是可见状态不是错误", async () => {
    expect(data(await inboxStatusHandler({}))).toMatchObject({ state: "stopped" });

    await startRuntime();

    expect(data(await inboxStatusHandler({}))).toMatchObject({
      state: "running",
      targetWorkspaceId: "default",
      dataDir: tmpHome,
    });
  });
});
