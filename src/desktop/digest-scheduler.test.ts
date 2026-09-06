import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Topic } from "../storage/local-store.js";
import type { EngineEvent } from "./event-hub.js";
import type { InboxSettings } from "./settings-inbox.js";
import {
  getDigestStatus,
  runDigestTick,
  sendDigestNow,
  startDigestScheduler,
  stopDigestScheduler,
  DIGEST_MAX_ATTEMPTS,
  type DigestSchedulerOptions,
} from "./digest-scheduler.js";
import { loadDigestState, localDateKey } from "./digest-state.js";

/** 本地时钟：摘要是「用户挂钟上的今天 9 点」，测试也必须用本地时间构造 */
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 8, day, hour, minute, 0, 0).getTime();

let tmp: string;
let nowMs: number;
let settings: InboxSettings | null;
let topics: Topic[];
let sent: string[];
let events: Array<{ kind: string; label: string }>;
let sendFails: string | null;

function topic(over: Partial<Topic> = {}): Topic {
  return {
    id: `topic-${Math.random().toString(36).slice(2, 8)}`,
    title: "雷达命中的一条",
    description: "",
    tags: ["radar"],
    source: "radar:36氪",
    reason: "命中「Agent 落地」",
    link: "https://example.com/a",
    createdAt: new Date(nowMs - 3600_000).toISOString(),
    ...over,
  };
}

function options(over: Partial<DigestSchedulerOptions> = {}): DigestSchedulerOptions {
  return {
    dataDir: tmp,
    loadSettings: async () => settings,
    listTopicsImpl: async () => topics,
    countSourcesImpl: async () => 9,
    sendImpl: async (text: string) => {
      if (sendFails) throw new Error(sendFails);
      sent.push(text);
    },
    now: () => nowMs,
    intervalMs: 3_600_000, // tick 由测试手动驱动，定时器不参与
    emit: async (e) => {
      events.push({ kind: e.kind, label: e.label });
      return { ts: new Date(nowMs).toISOString(), ...e } as EngineEvent;
    },
    onError: () => {},
    ...over,
  };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-digest-"));
  nowMs = at(7, 9, 0);
  settings = { botToken: "123:abc", allowedUserIds: ["7"], targetWorkspaceId: "default" };
  topics = [topic()];
  sent = [];
  events = [];
  sendFails = null;
});

afterEach(async () => {
  stopDigestScheduler();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("digest 调度 · 到点与幂等（spec §2.3）", () => {
  it("没到点不发；到点发一份；当天再 tick 不重发", async () => {
    nowMs = at(7, 8, 59);
    await startDigestScheduler(options());
    expect(sent).toHaveLength(0);

    nowMs = at(7, 9, 0);
    await runDigestTick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("AutoCrew 今日选题 · 9 月 7 日");

    nowMs = at(7, 10, 0);
    await runDigestTick();
    expect(sent).toHaveLength(1);

    const state = await loadDigestState(tmp);
    expect(state.lastSentDate).toBe(localDateKey(at(7, 9, 0)));
    expect(state.lastDigest?.items).toHaveLength(1);
    expect(state.lastDigest?.items[0]).toMatchObject({ n: 1, topicId: topics[0].id });
    expect(events.map((e) => e.kind)).toEqual(["work"]);
  });

  it("服务晚起：14 点启动补发当天那份；昨天漏的不补（发的是今天的清单）", async () => {
    nowMs = at(7, 14, 0);
    await startDigestScheduler(options());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("9 月 7 日");
    expect((await loadDigestState(tmp)).lastSentDate).toBe(localDateKey(nowMs));
  });

  it("昨天发过、今天还没到点 → 不发（不补昨天，也不提前发今天）", async () => {
    await fs.writeFile(
      path.join(tmp, "digest-state.json"),
      JSON.stringify({ lastSentDate: localDateKey(at(6, 9, 0)), lastSentAt: new Date(at(6, 9, 0)).toISOString() }),
    );
    nowMs = at(7, 8, 0);
    await startDigestScheduler(options());
    expect(sent).toHaveLength(0);
  });

  it("改小时后当天已发不再发第二份", async () => {
    await startDigestScheduler(options());
    expect(sent).toHaveLength(1);
    settings = { ...settings!, digestHour: 8 };
    nowMs = at(7, 20, 0);
    await runDigestTick();
    expect(sent).toHaveLength(1);
  });

  it("关掉开关 / 卸掉 bot token → 不发", async () => {
    settings = { ...settings!, digestEnabled: false };
    await startDigestScheduler(options());
    expect(sent).toHaveLength(0);

    settings = null;
    await runDigestTick();
    expect(sent).toHaveLength(0);
    // 没配 bot 不是故障：不写 lastError，也不计入尝试
    expect(await loadDigestState(tmp)).toEqual({});
  });

  it("候选为空也发一行空摘要（沉默会让人分不清「没选题」和「没发出去」）", async () => {
    topics = [];
    await startDigestScheduler(options());
    expect(sent[0]).toBe("AutoCrew 今日选题 · 9 月 7 日\n\n今天雷达没有新的命中定位的选题（扫了 9 个源）。");
    expect((await loadDigestState(tmp)).lastDigest?.items).toEqual([]);
  });

  it("扫了几个源读不出来就不写数字，不编", async () => {
    topics = [];
    await startDigestScheduler(options({ countSourcesImpl: async () => undefined }));
    expect(sent[0]).toBe("AutoCrew 今日选题 · 9 月 7 日\n\n今天雷达没有新的命中定位的选题。");
  });

  it("自动发只取上一份之后入库的（上一份已发过的不再推第二次）", async () => {
    await startDigestScheduler(options());
    expect(sent).toHaveLength(1);
    const fresh = topic({ id: "topic-fresh", createdAt: new Date(at(8, 8, 0)).toISOString() });
    topics = [...topics, fresh];
    nowMs = at(8, 9, 0);
    await runDigestTick();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("1. 雷达命中的一条");
    expect((await loadDigestState(tmp)).lastDigest?.items).toEqual([
      { n: 1, topicId: "topic-fresh", title: "雷达命中的一条" },
    ]);
  });
});

describe("digest 调度 · 失败可见与重试（spec §2.3）", () => {
  it("失败记 lastError/lastErrorAt + 事件；10 分钟内不重试，够 10 分钟才重试", async () => {
    sendFails = "网络不通";
    await startDigestScheduler(options());
    let state = await loadDigestState(tmp);
    expect(sent).toHaveLength(0);
    expect(state.lastError).toBe("网络不通");
    expect(Date.parse(state.lastErrorAt!)).toBe(at(7, 9, 0));
    expect(state.attemptsToday).toBe(1);
    expect(events[0].kind).toBe("run_failed");

    nowMs = at(7, 9, 5);
    await runDigestTick();
    expect((await loadDigestState(tmp)).attemptsToday).toBe(1); // 还没到 10 分钟

    nowMs = at(7, 9, 15);
    await runDigestTick();
    state = await loadDigestState(tmp);
    expect(state.attemptsToday).toBe(2);
  });

  it("一天最多 3 次；第 4 次不再试", async () => {
    sendFails = "网络不通";
    await startDigestScheduler(options());
    nowMs = at(7, 9, 15);
    await runDigestTick();
    nowMs = at(7, 9, 30);
    await runDigestTick();
    expect((await loadDigestState(tmp)).attemptsToday).toBe(DIGEST_MAX_ATTEMPTS);

    nowMs = at(7, 9, 45);
    await runDigestTick();
    expect((await loadDigestState(tmp)).attemptsToday).toBe(DIGEST_MAX_ATTEMPTS);
    expect(sent).toHaveLength(0);
  });

  it("重试成功后清掉 lastError，当天不再发", async () => {
    sendFails = "网络不通";
    await startDigestScheduler(options());
    sendFails = null;
    nowMs = at(7, 9, 15);
    await runDigestTick();
    const state = await loadDigestState(tmp);
    expect(sent).toHaveLength(1);
    expect(state.lastError).toBeUndefined();
    expect(state.lastErrorAt).toBeUndefined();
    expect(state.lastSentDate).toBe(localDateKey(nowMs));
  });

  it("白名单为空 = 没有收件人：照实记失败，不静默", async () => {
    settings = { botToken: "123:abc", allowedUserIds: [], targetWorkspaceId: "default" };
    await startDigestScheduler(options({ sendImpl: undefined }));
    const state = await loadDigestState(tmp);
    expect(state.lastError).toContain("白名单为空");
    expect(state.attemptsToday).toBe(1);
  });
});

describe("digest · 现在发一份（spec §2.5 / §3 防呆）", () => {
  it("绕过到点与当天幂等，并替换 lastDigest", async () => {
    nowMs = at(7, 6, 0); // 还没到 9 点
    topics = [topic({ id: "topic-early", createdAt: new Date(at(7, 5, 0)).toISOString() })];
    await startDigestScheduler(options());
    expect(sent).toHaveLength(0);

    const first = await sendDigestNow(tmp);
    expect(first).toMatchObject({ ok: true, count: 1 });
    expect(sent).toHaveLength(1);

    topics = [topic({ id: "topic-second", title: "第二批", createdAt: new Date(at(7, 5, 30)).toISOString() })];
    nowMs = at(7, 6, 5);
    const second = await sendDigestNow(tmp);
    expect(second.ok).toBe(true);
    expect((await loadDigestState(tmp)).lastDigest?.items).toEqual([
      { n: 1, topicId: "topic-second", title: "第二批" },
    ]);
  });

  it("60 秒内连点第二次 → 「刚发过（N 秒前）」，不发第二条", async () => {
    await startDigestScheduler(options());
    expect(sent).toHaveLength(1);
    nowMs = at(7, 9, 0) + 20_000;
    const again = await sendDigestNow(tmp);
    expect(again.ok).toBe(false);
    expect(again.error).toBe("刚发过（20 秒前）");
    expect(sent).toHaveLength(1);
  });

  it("没配 bot 时按钮回人话，不假装发了", async () => {
    settings = null;
    await startDigestScheduler(options());
    const res = await sendDigestNow(tmp);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("bot token");
  });
});

describe("digest 状态（inbox:status.digest）", () => {
  it("发过之后：enabled/hour/nextAt/lastSentAt/attemptsToday 齐全", async () => {
    await startDigestScheduler(options());
    const status = await getDigestStatus(tmp);
    expect(status).toEqual({
      enabled: true,
      hour: 9,
      nextAt: new Date(at(8, 9, 0)).toISOString(), // 今天发过了 → 明天同一个点
      lastSentAt: new Date(at(7, 9, 0)).toISOString(),
      lastError: null,
      lastErrorAt: null,
      attemptsToday: 1,
    });
  });

  it("关掉时 nextAt 为 null；自定义小时照实回", async () => {
    settings = { ...settings!, digestEnabled: false, digestHour: 21 };
    await startDigestScheduler(options());
    const status = await getDigestStatus(tmp);
    expect(status).toMatchObject({ enabled: false, hour: 21, nextAt: null, lastSentAt: null });
  });
});
