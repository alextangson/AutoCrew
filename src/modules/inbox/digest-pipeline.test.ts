import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createDigestPipeline,
  type DigestPipelineDeps,
  type DigestPatternStore,
} from "./digest-pipeline.js";
import { DIGEST_RECEIPTS } from "./digest-outcome.js";
import { FetchExternalError, type ExternalPage } from "./fetch-external.js";
import { JustoneapiError, type DouyinVideoContent, type JustoneapiClient } from "./justoneapi.js";
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
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

  /**
   * V1.0 锁的是「两个域名都不特判」；V1.1 上了 justoneapi 后**抖音那半已按新契约反转**
   * （缺 key → blocked、有 key → 走解析器，见下方「抖音路由」组）。
   * x.com 这半继续锁死：tweet-by-id 解析器是下一期，在它上线前抖音的做法不许提前抄过来。
   */
  it("x.com 仍不特判 blocked（专用解析器未上线，走通用抓取）", async () => {
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

// --- 抖音路由（V1.1：justoneapi 专用解析器，spec §3.2） ---

const DOUYIN_ID = "7656056306591884643";
const DOUYIN_CANONICAL = `https://www.douyin.com/video/${DOUYIN_ID}`;
const DOUYIN_SHORT = "https://v.douyin.com/iRxYqPq/";

const VIDEO: DouyinVideoContent = {
  videoId: DOUYIN_ID,
  canonicalUrl: DOUYIN_CANONICAL,
  desc: "做AI Agent整整一年了，说几句真话\n第二行文案",
  authorNickname: "Ai-Agent",
  createTime: 1782823718,
  durationMs: 866934,
  stats: { likes: 135, comments: 11, collects: 132, shares: 29 },
};

/** 假解析器：记录调用次数，便于断言「查重命中不再烧一次额度」 */
function fakeDouyin(over: Partial<JustoneapiClient> = {}): {
  client: JustoneapiClient;
  calls: { resolve: string[]; detail: string[] };
} {
  const calls = { resolve: [] as string[], detail: [] as string[] };
  const client: JustoneapiClient = {
    async resolveShareUrl(shareUrl) {
      calls.resolve.push(shareUrl);
      return `${DOUYIN_CANONICAL}?previous_page=app_code_link`;
    },
    async fetchVideoDetail(videoId) {
      calls.detail.push(videoId);
      return VIDEO;
    },
    ...over,
  };
  return { client, calls };
}

describe("digest pipeline · 抖音路由", () => {
  it("没配 justoneapi key → blocked + 指引，且绝不退回通用抓取", async () => {
    const item = await seed({ url: DOUYIN_SHORT });
    let fetched = 0;
    const { processItem, receipts } = makePipeline({
      fetchImpl: async () => {
        fetched += 1;
        return PAGE;
      },
    });

    const result = await processItem(item);

    expect(result).toMatchObject({ status: "blocked", errorCode: "justoneapi_key_missing" });
    expect(fetched).toBe(0);
    expect(receipts[0]).toContain("设置 · 灵感收件箱");
  });

  it("短链：先换标准链再取详情，卡上带 stats（含 shares）与作者", async () => {
    const item = await seed({ url: DOUYIN_SHORT });
    const douyin = fakeDouyin();
    const { processItem } = makePipeline({
      parsers: { justoneapiKey: "k-live", justoneapiImpl: douyin.client },
      triageImpl: async () => triageResult("exemplar", { sourcePlatform: "douyin" }),
    });

    const result = await processItem(item);

    expect(result).toMatchObject({ status: "digested", verdict: "exemplar", stage: "card_done" });
    expect(douyin.calls.resolve).toEqual([DOUYIN_SHORT]);
    expect(douyin.calls.detail).toEqual([DOUYIN_ID]);
    // 幂等键收敛到标准形态，与 canonicalizeUrl 同款
    expect((await getItem(item.id, dataDir))?.canonicalUrl).toBe(DOUYIN_CANONICAL);

    const [card] = await listPatternCards({}, dataDir);
    expect(card.canonicalUrl).toBe(DOUYIN_CANONICAL);
    expect(card.author).toBe("Ai-Agent");
    expect(card.stats).toMatchObject({ likes: 135, comments: 11, collects: 132, shares: 29 });
    expect(Number.isNaN(Date.parse(card.stats?.capturedAt ?? ""))).toBe(false);
  });

  it("标准链：不走短链端点，triage 输入带文案 + 作者/发布/时长 + 赞评藏转", async () => {
    const item = await seed({ url: `${DOUYIN_CANONICAL}?from=webapp` });
    const douyin = fakeDouyin();
    const inputs: TriageInput[] = [];
    const { processItem } = makePipeline({
      parsers: { justoneapiKey: "k-live", justoneapiImpl: douyin.client },
      triageImpl: async (input) => {
        inputs.push(input);
        return triageResult("inspiration");
      },
    });

    expect(await processItem(item)).toMatchObject({ status: "digested", verdict: "inspiration" });
    expect(douyin.calls.resolve).toEqual([]);
    expect(douyin.calls.detail).toEqual([DOUYIN_ID]);

    const { text, title, finalUrl } = inputs[0].content;
    expect(text).toContain("做AI Agent整整一年了");
    expect(text).toContain("作者：Ai-Agent");
    expect(text).toContain("发布：2026-06-30");
    expect(text).toContain("时长：14分26秒");
    expect(text).toContain("数据：赞135 评11 藏132 转29");
    expect(title).toBe("做AI Agent整整一年了，说几句真话"); // 文案首行，≤30 字
    expect(finalUrl).toBe(DOUYIN_CANONICAL);
  });

  it("查重命中就不再取详情（重复件不烧 API 额度）", async () => {
    await seed({ url: DOUYIN_CANONICAL, canonicalUrl: DOUYIN_CANONICAL, status: "digested", targetIds: ["topic-old"] });
    const item = await seed({ url: DOUYIN_SHORT });
    const douyin = fakeDouyin();
    const { processItem, receipts } = makePipeline({
      parsers: { justoneapiKey: "k-live", justoneapiImpl: douyin.client },
    });

    expect(await processItem(item)).toMatchObject({ status: "digested", targetIds: ["topic-old"] });
    expect(douyin.calls.resolve).toHaveLength(1); // 短链得先换标准链才知道是不是重复
    expect(douyin.calls.detail).toEqual([]);
    expect(receipts[0]).toContain("已收录过");
  });

  it("抠不到 videoId 的抖音链接（主页/合集）→ rejected", async () => {
    const item = await seed({ url: "https://www.douyin.com/user/MS4wLjABAAAA" });
    const { processItem } = makePipeline({
      parsers: { justoneapiKey: "k-live", justoneapiImpl: fakeDouyin().client },
    });

    expect(await processItem(item)).toMatchObject({ status: "rejected", errorCode: "douyin_no_video_id" });
  });

  it("解析器三态经管线原样落账：blocked / failed / rejected", async () => {
    const cases: Array<{ err: JustoneapiError; status: string }> = [
      { err: new JustoneapiError("justoneapi_601", "blocked", "余额不足"), status: "blocked" },
      { err: new JustoneapiError("justoneapi_301", "failed", "上游查询失败"), status: "failed" },
      { err: new JustoneapiError("justoneapi_400", "rejected", "参数不合法"), status: "rejected" },
      { err: new JustoneapiError("justoneapi_foreign_redirect", "rejected", "不是抖音域名"), status: "rejected" },
    ];
    for (const { err, status } of cases) {
      const item = await seed({ url: `${DOUYIN_CANONICAL}?case=${err.errorCode}` });
      const { processItem } = makePipeline({
        parsers: {
          justoneapiKey: "k-live",
          justoneapiImpl: fakeDouyin({
            fetchVideoDetail: async () => {
              throw err;
            },
            resolveShareUrl: async () => {
              throw err;
            },
          }).client,
        },
      });
      expect(await processItem(item)).toMatchObject({ status, errorCode: err.errorCode });
    }
  });

  it("blocked 的回执指向收件箱设置页，不是引擎设置", async () => {
    const item = await seed({ url: DOUYIN_CANONICAL });
    const { processItem, receipts } = makePipeline({
      parsers: {
        justoneapiKey: "k-dead",
        justoneapiImpl: fakeDouyin({
          fetchVideoDetail: async () => {
            throw new JustoneapiError("justoneapi_100", "blocked", "token 无效或已失效");
          },
        }).client,
      },
    });

    expect(await processItem(item)).toMatchObject({ status: "blocked", errorCode: "justoneapi_100" });
    expect(receipts[0]).toContain("justoneapi key");
    expect(receipts[0]).not.toContain("中转地址");
  });
});

describe("digest pipeline · 抖音 worker 合跑", () => {
  it("缺 key → blocked；配好 key 后 wakeBlocked 重跑 → digested 并落卡", async () => {
    const item = await seed({ url: DOUYIN_SHORT });
    const douyin = fakeDouyin();
    const base = {
      dataDir,
      triageImpl: async () => triageResult("exemplar", { sourcePlatform: "douyin" }),
      gateImpl: async () => ({ saved: true, topicId: "topic-1" }),
      loadProfileImpl: async () => null,
      onError: () => {},
    } satisfies Partial<DigestPipelineDeps> & { dataDir: string };

    // 配置变更时 runtime 会按新配置重新接线（inbox-runtime.bringUp），这里照搬那个语义
    let pipeline = createDigestPipeline({ ...base, parsers: {} });
    const worker = createInboxWorker({ dataDir, processItem: (it) => pipeline(it), onError: () => {} });

    worker.enqueue(item);
    await worker.idle();
    expect(await getItem(item.id, dataDir)).toMatchObject({
      status: "blocked",
      errorCode: "justoneapi_key_missing",
      attempts: 0, // blocked 不吃重试额度
    });

    pipeline = createDigestPipeline({
      ...base,
      parsers: { justoneapiKey: "k-just-saved", justoneapiImpl: douyin.client },
    });
    worker.wakeBlocked("inbox_settings_changed");
    await worker.idle();

    expect(await getItem(item.id, dataDir)).toMatchObject({ status: "digested", verdict: "exemplar" });
    const [card] = await listPatternCards({}, dataDir);
    expect(card.stats).toMatchObject({ shares: 29 });
    worker.stop();
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
