import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResearchJob } from "../modules/research/research-job-store.js";
import { SEARCH_NOT_CONFIGURED } from "../modules/research/search-provider.js";
import { handleDigestReply, type DigestReplyDeps } from "./digest-reply.js";
import { saveDigestState, type DigestState } from "./digest-state.js";

const CHAT = 8800;
const NOW = new Date(2026, 8, 7, 10, 0, 0).getTime();

let tmp: string;
let replies: string[];
let triggered: Array<{ topicId: string; dataDir?: string }>;
let triggerResult: { accepted: true } | { accepted: false; reason: string };
let job: ResearchJob | null;

const settings = { botToken: "123:abc", allowedUserIds: ["7"], targetWorkspaceId: "default" };

function deps(over: Partial<DigestReplyDeps> = {}): DigestReplyDeps {
  return {
    settings,
    dataDir: tmp,
    now: () => NOW,
    reply: async (_chatId: number, text: string) => {
      replies.push(text);
      return true;
    },
    trigger: async (topicId: string, dataDir?: string) => {
      triggered.push({ topicId, ...(dataDir !== undefined ? { dataDir } : {}) });
      return triggerResult;
    },
    getJobImpl: async () => job,
    ...over,
  };
}

async function seed(over: Partial<DigestState> = {}): Promise<void> {
  await saveDigestState(
    {
      lastSentDate: "2026-09-07",
      lastSentAt: new Date(NOW - 3600_000).toISOString(),
      lastDigest: {
        date: "2026-09-07",
        sentAt: new Date(NOW - 3600_000).toISOString(),
        items: [
          { n: 1, topicId: "topic-a", title: "甲选题" },
          { n: 2, topicId: "topic-b", title: "乙选题" },
        ],
      },
      ...over,
    },
    tmp,
  );
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-digest-reply-"));
  replies = [];
  triggered = [];
  triggerResult = { accepted: true };
  job = null;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("摘要回复（spec §2.4）", () => {
  it("不是纯数字 → 不拦截（照常进灵感入账）", async () => {
    await seed();
    expect(await handleDigestReply({ text: "想做一期讲选题的", chatId: CHAT }, deps())).toBe(false);
    expect(replies).toHaveLength(0);
  });

  it("盘上没有清单时，数字也只是一条随手记", async () => {
    expect(await handleDigestReply({ text: "3", chatId: CHAT }, deps())).toBe(false);
    expect(triggered).toHaveLength(0);
  });

  it("回 0 → 「好，今天不动」，不起任何 job", async () => {
    await seed();
    expect(await handleDigestReply({ text: "0", chatId: CHAT }, deps())).toBe(true);
    expect(replies).toEqual(["好，今天不动"]);
    expect(triggered).toHaveLength(0);
  });

  it("回范围内的数字 → 起深调研（带上摘要那个工作区），回执带标题", async () => {
    await seed();
    expect(await handleDigestReply({ text: " 2 ", chatId: CHAT }, deps())).toBe(true);
    expect(triggered).toEqual([{ topicId: "topic-b", dataDir: tmp }]);
    expect(replies[0]).toContain("已起深调研：《乙选题》");
  });

  it("同一个数字再回一次 → 回当前 job 状态，不再起第二轮", async () => {
    await seed();
    await handleDigestReply({ text: "1", chatId: CHAT }, deps());
    job = { topicId: "topic-a", status: "running", startedAt: "", perspectives: [], topicHash: "h" };
    expect(await handleDigestReply({ text: "1", chatId: CHAT }, deps())).toBe(true);
    expect(triggered).toHaveLength(1);
    expect(replies[1]).toBe("《甲选题》的深调研：进行中");
  });

  it("超范围 → 明说范围", async () => {
    await seed();
    await handleDigestReply({ text: "12", chatId: CHAT }, deps());
    expect(replies).toEqual(["清单里只有 1–2"]);
    expect(triggered).toHaveLength(0);
  });

  it("搜索没配 → 把那句人话原样回过去，不起 job", async () => {
    await seed();
    triggerResult = { accepted: false, reason: SEARCH_NOT_CONFIGURED };
    expect(await handleDigestReply({ text: "1", chatId: CHAT }, deps())).toBe(true);
    expect(replies).toEqual([SEARCH_NOT_CONFIGURED]);
    // 拒了就不该记成「已起过」——下次再回同一个数字要能真的重试
    expect(await handleDigestReply({ text: "1", chatId: CHAT }, deps())).toBe(true);
    expect(triggered).toHaveLength(2);
  });

  it("回的是旧清单 → 回执带上那份的日期", async () => {
    await seed({
      lastDigest: {
        date: "2026-09-06",
        sentAt: new Date(NOW - 26 * 3600_000).toISOString(),
        items: [{ n: 1, topicId: "topic-old", title: "昨天那条" }],
      },
    });
    await handleDigestReply({ text: "1", chatId: CHAT }, deps());
    expect(replies[0]).toContain("（这是 9 月 6 日的清单）");
    expect(replies[0]).toContain("已起深调研：《昨天那条》");
  });

  it("拿不到 chatId 也算处理过——「3」不该变成一条灵感", async () => {
    await seed();
    expect(await handleDigestReply({ text: "1" }, deps())).toBe(true);
    expect(replies).toHaveLength(0);
  });
});
