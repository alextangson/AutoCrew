import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createDigestPipeline,
  DIGEST_RECEIPTS,
  type DigestPipelineDeps,
  type DigestPatternStore,
} from "./digest-pipeline.js";
import { FetchExternalError, type ExternalPage } from "./fetch-external.js";
import { appendItem, getItem, type InboxItem, type NewInboxItem } from "./inbox-store.js";
import { createInboxWorker } from "./inbox-worker.js";
import {
  deletePatternCard,
  listPatternCards,
  upsertPatternCard,
  type PatternCard,
} from "../patterns/pattern-store.js";
import type { GateResult, TopicCandidate } from "../radar/intake-gate.js";
import {
  EngineUnavailableError,
  TriageEngineError,
  TriageInvalidOutputError,
  type TriageInput,
  type TriageResult,
} from "./triage.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-digest-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

// --- 桩件 ---

const PAGE: ExternalPage = {
  finalUrl: "https://example.com/post?utm_source=tg",
  text: "一篇正常的文章正文",
  title: "示例文章",
};
/** canonicalizeUrl 会去掉 utm_*，管线全程用这个键查重与落库 */
const CANONICAL = "https://example.com/post";

function triageCard(over: Record<string, unknown> = {}): TriageResult["card"] {
  return {
    sourcePlatform: "web",
    applicablePlatforms: ["douyin"],
    title: "对标标题",
    hook: "开头三秒抛冲突",
    structure: ["钩子", "论据", "收尾"],
    whyItWorks: ["情绪拉满"],
    themes: ["AI 工具"],
    ...over,
  } as TriageResult["card"];
}

function triageResult(verdict: TriageResult["verdict"], over: Partial<TriageResult> = {}): TriageResult {
  return {
    verdict,
    sourcePlatform: "web",
    tokensUsed: 0,
    ...(verdict === "inspiration" || verdict === "both"
      ? { topic: { title: "选题标题", summary: "摘要", angle: "我们的角度" } }
      : {}),
    ...(verdict === "exemplar" || verdict === "both" ? { card: triageCard() } : {}),
    ...over,
  };
}

function makePipeline(over: Partial<DigestPipelineDeps> = {}): {
  processItem: ReturnType<typeof createDigestPipeline>;
  gateCalls: TopicCandidate[];
  receipts: string[];
} {
  const gateCalls: TopicCandidate[] = [];
  const receipts: string[] = [];
  const processItem = createDigestPipeline({
    dataDir,
    telegram: { botToken: "tok" },
    fetchImpl: async () => PAGE,
    triageImpl: async () => triageResult("inspiration"),
    gateImpl: async (candidate) => {
      gateCalls.push(candidate);
      return { saved: true, topicId: "topic-1" };
    },
    loadProfileImpl: async () => null,
    sendReceiptImpl: async (_chatId, text) => {
      receipts.push(text);
      return true;
    },
    onError: () => {},
    ...over,
  });
  return { processItem, gateCalls, receipts };
}

async function seed(input: Partial<NewInboxItem> = {}): Promise<InboxItem> {
  return appendItem(
    { source: "telegram", chatId: 42, receiptStatus: "sent", ...input } as NewInboxItem,
    dataDir,
  );
}

/** 只记调用、不落盘的假拆解卡库 */
function fakePatternStore(hit: PatternCard | null = null): DigestPatternStore & { upserts: number } {
  const store = {
    upserts: 0,
    async upsert(input: Parameters<DigestPatternStore["upsert"]>[0]) {
      store.upserts += 1;
      const now = new Date().toISOString();
      return { ...input, id: `pat-${input.sourceInboxId}`, revision: 1, createdAt: now, updatedAt: now } as PatternCard;
    },
    async findByCanonicalUrl() {
      return hit;
    },
  };
  return store;
}

// --- 纯文字随手记 ---

describe("digest pipeline · 纯文字", () => {
  it("入灵感库并回执落点", async () => {
    const item = await seed({ text: "今天刷到一个很好的选题方向，值得写一条" });
    const { processItem, gateCalls, receipts } = makePipeline();

    const result = await processItem(item);

    expect(result).toMatchObject({ status: "digested", verdict: "inspiration", targetIds: ["topic-1"] });
    expect(gateCalls[0]).toMatchObject({ source: "inbox:telegram", reason: "收件箱 · 随手记" });
    expect(gateCalls[0].summary).toBe(item.text);
    expect(Array.from(gateCalls[0].title).length).toBeLessThanOrEqual(30);
    expect(receipts[0]).toContain("已消化");
  });

  it("7 天内同文重复 → digested 且不再入库", async () => {
    const text = "重复的随手记";
    const first = await seed({ text, status: "digested", targetIds: ["topic-old"] });
    const item = await seed({ text });
    const { processItem, gateCalls, receipts } = makePipeline();

    const result = await processItem(item);

    expect(result).toMatchObject({ status: "digested", targetIds: ["topic-old"] });
    expect(gateCalls).toHaveLength(0);
    expect(receipts[0]).toContain("已收录过");
    expect(first.id).not.toBe(item.id);
  });

  it("孪生记录没落过点（failed）→ 不当重复，照常入库", async () => {
    const text = "上次没处理成功的随手记";
    await seed({ text, status: "failed", attempts: 1 });
    const item = await seed({ text });
    const { processItem, gateCalls } = makePipeline();

    expect(await processItem(item)).toMatchObject({ status: "digested", targetIds: ["topic-1"] });
    expect(gateCalls).toHaveLength(1);
  });

  it("落选记忆命中 → rejected", async () => {
    const item = await seed({ text: "评过没过关的题" });
    const { processItem } = makePipeline({ gateImpl: async () => ({ saved: false, code: "reject_memory" }) });

    expect(await processItem(item)).toMatchObject({ status: "rejected", errorCode: "reject_memory" });
  });
});

// --- 链接：三条 verdict 路由 ---

describe("digest pipeline · 链接落点", () => {
  it("exemplar → 只落拆解卡", async () => {
    const item = await seed({ url: "https://example.com/post?utm_source=tg" });
    const patterns = fakePatternStore();
    const { processItem, gateCalls } = makePipeline({
      triageImpl: async () => triageResult("exemplar"),
      patternStore: patterns,
    });

    const result = await processItem(item);

    expect(result).toMatchObject({ status: "digested", verdict: "exemplar", stage: "card_done" });
    expect(result.targetIds).toEqual([`pat-${item.id}`]);
    expect(gateCalls).toHaveLength(0);
    expect((await getItem(item.id, dataDir))?.canonicalUrl).toBe(CANONICAL);
  });

  it("inspiration → 只落灵感，link 用 canonicalUrl、reason 带备注", async () => {
    const item = await seed({ url: "https://example.com/post?utm_source=tg", note: "这个角度我们能写" });
    const { processItem, gateCalls } = makePipeline({ triageImpl: async () => triageResult("inspiration") });

    const result = await processItem(item);

    expect(result).toMatchObject({ status: "digested", verdict: "inspiration", targetIds: ["topic-1"] });
    expect(gateCalls[0]).toMatchObject({
      link: CANONICAL,
      source: "inbox:telegram",
      reason: "收件箱 · 转发 · 这个角度我们能写",
    });
  });

  it("both → 卡与题两个落点，stage 收在 topic_done", async () => {
    const item = await seed({ url: "https://example.com/post" });
    const { processItem } = makePipeline({
      triageImpl: async () => triageResult("both"),
      patternStore: fakePatternStore(),
    });

    const result = await processItem(item);

    expect(result).toMatchObject({ status: "digested", verdict: "both", stage: "topic_done" });
    expect(result.targetIds).toEqual([`pat-${item.id}`, "topic-1"]);
  });

  it("unusable → rejected 带原因", async () => {
    const item = await seed({ url: "https://example.com/post" });
    const { processItem, receipts } = makePipeline({
      triageImpl: async () => triageResult("unusable", { reason: "内容太薄" }),
    });

    expect(await processItem(item)).toMatchObject({ status: "rejected", errorCode: "unusable", failReason: "内容太薄" });
    expect(receipts[0]).toContain("内容太薄");
  });

  it("题步被落选记忆挡下、卡已落库 → 仍算 digested", async () => {
    const item = await seed({ url: "https://example.com/post" });
    const { processItem } = makePipeline({
      triageImpl: async () => triageResult("both"),
      patternStore: fakePatternStore(),
      gateImpl: async () => ({ saved: false, code: "reject_memory" }),
    });

    const result = await processItem(item);
    expect(result).toMatchObject({ status: "digested", targetIds: [`pat-${item.id}`] });
  });

  it("题步查重命中 → 该子步按已完成处理，落点指向既有灵感", async () => {
    const item = await seed({ url: "https://example.com/post" });
    const { processItem, receipts } = makePipeline({
      gateImpl: async () => ({ saved: false, code: "duplicate", existingId: "topic-old" }),
    });

    expect(await processItem(item)).toMatchObject({ status: "digested", targetIds: ["topic-old"] });
    expect(receipts[0]).toContain("topic-old");
  });
});

// --- 三库查重与 checkpoint ---

describe("digest pipeline · 查重与断点续做", () => {
  it("inbox 台账已有同链接 digested 项 → 已收录过", async () => {
    await seed({ url: "https://example.com/post", canonicalUrl: CANONICAL, status: "digested", targetIds: ["topic-old"] });
    const item = await seed({ url: "https://example.com/post?utm_source=tg" });
    const { processItem, receipts } = makePipeline({ triageImpl: async () => triageResult("both") });

    expect(await processItem(item)).toMatchObject({ status: "digested", targetIds: ["topic-old"] });
    expect(receipts[0]).toContain("已收录过");
  });

  it("墓碑命中 → 默认拒绝并给重拆指引", async () => {
    const item = await seed({ url: "https://example.com/post" });
    const card = await upsertPatternCard(
      { ...triageCard(), sourceUrl: "https://example.com/post", canonicalUrl: CANONICAL, sourceInboxId: "inbox-old" },
      dataDir,
    );
    await deletePatternCard(card.id, dataDir);
    const { processItem, receipts } = makePipeline({ triageImpl: async () => triageResult("exemplar") });

    const result = await processItem(item);

    expect(result).toMatchObject({ status: "rejected", errorCode: "pattern_tombstone" });
    expect(receipts[0]).toBe(DIGEST_RECEIPTS.tombstone);
  });

  it("墓碑命中但备注写了「重拆」→ 放行重拆", async () => {
    const item = await seed({ url: "https://example.com/post", note: "重拆一次" });
    const card = await upsertPatternCard(
      { ...triageCard(), sourceUrl: "https://example.com/post", canonicalUrl: CANONICAL, sourceInboxId: "inbox-old" },
      dataDir,
    );
    await deletePatternCard(card.id, dataDir);
    const { processItem } = makePipeline({ triageImpl: async () => triageResult("exemplar") });

    const result = await processItem(item);

    expect(result).toMatchObject({ status: "digested", verdict: "exemplar", stage: "card_done" });
    expect((await listPatternCards({}, dataDir)).map((c) => c.id)).toContain(`pat-${item.id}`);
  });

  it("both 在题步崩掉 → failed 带 card_done checkpoint，续做不产生第二张卡", async () => {
    const item = await seed({ url: "https://example.com/post" });
    let gateFails = true;
    const deps: Partial<DigestPipelineDeps> = {
      triageImpl: async () => triageResult("both"),
      gateImpl: async (): Promise<GateResult> => {
        if (gateFails) throw new Error("灵感库写盘炸了");
        return { saved: true, topicId: "topic-1" };
      },
    };
    const first = await makePipeline(deps).processItem(item);

    expect(first).toMatchObject({ status: "failed", stage: "card_done", targetIds: [`pat-${item.id}`] });
    expect(await listPatternCards({}, dataDir)).toHaveLength(1);

    // 续做：worker 会把 stage/targetIds 落回 item，重跑从断点继续
    gateFails = false;
    const resumed = await makePipeline(deps).processItem({
      ...item,
      stage: "card_done",
      targetIds: [`pat-${item.id}`],
    });

    expect(resumed).toMatchObject({ status: "digested", verdict: "both", stage: "topic_done" });
    expect(resumed.targetIds).toEqual([`pat-${item.id}`, "topic-1"]);
    const cards = await listPatternCards({}, dataDir);
    expect(cards).toHaveLength(1);
    expect(cards[0].revision).toBe(1); // 卡步真的被跳过了，没有二次 upsert
  });

  it("没有 checkpoint 的重跑靠 upsert 幂等兜底，仍只有一张卡", async () => {
    const item = await seed({ url: "https://example.com/post" });
    const deps: Partial<DigestPipelineDeps> = { triageImpl: async () => triageResult("exemplar") };
    await makePipeline(deps).processItem(item);
    await makePipeline(deps).processItem(item);

    const cards = await listPatternCards({}, dataDir);
    expect(cards).toHaveLength(1);
    expect(cards[0].revision).toBe(2);
  });
});

// --- 错误映射矩阵（三态语义是验收项） ---

describe("digest pipeline · 错误映射", () => {
  const matrix: Array<{ code: string; status: "rejected" | "failed" }> = [
    { code: "invalid_url", status: "rejected" },
    { code: "unsupported_protocol", status: "rejected" },
    { code: "ssrf_blocked", status: "rejected" },
    { code: "unsupported_content_type", status: "rejected" },
    { code: "body_too_large", status: "rejected" },
    { code: "too_many_redirects", status: "rejected" },
    { code: "http_404", status: "rejected" },
    { code: "http_403", status: "rejected" },
    { code: "timeout", status: "failed" },
    { code: "fetch_failed", status: "failed" },
    { code: "http_500", status: "failed" },
    { code: "http_502", status: "failed" },
  ];

  for (const { code, status } of matrix) {
    it(`抓取 ${code} → ${status}`, async () => {
      const item = await seed({ url: "https://example.com/post" });
      const { processItem } = makePipeline({
        fetchImpl: async () => {
          throw new FetchExternalError(code as "timeout", `模拟 ${code}`);
        },
      });

      expect(await processItem(item)).toMatchObject({ status, errorCode: code });
    });
  }

  it("引擎不可用 → blocked", async () => {
    const item = await seed({ url: "https://example.com/post" });
    const { processItem, receipts } = makePipeline({
      triageImpl: async () => {
        throw new EngineUnavailableError("引擎未配置");
      },
    });

    expect(await processItem(item)).toMatchObject({ status: "blocked", errorCode: "engine_unavailable" });
    expect(receipts[0]).toContain("设置页");
  });

  it("可重试的分流错误 → failed", async () => {
    const item = await seed({ url: "https://example.com/post" });
    for (const err of [new TriageEngineError("5xx"), new TriageInvalidOutputError(["card 缺字段"])]) {
      const { processItem } = makePipeline({
        triageImpl: async () => {
          throw err;
        },
      });
      expect(await processItem(item)).toMatchObject({ status: "failed", errorCode: err.errorCode });
    }
  });

  it("重试额度用尽的那次 failed 回执不再承诺自动重试", async () => {
    const item = await seed({ url: "https://example.com/post", status: "failed", attempts: 3 });
    const { processItem, receipts } = makePipeline({
      fetchImpl: async () => {
        throw new FetchExternalError("timeout", "超时");
      },
    });

    expect(await processItem(item)).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(receipts[0]).toContain("手动重试");
    expect(receipts[0]).not.toContain("会自动重试");
  });

  it("x.com / douyin.com 没有专用解析器时不特判 blocked（V1.1 才上）", async () => {
    const item = await seed({ url: "https://x.com/someone/status/123" });
    const { processItem } = makePipeline({
      fetchImpl: async () => {
        throw new FetchExternalError("http_403", "反爬");
      },
    });

    expect(await processItem(item)).toMatchObject({ status: "rejected", errorCode: "http_403" });
  });

  it("既无链接也无文字 → rejected", async () => {
    const item = await seed({});
    const { processItem } = makePipeline();
    expect(await processItem(item)).toMatchObject({ status: "rejected", errorCode: "empty_item" });
  });
});

// --- 回执与事件 ---

describe("digest pipeline · 回执旁路", () => {
  it("回执发送失败只标 receiptStatus，不影响消化结果", async () => {
    const item = await seed({ text: "一条随手记" });
    const { processItem } = makePipeline({ sendReceiptImpl: async () => false });

    expect(await processItem(item)).toMatchObject({ status: "digested", targetIds: ["topic-1"] });
    expect((await getItem(item.id, dataDir))?.receiptStatus).toBe("failed");
  });

  it("回执抛错同样不影响结果", async () => {
    const item = await seed({ text: "另一条随手记" });
    const { processItem } = makePipeline({
      sendReceiptImpl: async () => {
        throw new Error("网络断了");
      },
    });

    expect(await processItem(item)).toMatchObject({ status: "digested" });
    expect((await getItem(item.id, dataDir))?.receiptStatus).toBe("failed");
  });

  it("每次状态落定触发 inbox:updated", async () => {
    const item = await seed({ text: "带事件的随手记" });
    const events: string[] = [];
    const { processItem } = makePipeline({ onEvent: (e) => events.push(`${e.type}:${e.itemId}`) });

    await processItem(item);
    expect(events).toEqual([`inbox:updated:${item.id}`]);
  });
});

// --- 与 worker 合跑：blocked 唤醒后恢复 ---

describe("digest pipeline · worker 合跑", () => {
  it("引擎不可用 → blocked；引擎恢复后 wakeBlocked 重跑 → digested", async () => {
    const item = await seed({ url: "https://example.com/post" });
    let engineDown = true;
    const processItem = createDigestPipeline({
      dataDir,
      fetchImpl: async () => PAGE,
      triageImpl: async (_input: TriageInput) => {
        if (engineDown) throw new EngineUnavailableError("引擎未配置");
        return triageResult("inspiration");
      },
      gateImpl: async () => ({ saved: true, topicId: "topic-1" }),
      loadProfileImpl: async () => null,
      onError: () => {},
    });
    const worker = createInboxWorker({ dataDir, processItem, onError: () => {} });

    worker.enqueue(item);
    await worker.idle();
    const blocked = await getItem(item.id, dataDir);
    expect(blocked).toMatchObject({ status: "blocked", errorCode: "engine_unavailable", attempts: 0 });

    engineDown = false;
    worker.wakeBlocked("settings_changed");
    await worker.idle();

    expect(await getItem(item.id, dataDir)).toMatchObject({
      status: "digested",
      verdict: "inspiration",
      targetIds: ["topic-1"],
    });
    worker.stop();
  });
});
