import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { listItems, type InboxItem } from "./inbox-store.js";
import {
  COMMAND_RECEIPT,
  INTAKE_RECEIPT,
  UNSUPPORTED_RECEIPT,
  createTelegramPoller,
  sendTelegramReceipt,
  type TelegramPoller,
  type TelegramPollerDeps,
  type TgMessage,
  type TgUpdate,
} from "./telegram-poller.js";

const BOT_TOKEN = "123456:AAH-secret-token";
const BOT_ID = 42;
const ALLOWED = 5150;
const STRANGER = 999;
const CHAT = 8800;

// --- 假 TG server（本地环回，不出网） ---

interface HeldPoll {
  res: http.ServerResponse;
  offset: number;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => void (raw += c));
    req.on("end", () => resolve(raw));
    req.on("error", () => resolve("{}"));
  });
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 复刻 getUpdates 的确认语义：offset 以下的更新在服务端被丢弃，没有新数据就挂着不回 */
class FakeTelegram {
  readonly server: http.Server;
  base = "";
  botId = BOT_ID;
  pollOffsets: number[] = [];
  abortedPolls = 0;
  sent: Array<{ chat_id: number; text: string }> = [];
  sendStatus: number | null = null;
  pollError: { status: number; body: unknown; times: number } | null = null;
  private pending: TgUpdate[] = [];
  private held: HeldPoll[] = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      res.on("error", () => {});
      void this.route(req, res);
    });
    this.server.on("clientError", () => {});
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const h of this.held.splice(0)) this.reply(h.res, 200, { ok: true, result: [] });
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** 只入库、不唤醒挂起的长轮询——用来构造「服务端有数据但这次 poll 拿不到」 */
  stage(...updates: TgUpdate[]): void {
    this.pending.push(...updates);
  }

  push(...updates: TgUpdate[]): void {
    this.stage(...updates);
    this.flush();
  }

  private reply(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const method = (req.url ?? "").split("/").pop() ?? "";
    if (method === "getMe") return this.reply(res, 200, { ok: true, result: { id: this.botId, is_bot: true } });
    if (method === "sendMessage") return this.onSend(res, raw);
    if (method === "getUpdates") return this.onPoll(res, raw);
    this.reply(res, 404, { ok: false, description: `no method ${method}` });
  }

  private onSend(res: http.ServerResponse, raw: string): void {
    const p = safeJson(raw) as { chat_id?: number; text?: string };
    this.sent.push({ chat_id: p.chat_id ?? 0, text: p.text ?? "" });
    const fail = { ok: false, error_code: this.sendStatus, description: "send failed" };
    if (this.sendStatus) return this.reply(res, this.sendStatus, fail);
    this.reply(res, 200, { ok: true, result: { message_id: this.sent.length } });
  }

  private onPoll(res: http.ServerResponse, raw: string): void {
    const offset = Number(safeJson(raw).offset ?? 0);
    this.pollOffsets.push(offset);
    if (this.pollError && this.pollError.times !== 0) {
      if (this.pollError.times > 0) this.pollError.times -= 1;
      return this.reply(res, this.pollError.status, this.pollError.body);
    }
    this.pending = this.pending.filter((u) => u.update_id >= offset);
    if (this.pending.length) return this.reply(res, 200, { ok: true, result: [...this.pending] });
    const entry: HeldPoll = { res, offset };
    this.held.push(entry);
    res.on("close", () => {
      const at = this.held.indexOf(entry);
      if (at >= 0) {
        this.held.splice(at, 1);
        this.abortedPolls += 1;
      }
    });
  }

  private flush(): void {
    for (const entry of this.held.splice(0)) {
      const ready = this.pending.filter((u) => u.update_id >= entry.offset);
      if (ready.length) this.reply(entry.res, 200, { ok: true, result: ready });
      else this.held.push(entry);
    }
  }
}

// --- 夹具 ---

let dataDir: string;
let rootDir: string;
let fake: FakeTelegram;
let pollers: TelegramPoller[] = [];
let received: InboxItem[] = [];
let errors: string[] = [];
let sleeps: number[] = [];

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 记录退避时长但只真睡一瞬——既能断言 retry_after，又不让失败重试空转成热循环 */
const fakeSleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
  await delay(5);
};

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await delay(10);
  }
}

function makePoller(over: Partial<TelegramPollerDeps> = {}): TelegramPoller {
  const poller = createTelegramPoller({
    settings: { botToken: BOT_TOKEN, allowedUserIds: [String(ALLOWED)], targetWorkspaceId: "ws" },
    dataDir,
    rootDir,
    onItem: (item) => received.push(item),
    apiBaseUrl: fake.base,
    sleep: fakeSleep,
    random: () => 0.5,
    onError: (m) => errors.push(m),
    ...over,
  });
  pollers.push(poller);
  return poller;
}

function update(id: number, text: string, over: Partial<TgMessage> = {}, from = ALLOWED): TgUpdate {
  return { update_id: id, message: { message_id: id, from: { id: from }, chat: { id: CHAT }, text, ...over } };
}

const offsetFile = (): string => path.join(rootDir, "inbox", "tg-offset.json");
const ledgerFile = (): string => path.join(dataDir, "inbox", "inbox.jsonl");

async function readOffset(): Promise<{ botId: string; offset: number } | null> {
  const raw = await fs.readFile(offsetFile(), "utf-8").catch(() => "");
  return raw ? (JSON.parse(raw) as { botId: string; offset: number }) : null;
}

async function seedOffset(record: { botId: string; offset: number }): Promise<void> {
  await fs.mkdir(path.dirname(offsetFile()), { recursive: true });
  await fs.writeFile(offsetFile(), JSON.stringify(record));
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-tg-data-"));
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-tg-root-"));
  fake = new FakeTelegram();
  await fake.listen();
  received = [];
  errors = [];
  sleeps = [];
});

afterEach(async () => {
  for (const p of pollers) await p.stop();
  pollers = [];
  await fake.close();
  if (fsSync.existsSync(ledgerFile())) fsSync.chmodSync(ledgerFile(), 0o644);
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// --- offset 纪律 ---

describe("offset 纪律", () => {
  it("批中途 append 失败：offset 只停在最后一条成功的，重启后补齐且不重复", async () => {
    let sabotaged = false;
    const poller = makePoller({
      onItem: (item) => {
        received.push(item);
        // 第一条落账后把台账改成只读：下一条 appendItem 必然失败，但已落的行原样保留
        if (!sabotaged) {
          sabotaged = true;
          fsSync.chmodSync(ledgerFile(), 0o444);
        }
      },
    });
    fake.push(
      update(101, "https://example.com/a"),
      update(102, "https://example.com/b"),
      update(103, "https://example.com/c"),
    );

    poller.start();
    await waitFor(async () => (await readOffset())?.offset === 102, "offset 停在 102");
    expect((await listItems(dataDir)).length).toBe(1);
    await poller.stop();

    // 磁盘修好 → 新实例接着上次的游标跑
    fsSync.chmodSync(ledgerFile(), 0o644);
    const resumed = makePoller();
    resumed.start();
    await waitFor(async () => (await listItems(dataDir)).length === 3, "剩余两条补齐");
    await resumed.stop();

    const items = await listItems(dataDir);
    expect(items.map((i) => i.updateId).sort((a, b) => a! - b!)).toEqual([101, 102, 103]);
    const urls = new Map(items.map((i) => [i.updateId, i.url]));
    expect(urls.get(101)).toBe("https://example.com/a");
    expect(urls.get(102)).toBe("https://example.com/b");
    expect(urls.get(103)).toBe("https://example.com/c");
    expect(await readOffset()).toEqual({ botId: String(BOT_ID), offset: 104 });
  });

  it("白名单外的消息静默跳过，但 offset 照样推进（否则毒丸死循环）", async () => {
    const poller = makePoller();
    fake.push(update(201, "https://evil.example.com/x", {}, STRANGER), update(202, "https://example.com/ok"));

    poller.start();
    await waitFor(async () => (await readOffset())?.offset === 203, "offset 推过陌生人那条");
    const items = await listItems(dataDir);
    expect(items.length).toBe(1);
    expect(items[0].url).toBe("https://example.com/ok");
    expect(fake.sent.map((s) => s.text)).toEqual([INTAKE_RECEIPT]); // 陌生人拿不到任何回执
  });

  it("不支持的类型：回执后推进 offset，不入账", async () => {
    const poller = makePoller();
    fake.push(update(301, "", { photo: [{ file_id: "x" }] }), update(302, "随手记"));

    poller.start();
    await waitFor(async () => (await readOffset())?.offset === 303, "offset 推过图片那条");
    expect(fake.sent[0]).toEqual({ chat_id: CHAT, text: UNSUPPORTED_RECEIPT });
    const items = await listItems(dataDir);
    expect(items.length).toBe(1);
    expect(items[0].text).toBe("随手记");
  });

  it("非 message 类 update 也推进 offset", async () => {
    const poller = makePoller();
    fake.push({ update_id: 401, my_chat_member: { status: "member" } }, update(402, "https://example.com/z"));

    poller.start();
    await waitFor(async () => (await readOffset())?.offset === 403, "offset 推过非 message");
    expect((await listItems(dataDir)).length).toBe(1);
  });

  it("stop() 中止在途 poll 且不推进 offset，重启后那条消息还在", async () => {
    await seedOffset({ botId: String(BOT_ID), offset: 500 });
    const poller = makePoller();
    poller.start();
    await waitFor(() => fake.pollOffsets.length >= 1, "第一次长轮询挂起");
    expect(fake.pollOffsets[0]).toBe(500); // botId 一致 → 沿用旧游标

    fake.stage(update(500, "https://example.com/held")); // 服务端有数据，但这次 poll 不喂给它
    await poller.stop();

    await waitFor(() => fake.abortedPolls >= 1, "在途 poll 被 abort");
    expect(await readOffset()).toEqual({ botId: String(BOT_ID), offset: 500 });
    expect(await listItems(dataDir)).toEqual([]);
    expect(poller.getStatus().state).toBe("stopped");

    const resumed = makePoller();
    resumed.start();
    await waitFor(async () => (await listItems(dataDir)).length === 1, "重启后消息补上");
    expect((await listItems(dataDir))[0].url).toBe("https://example.com/held");
  });
});

// --- botId 身份 ---

describe("botId 与 offset 文件", () => {
  it("botId 不一致 → 重置 offset 并重写文件", async () => {
    await seedOffset({ botId: "999", offset: 500 });
    const poller = makePoller();
    poller.start();
    await waitFor(() => fake.pollOffsets.length >= 1, "首次轮询");
    expect(fake.pollOffsets[0]).toBe(0);
    expect(await readOffset()).toEqual({ botId: String(BOT_ID), offset: 0 });
  });

  it("首次运行（无文件）落一份 {botId, offset:0}", async () => {
    const poller = makePoller();
    poller.start();
    await waitFor(async () => (await readOffset()) !== null, "写出 offset 文件");
    expect(await readOffset()).toEqual({ botId: String(BOT_ID), offset: 0 });
  });
});

// --- 错误纪律 ---

describe("错误纪律", () => {
  it("401 → blocked_auth 并停轮询，stop 后可重新 start", async () => {
    fake.pollError = { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" }, times: -1 };
    const poller = makePoller();
    poller.start();
    await waitFor(() => poller.getStatus().state === "blocked_auth", "转 blocked_auth");

    const pollsAtHalt = fake.pollOffsets.length;
    await delay(60);
    expect(fake.pollOffsets.length).toBe(pollsAtHalt); // 真的停了，不自旋
    await poller.stop();
    expect(poller.getStatus().state).toBe("blocked_auth"); // stop 不抹掉诊断

    fake.pollError = null;
    poller.start();
    expect(poller.getStatus().state).toBe("polling");
    fake.push(update(701, "https://example.com/after-fix"));
    await waitFor(async () => (await listItems(dataDir)).length === 1, "恢复后继续消费");
  });

  it("409 → conflict 并停轮询", async () => {
    fake.pollError = { status: 409, body: { ok: false, error_code: 409, description: "Conflict" }, times: -1 };
    const poller = makePoller();
    poller.start();
    await waitFor(() => poller.getStatus().state === "conflict", "转 conflict");
    const pollsAtHalt = fake.pollOffsets.length;
    await delay(60);
    expect(fake.pollOffsets.length).toBe(pollsAtHalt);
    expect(poller.getStatus().lastError).toContain("409");
  });

  it("429 按 retry_after 睡，之后恢复", async () => {
    fake.pollError = {
      status: 429,
      body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } },
      times: 1,
    };
    const poller = makePoller();
    poller.start();
    await waitFor(() => sleeps.includes(7_000), "按 retry_after 睡 7s");
    fake.push(update(801, "https://example.com/after-429"));
    await waitFor(async () => (await listItems(dataDir)).length === 1, "限流过后继续消费");
    expect(poller.getStatus().state).toBe("polling");
  });

  it("网络错误走指数退避，不改状态", async () => {
    const poller = makePoller({ apiBaseUrl: "http://127.0.0.1:1", random: () => 1 });
    poller.start();
    await waitFor(() => sleeps.length >= 2, "退避了至少两轮");
    expect(sleeps[0]).toBe(1_000); // rand=1 → 取档位上沿，看得见 1s→2s 的翻倍
    expect(sleeps[1]).toBe(2_000);
    expect(poller.getStatus().state).toBe("polling");
    expect(poller.getStatus().lastError).toBeTruthy();
  });

  it("错误文本里的 bot token 被脱敏", async () => {
    fake.pollError = {
      status: 500,
      body: { ok: false, description: `boom at /bot${BOT_TOKEN}/getUpdates` },
      times: -1,
    };
    const poller = makePoller();
    poller.start();
    await waitFor(() => errors.length >= 1, "记下错误");
    expect(poller.getStatus().lastError).not.toContain(BOT_TOKEN);
    expect(poller.getStatus().lastError).toContain("/bot***/getUpdates");
    expect(errors.join("\n")).not.toContain(BOT_TOKEN);
  });
});

// --- 入账与回执 ---

describe("入账与回执", () => {
  it("链接 + 备注入账，回执「已收到，消化中」，receiptStatus=sent", async () => {
    const poller = makePoller();
    fake.push(update(901, "存一下 https://example.com/post 讲结构的"));
    poller.start();
    await waitFor(async () => (await listItems(dataDir)).length === 1, "落账");

    const [item] = await listItems(dataDir);
    expect(item.url).toBe("https://example.com/post");
    expect(item.note).toBe("存一下 讲结构的");
    expect(item.text).toBeUndefined();
    expect(item.source).toBe("telegram");
    expect(item.status).toBe("pending");
    expect(item.chatId).toBe(CHAT);
    expect(item.updateId).toBe(901);
    expect(item.canonicalUrl).toBeUndefined(); // 幂等键在解重定向之后才算，poller 不预判
    await waitFor(async () => (await listItems(dataDir))[0].receiptStatus === "sent", "回执标 sent");
    expect(fake.sent).toEqual([{ chat_id: CHAT, text: INTAKE_RECEIPT }]);
    // 交给 worker 是回执落盘之后的下一步，等它发生再断言（别读时序快照）
    await waitFor(() => received.length === 1, "交给 worker");
    expect(received[0].id).toBe(item.id);
  });

  it("回执发不出去只标 failed，消化照常（item 仍交给 worker）", async () => {
    fake.sendStatus = 500;
    const poller = makePoller();
    fake.push(update(902, "https://example.com/x"));
    poller.start();
    // 顺序是「发回执 → 标 receiptStatus → 交 worker → 推进 offset」，
    // 等最后一步发生再断言，别拿 receiptStatus 当整批完成的信号（会读到时序快照）
    await waitFor(() => received.length === 1, "交给 worker");
    await waitFor(async () => (await readOffset())?.offset === 903, "offset 推进");
    expect((await listItems(dataDir))[0]?.receiptStatus).toBe("failed");
    // 全量并行负载下见过一次 3 缺 1（未复现出根因）：给第三发一个有界等待，
    // 仍然精确断言 3——多发会在这里立刻暴露，少发超时报的是哪一步清清楚楚
    await waitFor(() => fake.sent.length >= 3, "3 次重试都发了");
    expect(fake.sent.length).toBe(3);
  });

  it("纯文字 → text item，无 url/note", async () => {
    const poller = makePoller();
    fake.push(update(903, "  想做一期讲选题的  "));
    poller.start();
    await waitFor(async () => (await listItems(dataDir)).length === 1, "落账");
    const [item] = await listItems(dataDir);
    expect(item.text).toBe("想做一期讲选题的");
    expect(item.url).toBeUndefined();
    expect(item.note).toBeUndefined();
  });

  it("拦截器吃下的纯文本不入账、不回执（每日选题摘要的数字回复）", async () => {
    const seen: Array<{ text: string; chatId?: number; userId: string }> = [];
    const poller = makePoller({
      interceptText: async (msg) => {
        seen.push(msg);
        return msg.text === "2";
      },
    });
    fake.push(update(910, " 2 "), update(911, "这条是真的灵感"));
    poller.start();
    await waitFor(async () => (await listItems(dataDir)).length === 1, "只有非拦截的那条落账");
    await waitFor(async () => (await readOffset())?.offset === 912, "两条都推进 offset");

    expect(seen.map((s) => s.text)).toEqual(["2", "这条是真的灵感"]);
    expect(seen[0]).toMatchObject({ chatId: CHAT, userId: String(ALLOWED) });
    const items = await listItems(dataDir);
    expect(items.map((i) => i.text)).toEqual(["这条是真的灵感"]);
    // 被拦下的那条不发「已收到，消化中」——它的回执由拦截器自己发
    expect(fake.sent.map((s) => s.text)).toEqual([INTAKE_RECEIPT]);
  });

  it("拦截器抛错：这条按普通消息入账，错误进 lastError（不吞消息）", async () => {
    const poller = makePoller({
      interceptText: async () => {
        throw new Error("状态文件坏了");
      },
    });
    fake.push(update(920, "3"));
    poller.start();
    await waitFor(async () => (await listItems(dataDir)).length === 1, "照常落账");
    expect((await listItems(dataDir))[0].text).toBe("3");
    expect(errors.some((e) => e.includes("文本拦截器抛错"))).toBe(true);
  });

  it("getStatus 暴露 doctor 要的三件套", async () => {
    const poller = makePoller();
    expect(poller.getStatus()).toEqual({ state: "stopped" });
    fake.push(update(904, "https://example.com/s"));
    poller.start();
    await waitFor(() => poller.getStatus().lastUpdateId === 904, "记下 lastUpdateId");
    const status = poller.getStatus();
    expect(status.state).toBe("polling");
    expect(Date.parse(status.lastPollOkAt!)).toBeGreaterThan(0);
    expect(status.lastError).toBeUndefined();
    expect(status.lastErrorAt).toBeUndefined();
  });

  it("失败同时记下 lastError 与 lastErrorAt（卡上要说得清「是不是刚刚」）", async () => {
    fake.pollError = { status: 500, body: { ok: false, description: "boom" }, times: 1 };
    const poller = makePoller();
    poller.start();
    await waitFor(() => Boolean(poller.getStatus().lastErrorAt), "记下失败时间");
    const status = poller.getStatus();
    expect(status.lastError).toContain("500");
    expect(Date.parse(status.lastErrorAt!)).toBeGreaterThan(0);
  });
});

// --- 回执 API ---

describe("sendTelegramReceipt", () => {
  const ctx = (): Parameters<typeof sendTelegramReceipt>[2] => ({
    botToken: BOT_TOKEN,
    apiBaseUrl: fake.base,
    sleep: fakeSleep,
  });

  it("成功一次即返回 true", async () => {
    expect(await sendTelegramReceipt(CHAT, "hi", ctx())).toBe(true);
    expect(fake.sent).toEqual([{ chat_id: CHAT, text: "hi" }]);
  });

  it("可重试错误：重试 3 次后返回 false，不抛", async () => {
    fake.sendStatus = 500;
    expect(await sendTelegramReceipt(CHAT, "hi", ctx())).toBe(false);
    expect(fake.sent.length).toBe(3);
    expect(sleeps).toEqual([500, 1_000]);
  });

  it("确定性错误（403 被拉黑）当场放弃，不空转三轮", async () => {
    fake.sendStatus = 403;
    expect(await sendTelegramReceipt(CHAT, "hi", ctx())).toBe(false);
    expect(fake.sent.length).toBe(1);
  });
});

  it("/start 回引导语、不入台账、offset 照常推进", async () => {
    const poller = makePoller();
    fake.push(update(905, "/start"));
    poller.start();
    await waitFor(async () => (await readOffset())?.offset === 906, "offset 推进");
    expect(fake.sent).toEqual([{ chat_id: CHAT, text: COMMAND_RECEIPT }]);
    expect(await listItems(dataDir)).toEqual([]);
    expect(received).toEqual([]);
  });
