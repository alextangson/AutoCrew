import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getInboxRuntimeStatus,
  startInboxRuntime,
  stopInboxRuntime,
  type InboxRuntimeOptions,
} from "./inbox-runtime.js";
import { setInboxSettings } from "./settings-inbox.js";
import { appendItem, getItem, type InboxItem, type NewInboxItem } from "../modules/inbox/inbox-store.js";
import type { PollerStatus, TelegramPoller, TelegramPollerDeps } from "../modules/inbox/telegram-poller.js";

let tmpHome: string;
let savedEnv: string | undefined;
let created: PollerRecord[];
let processed: string[];

interface PollerRecord {
  deps: TelegramPollerDeps;
  started: number;
  stopped: number;
  status: PollerStatus;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-inbox-runtime-"));
  savedEnv = process.env.AUTOCREW_DATA_DIR;
  process.env.AUTOCREW_DATA_DIR = tmpHome; // 注册表 / inbox.json / offset 全部隔离
  created = [];
  processed = [];
});

afterEach(async () => {
  await stopInboxRuntime();
  if (savedEnv === undefined) delete process.env.AUTOCREW_DATA_DIR;
  else process.env.AUTOCREW_DATA_DIR = savedEnv;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function fakePoller(deps: TelegramPollerDeps): TelegramPoller {
  const rec: PollerRecord = { deps, started: 0, stopped: 0, status: { state: "stopped" } };
  created.push(rec);
  return {
    start: () => {
      rec.started += 1;
      rec.status = { state: "polling" };
    },
    stop: async () => {
      rec.stopped += 1;
      rec.status = { state: "stopped" };
    },
    getStatus: () => rec.status,
  };
}

function options(over: Partial<InboxRuntimeOptions> = {}): InboxRuntimeOptions {
  return {
    createPollerImpl: fakePoller,
    processItemImpl: async (item: InboxItem) => {
      processed.push(item.id);
      return { status: "digested" as const, targetIds: ["topic-1"] };
    },
    onError: () => {},
    ...over,
  };
}

async function writeInboxSettings(over: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(
    path.join(tmpHome, "inbox.json"),
    JSON.stringify({ botToken: "123:abc", allowedUserIds: ["7"], targetWorkspaceId: "default", ...over }),
    "utf-8",
  );
}

async function seed(input: Partial<NewInboxItem>): Promise<InboxItem> {
  return appendItem({ source: "telegram", ...input } as NewInboxItem, tmpHome);
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * 消化结果由 **worker** 在 processItem 返回之后写台账——拿 processItem 被调用过当
 * 「已落定」的信号会读到时序快照，必须等台账本身。
 */
function settled(id: string): () => Promise<boolean> {
  return async () => (await getItem(id, tmpHome))?.status === "digested";
}

describe("inbox runtime · 可见的不启动状态", () => {
  it("未配置 → not_configured，不建 poller；配好 token 后自动起来", async () => {
    const status = await startInboxRuntime(options());

    expect(status.state).toBe("not_configured");
    expect(status.detail).toContain("bot token");
    expect(created).toHaveLength(0);

    // 未配置时也订阅了配置变更：保存 token 那一刻自己起来，不用重启 server
    await setInboxSettings({ _rootDir: tmpHome, bot_token: "123:abc", allowed_user_ids: ["7"] });
    await waitFor(() => getInboxRuntimeStatus().state === "running", "配置后自动启动");
    expect(created).toHaveLength(1);
  });

  it("目标工作区不在注册表 → workspace_missing，不建 poller", async () => {
    await writeInboxSettings({ targetWorkspaceId: "ws-gone" });

    const status = await startInboxRuntime(options());

    expect(status).toMatchObject({ state: "workspace_missing", targetWorkspaceId: "ws-gone" });
    expect(status.detail).toContain("ws-gone");
    expect(created).toHaveLength(0);
    expect(getInboxRuntimeStatus().state).toBe("workspace_missing");
  });
});

describe("inbox runtime · 启动接线", () => {
  it("配置齐 → 回收过期 claim、补扫 pending、开 poller", async () => {
    await writeInboxSettings();
    const stuck = await seed({
      url: "https://example.com/a",
      status: "fetching",
      claimedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const pending = await seed({ url: "https://example.com/b" });
    const blocked = await seed({ url: "https://example.com/c", status: "blocked" });

    const status = await startInboxRuntime(options());

    expect(status).toMatchObject({ state: "running", targetWorkspaceId: "default", dataDir: tmpHome });
    expect(created).toHaveLength(1);
    expect(created[0].started).toBe(1);
    expect(created[0].deps).toMatchObject({ dataDir: tmpHome, rootDir: tmpHome });
    expect(created[0].deps.settings.botToken).toBe("123:abc");
    expect(getInboxRuntimeStatus().poller?.state).toBe("polling");

    await waitFor(settled(stuck.id), "回收项消化落账");
    await waitFor(settled(pending.id), "补扫 pending 消化落账");
    expect(processed.sort()).toEqual([pending.id, stuck.id].sort());
    // blocked 等的是外部条件，启动补扫不动它
    expect(processed).not.toContain(blocked.id);
    expect((await getItem(blocked.id, tmpHome))?.status).toBe("blocked");
  });

  it("poller 收到的新消息进 worker", async () => {
    await writeInboxSettings();
    await startInboxRuntime(options());
    const item = await seed({ url: "https://example.com/new" });

    created[0].deps.onItem(item);

    await waitFor(() => processed.includes(item.id), "新消息被消化");
  });

  it("stopInboxRuntime → 停 poller 并落 stopped", async () => {
    await writeInboxSettings();
    await startInboxRuntime(options());

    const status = await stopInboxRuntime();

    expect(status.state).toBe("stopped");
    expect(created[0].stopped).toBe(1);
    expect(getInboxRuntimeStatus().state).toBe("stopped");
  });
});

describe("inbox runtime · 配置变更热重启", () => {
  it("停旧 poller、按新配置重开，并唤醒 blocked 项", async () => {
    await writeInboxSettings();
    const blocked = await seed({ url: "https://example.com/blocked", status: "blocked" });
    await startInboxRuntime(options());
    expect(processed).not.toContain(blocked.id);

    await setInboxSettings({ _rootDir: tmpHome, allowed_user_ids: ["7", "8"] });

    await waitFor(() => created.length === 2, "poller 重建");
    expect(created[0].stopped).toBe(1);
    expect(created[1].started).toBe(1);
    expect(created[1].deps.settings.allowedUserIds).toEqual(["7", "8"]);

    await waitFor(settled(blocked.id), "blocked 项被唤醒并消化落账");
    expect(processed).toContain(blocked.id);
  });
});

describe("引擎配置钩子与事件时序", () => {
  it("引擎配置保存 → 唤醒 blocked → 消化完成;onInboxEvent 全程跟车", async () => {
    const { setEngineSettings } = await import("./settings.js");
    await writeInboxSettings();
    const events: string[] = [];
    let engineReady = false;
    await startInboxRuntime(
      options({
        processItemImpl: async () =>
          engineReady
            ? { status: "digested" as const }
            : { status: "blocked" as const, errorCode: "engine_unavailable" },
        onInboxEvent: (evt) => events.push(evt.itemId),
      }),
    );
    const item = await seed({ url: "https://example.com/blocked" });
    created[0]!.deps.onItem(item);
    await waitFor(async () => (await getItem(item.id, tmpHome))?.status === "blocked", "先卡在 blocked");
    engineReady = true;
    await setEngineSettings({ _dataDir: tmpHome, api_key: "sk-wake-inbox-1234" });
    await waitFor(settled(item.id), "唤醒后消化完成");
    // fetching/blocked → 唤醒 pending → fetching/digested,至少 4 次写账通知
    expect(events.filter((id) => id === item.id).length).toBeGreaterThanOrEqual(4);
  });
});
