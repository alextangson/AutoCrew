import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectInboxDoctorChecks,
  formatInboxDoctorChecks,
  inboxDoctorHandler,
  type DoctorCheck,
  type InboxDoctorDeps,
  type InboxDoctorKey,
} from "./inbox-doctor.js";
import type { InboxRuntimeStatus } from "./inbox-runtime.js";
import type { PollerStatus } from "../modules/inbox/telegram-poller.js";
import { appendItem, type InboxItem } from "../modules/inbox/inbox-store.js";
import { upsertPatternCard, deletePatternCard, type PatternCardInput } from "../modules/patterns/pattern-store.js";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox-1",
    source: "telegram",
    receivedAt: ago(MINUTE),
    status: "pending",
    attempts: 0,
    ...over,
  };
}

function running(poller: PollerStatus): InboxRuntimeStatus {
  return { state: "running", targetWorkspaceId: "ws-1", dataDir: "/tmp/ws-1", poller };
}

/** 默认打桩：三项互不干扰——测哪项就只喂哪项的输入 */
async function checks(
  status: InboxRuntimeStatus,
  over: Partial<InboxDoctorDeps> = {},
): Promise<Record<InboxDoctorKey, DoctorCheck>> {
  const list = await collectInboxDoctorChecks({
    status: () => status,
    now: () => NOW,
    listItemsImpl: async () => [],
    listPatternsImpl: async () => [],
    ...over,
  });
  return Object.fromEntries(list.map((c) => [c.key, c])) as Record<InboxDoctorKey, DoctorCheck>;
}

describe("检查一 · 收件箱 runtime", () => {
  it("未配置是中性提示，不是错误", async () => {
    const c = (await checks({ state: "not_configured", detail: "未配置 Telegram bot token（设置页 · 灵感收件箱）" })).inboxRuntime;
    expect(c.level).toBe("neutral");
    expect(c.hint).toContain("设置页");
  });

  it("目标工作区缺失是红，带 runtime 给的人话原因", async () => {
    const c = (await checks({ state: "workspace_missing", targetWorkspaceId: "ws-gone", detail: "目标工作区不存在：ws-gone" })).inboxRuntime;
    expect(c.level).toBe("error");
    expect(c.hint).toContain("ws-gone");
  });

  it("轮询中且心跳新鲜是绿，附最近成功 poll 时间与 lastUpdateId", async () => {
    const lastPollOkAt = ago(30_000);
    const c = (await checks(running({ state: "polling", lastPollOkAt, lastUpdateId: 4242 }))).inboxRuntime;
    expect(c.level).toBe("ok");
    expect(c.label).toContain(lastPollOkAt);
    expect(c.label).toContain("4242");
  });

  it("心跳超过 5 分钟转黄「轮询可能卡住」", async () => {
    const c = (await checks(running({ state: "polling", lastPollOkAt: ago(6 * MINUTE), lastUpdateId: 7 }))).inboxRuntime;
    expect(c.level).toBe("warn");
    expect(c.label).toContain("卡住");
  });

  it("刚起还没有成功轮询记录 → 黄，不冒充绿", async () => {
    const c = (await checks(running({ state: "polling" }))).inboxRuntime;
    expect(c.level).toBe("warn");
  });

  it("blocked_auth → 红：token 失效，去设置页更新", async () => {
    const c = (await checks(running({ state: "blocked_auth", lastError: "401 Unauthorized" }))).inboxRuntime;
    expect(c.level).toBe("error");
    expect(c.label).toContain("401");
    expect(c.hint).toContain("设置页");
  });

  it("conflict → 红：同 token 另有消费者（409）", async () => {
    const c = (await checks(running({ state: "conflict", lastError: "409 Conflict" }))).inboxRuntime;
    expect(c.level).toBe("error");
    expect(c.label).toContain("409");
  });

  it("runtime 停机 → 黄", async () => {
    expect((await checks({ state: "stopped" })).inboxRuntime.level).toBe("warn");
  });
});

describe("检查二 · 积压", () => {
  it("无积压 → 绿附条数", async () => {
    const c = (
      await checks(running({ state: "polling", lastPollOkAt: ago(1000) }), {
        listItemsImpl: async () => [item({ id: "a", status: "digested" }), item({ id: "b", status: "rejected" })],
      })
    ).inboxBacklog;
    expect(c.level).toBe("ok");
    expect(c.label).toContain("2");
  });

  it("30 分钟内的待处理项仍是绿（正常处理中）", async () => {
    const c = (
      await checks(running({ state: "polling", lastPollOkAt: ago(1000) }), {
        listItemsImpl: async () => [item({ id: "fresh", receivedAt: ago(10 * MINUTE) })],
      })
    ).inboxBacklog;
    expect(c.level).toBe("ok");
  });

  it("最老 pending 超 30 分钟 → 黄，点名那一条", async () => {
    const c = (
      await checks(running({ state: "polling", lastPollOkAt: ago(1000) }), {
        listItemsImpl: async () => [
          item({ id: "old-one", receivedAt: ago(45 * MINUTE) }),
          item({ id: "newer", receivedAt: ago(2 * MINUTE) }),
        ],
      })
    ).inboxBacklog;
    expect(c.level).toBe("warn");
    expect(c.label).toContain("old-one");
  });

  it("failed 也算积压，超 24h → 红并说明 TG 24h 丢件语义", async () => {
    const c = (
      await checks(running({ state: "polling", lastPollOkAt: ago(1000) }), {
        listItemsImpl: async () => [item({ id: "stale", status: "failed", receivedAt: ago(25 * HOUR) })],
      })
    ).inboxBacklog;
    expect(c.level).toBe("error");
    expect(c.hint).toContain("24h");
    expect(c.hint).toContain("丢弃");
  });

  it("台账读不出来 → 红附原因，不炸掉整轮检查", async () => {
    const c = (
      await checks(running({ state: "polling", lastPollOkAt: ago(1000) }), {
        listItemsImpl: async () => {
          throw new Error("EACCES: permission denied");
        },
      })
    ).inboxBacklog;
    expect(c.level).toBe("error");
    expect(c.label).toContain("EACCES");
  });

  it("没有目标工作区时不检查积压（中性，不误报）", async () => {
    expect((await checks({ state: "not_configured" })).inboxBacklog.level).toBe("neutral");
  });
});

describe("检查三 · patterns 库", () => {
  it("能读 → 绿附卡片数", async () => {
    const c = (
      await checks(running({ state: "polling", lastPollOkAt: ago(1000) }), {
        listPatternsImpl: async () => [{ id: "pat-1" }, { id: "pat-2" }] as never,
      })
    ).patternsLibrary;
    expect(c.level).toBe("ok");
    expect(c.label).toContain("2");
  });

  it("读失败 → 红附原因", async () => {
    const c = (
      await checks(running({ state: "polling", lastPollOkAt: ago(1000) }), {
        listPatternsImpl: async () => {
          throw new Error("EIO: i/o error");
        },
      })
    ).patternsLibrary;
    expect(c.level).toBe("error");
    expect(c.label).toContain("EIO");
  });
});

describe("输出与 IPC 出口", () => {
  it("文本版式跟随既有 doctor：标记 + key + 结论 + 缩进指引", () => {
    const text = formatInboxDoctorChecks([
      { key: "inboxRuntime", level: "ok", label: "轮询中" },
      { key: "inboxBacklog", level: "error", label: "积压 3 条", hint: "去看日志" },
    ]);
    expect(text).toBe("✓ inboxRuntime: 轮询中\n✕ inboxBacklog: 积压 3 条\n  → 去看日志");
  });

  it("handler 返回三项 + 渲染文本 + failed 标志（供 doctor 退出码）", async () => {
    const res = await inboxDoctorHandler({}, {
      status: () => running({ state: "conflict" }),
      now: () => NOW,
      listItemsImpl: async () => [],
      listPatternsImpl: async () => [],
    });
    expect(res.ok).toBe(true);
    const data = res.data as { checks: DoctorCheck[]; text: string; failed: boolean };
    expect(data.checks.map((c) => c.key)).toEqual(["inboxRuntime", "inboxBacklog", "patternsLibrary"]);
    expect(data.failed).toBe(true);
    expect(data.text).toContain("✕ inboxRuntime");
  });

  it("非法 payload 被挡在 handler 之外", async () => {
    expect((await inboxDoctorHandler([] as unknown as Record<string, unknown>)).ok).toBe(false);
  });
});

describe("真实 store 接线（默认依赖）", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-inbox-doctor-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function card(over: Partial<PatternCardInput> = {}): PatternCardInput {
    return {
      sourceUrl: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      sourcePlatform: "web",
      applicablePlatforms: ["douyin"],
      title: "标题",
      hook: "钩子",
      structure: ["一", "二", "三"],
      whyItWorks: ["有效"],
      themes: ["内容创作"],
      sourceInboxId: "inbox-real-1",
      ...over,
    };
  }

  it("默认依赖直读真实 jsonl：积压取最老一条，卡片数不含墓碑", async () => {
    await appendItem({ id: "inbox-old", source: "telegram", receivedAt: ago(2 * HOUR) }, testDir);
    await appendItem({ id: "inbox-new", source: "telegram", receivedAt: ago(MINUTE) }, testDir);
    await upsertPatternCard(card(), testDir);
    const dead = await upsertPatternCard(card({ sourceInboxId: "inbox-real-2" }), testDir);
    await deletePatternCard(dead.id, testDir);

    const map = await checks(running({ state: "polling", lastPollOkAt: ago(1000), lastUpdateId: 9 }), {
      listItemsImpl: undefined,
      listPatternsImpl: undefined,
      status: () => ({ state: "running", targetWorkspaceId: "ws-1", dataDir: testDir, poller: { state: "polling", lastPollOkAt: ago(1000), lastUpdateId: 9 } }),
    });

    expect(map.inboxBacklog.level).toBe("warn");
    expect(map.inboxBacklog.label).toContain("inbox-old");
    expect(map.patternsLibrary.level).toBe("ok");
    expect(map.patternsLibrary.label).toContain("1 张");
  });
});
