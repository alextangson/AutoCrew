/**
 * 深调研 IPC handlers 测试（spec §8/§9）：四通道的 happy 与拒绝路径、
 * 简报过期（topicHash 与当前选题不符）判定、chat 工具 `deep_research` 的透传。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  researchBriefGetHandler,
  researchDeepDiveHandler,
  researchListAssetsHandler,
  researchStatusHandler,
} from "./research-handlers.js";
import {
  SEARCH_NOT_CONFIGURED,
  startResearchRuntime,
  stopResearchRuntime,
} from "./research-runtime.js";
import { buildChatTools, type ChatCard } from "./chat-router.js";
import { BRIEF_SCHEMA_VERSION, saveBrief, type ResearchBrief } from "../modules/research/brief-store.js";
import {
  PERSPECTIVE_NAMES,
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type ResearchJob,
} from "../modules/research/research-job-store.js";
import { saveSearchConfig } from "../modules/research/search-provider.js";
import { getTopic, saveTopic, updateTopic, type Topic } from "../storage/local-store.js";

let dataDir: string;
let topic: Topic;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-research-handlers-"));
  topic = await saveTopic({ title: "AI 编程助手横评", description: "对比 5 个主流工具", tags: [] }, dataDir);
});

afterEach(async () => {
  stopResearchRuntime();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const p = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  topic_id: topic.id,
  _dataDir: dataDir,
  ...extra,
});

const configureSearch = (): Promise<void> => saveSearchConfig({ provider: "tavily", apiKey: "k-test" }, dataDir);

/** 启动运行时但塞一个不出网的假管线：投递路径要真跑，四视角不能真跑 */
async function startRuntime(): Promise<void> {
  await startResearchRuntime({
    rootDir: dataDir,
    onError: () => {},
    createRunJobImpl: () => async (job: ResearchJob) => ({
      status: "failed" as const,
      perspectives: job.perspectives,
      errorCode: "test_stub",
      failReason: "测试桩不跑真管线",
    }),
  });
}

function seedJob(over: Partial<ResearchJob> = {}): Promise<ResearchJob> {
  return upsertJob(
    {
      topicId: topic.id,
      status: "succeeded",
      startedAt: "2026-07-26T08:00:00.000Z",
      settledAt: "2026-07-26T08:06:00.000Z",
      perspectives: PERSPECTIVE_NAMES.map((name) => ({ name, status: "succeeded" as const })),
      briefRevision: 1,
      topicHash: topicHashOf(topic.title, topic.description),
      ...over,
    },
    dataDir,
  );
}

function briefFixture(over: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "四视角都指向同一个矛盾：工具越强，人越懒于校对。",
    perspectives: [],
    tensions: ["提效数据亮眼，但返工率没人统计"],
    angleSuggestions: ["从返工率切入", "对比两类用户的使用姿势"],
    evidence: [{ claim: "提效 55%", quote: "average 55% faster", sourceUrl: "https://example.com/report" }],
    assetPicks: [
      { url: "https://example.com/chart.png", sourcePageUrl: "https://example.com/report", caption: "提效曲线" },
    ],
    missingPerspectives: [],
    gaps: ["缺中文场景的数据"],
    generatedAt: "2026-07-26T08:05:00.000Z",
    revision: 1,
    topicHash: topicHashOf(topic.title, topic.description),
    ...over,
  };
}

describe("research:deep_dive", () => {
  it("搜索 key 未配 → ok:false 且带设置指引", async () => {
    await startRuntime();
    const res = await researchDeepDiveHandler(p());
    expect(res.ok).toBe(false);
    expect(res.error).toBe(SEARCH_NOT_CONFIGURED);
    expect(String(res.error)).toContain("设置页");
  });

  it("运行时没起来 → ok:false 照实说（不假装已排队）", async () => {
    await configureSearch();
    const res = await researchDeepDiveHandler(p());
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("没在跑");
  });

  it("选题不存在 → ok:false", async () => {
    await configureSearch();
    await startRuntime();
    const res = await researchDeepDiveHandler(p({ topic_id: "topic-1-gone" }));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("选题不存在");
  });

  it("happy：投递即返回 queued job；重复投递合并（deduped）", async () => {
    await configureSearch();
    await startRuntime();
    const first = await researchDeepDiveHandler(p());
    expect(first.ok).toBe(true);
    const d = first.data as { job: ResearchJob; deduped: boolean };
    expect(d.job.topicId).toBe(topic.id);
    expect(d.deduped).toBe(false);
    expect(["queued", "running", "failed"]).toContain(d.job.status); // 串行队列可能已经消化掉

    // 投递即给选题续期一次（§2）：正在深调研的选题不该被 3 天回收扫走
    expect((await getTopic(topic.id, dataDir))?.renewedAt).toBeTruthy();

    const again = await researchDeepDiveHandler(p());
    expect(again.ok).toBe(true);
    const second = again.data as { deduped: boolean; note: string };
    if (second.deduped) expect(second.note).toContain("已有调研在跑");
  });

  it("非对象 payload / 缺 topic_id → 守卫拦下", async () => {
    expect((await researchDeepDiveHandler(null as unknown as Record<string, unknown>)).ok).toBe(false);
    expect((await researchDeepDiveHandler({ _dataDir: dataDir })).ok).toBe(false);
  });
});

describe("research:status", () => {
  it("选题不存在 → ok:false", async () => {
    const res = await researchStatusHandler(p({ topic_id: "topic-1-gone" }));
    expect(res.ok).toBe(false);
  });

  it("没跑过：job=null，currentBrief=null，searchConfigured 照实报", async () => {
    const before = await researchStatusHandler(p());
    expect(before.ok).toBe(true);
    expect(before.data).toMatchObject({ job: null, searchConfigured: false, currentBrief: null });

    await configureSearch();
    const after = await researchStatusHandler(p());
    expect((after.data as { searchConfigured: boolean }).searchConfigured).toBe(true);
  });

  it("有简报：按 job.briefRevision 指针回元信息，stale=false", async () => {
    await seedJob();
    await saveBrief(topic.id, briefFixture(), dataDir);
    const res = await researchStatusHandler(p());
    expect(res.data).toMatchObject({
      currentBrief: { revision: 1, generatedAt: "2026-07-26T08:05:00.000Z", stale: false },
    });
  });

  it("选题标题改了 → stale=true（现算 hash 比对，不信存下来的布尔）", async () => {
    await seedJob();
    await saveBrief(topic.id, briefFixture(), dataDir);
    await updateTopic(topic.id, { title: "AI 编程助手横评（2026 重制版）" }, dataDir);
    const res = await researchStatusHandler(p());
    expect((res.data as { currentBrief: { stale: boolean } }).currentBrief.stale).toBe(true);
  });

  it("标题只多个空格 → 不算过期（hash 前先归一）", async () => {
    await seedJob();
    await saveBrief(topic.id, briefFixture(), dataDir);
    await updateTopic(topic.id, { title: `${topic.title}  ` }, dataDir);
    const res = await researchStatusHandler(p());
    expect((res.data as { currentBrief: { stale: boolean } }).currentBrief.stale).toBe(false);
  });

  it("重跑中：指针仍指向旧简报（旧简报在新版成功前一直有效）", async () => {
    await seedJob({ status: "running", claimedAt: new Date().toISOString(), perspectives: pendingPerspectives() });
    await saveBrief(topic.id, briefFixture(), dataDir);
    const res = await researchStatusHandler(p());
    const data = res.data as { job: ResearchJob; currentBrief: { revision: number } };
    expect(data.job.status).toBe("running");
    expect(data.currentBrief.revision).toBe(1);
  });
});

describe("research:brief_get", () => {
  it("没有 job / 没有指针 → 无简报", async () => {
    expect(String((await researchBriefGetHandler(p())).error)).toContain("还没有可用简报");
    await seedJob({ status: "failed", briefRevision: undefined, errorCode: "too_few_perspectives" });
    expect(String((await researchBriefGetHandler(p())).error)).toContain("还没有可用简报");
  });

  it("指针指向的文件缺失 → 可见报错，不当成空简报", async () => {
    await seedJob({ briefRevision: 7 });
    const res = await researchBriefGetHandler(p());
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("v7");
  });

  it("happy：返回完整 ResearchBrief + 过期标注", async () => {
    await seedJob();
    await saveBrief(topic.id, briefFixture(), dataDir);
    const res = await researchBriefGetHandler(p());
    expect(res.ok).toBe(true);
    const data = res.data as { brief: ResearchBrief; stale: boolean };
    expect(data.brief.summary).toContain("矛盾");
    expect(data.brief.evidence[0].sourceUrl).toBe("https://example.com/report");
    expect(data.brief.tensions).toHaveLength(1);
    expect(data.stale).toBe(false);
  });

  it("显式 revision 走不可变版本文件（回溯用），绕开指针", async () => {
    await seedJob({ briefRevision: 2 });
    await saveBrief(topic.id, briefFixture(), dataDir);
    await saveBrief(topic.id, briefFixture({ revision: 2, summary: "第二版" }), dataDir);
    const v1 = await researchBriefGetHandler(p({ revision: 1 }));
    expect((v1.data as { brief: ResearchBrief }).brief.summary).toContain("矛盾");
    const pointer = await researchBriefGetHandler(p());
    expect((pointer.data as { brief: ResearchBrief }).brief.summary).toBe("第二版");
  });
});

describe("research:list_assets", () => {
  it("无简报 → ok:false", async () => {
    expect((await researchListAssetsHandler(p())).ok).toBe(false);
  });

  it("happy：回当前简报的链接级素材候选", async () => {
    await seedJob();
    await saveBrief(topic.id, briefFixture(), dataDir);
    const res = await researchListAssetsHandler(p());
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ revision: 1, total: 1 });
    const assets = (res.data as { assets: Array<{ url: string; sourcePageUrl: string }> }).assets;
    expect(assets[0]).toMatchObject({
      url: "https://example.com/chart.png",
      sourcePageUrl: "https://example.com/report",
    });
  });
});

describe("chat 工具 deep_research", () => {
  const tool = (deps: Parameters<typeof buildChatTools>[2]) => {
    const t = buildChatTools([] as ChatCard[], dataDir, deps).find((x) => x.name === "deep_research");
    if (!t) throw new Error("deep_research 工具未注册");
    return t;
  };

  it("已注册，且把 topic_id 与 dataDir 透传给投递口", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const out = await tool({
      deepResearch: async (id: string, dir?: string) => {
        calls.push([id, dir]);
        return {
          accepted: true,
          deduped: false,
          job: {
            topicId: id,
            status: "queued" as const,
            startedAt: "2026-07-26T08:00:00.000Z",
            perspectives: pendingPerspectives(),
            topicHash: "h",
          },
        };
      },
    }).execute({ topic_id: topic.id });
    expect(calls).toEqual([[topic.id, dataDir]]);
    const parsed = JSON.parse(out as string);
    expect(parsed).toMatchObject({ ok: true, jobStatus: "queued", deduped: false });
    expect(String(parsed.note)).toContain("不要在本轮等结果");
  });

  it("进行中合并 → 回执说「已经在跑」", async () => {
    const out = await tool({
      deepResearch: async (id: string) => ({
        accepted: true as const,
        deduped: true,
        job: {
          topicId: id,
          status: "running" as const,
          startedAt: "2026-07-26T08:00:00.000Z",
          perspectives: PERSPECTIVE_NAMES.map((name, i) => ({
            name,
            status: i < 2 ? ("succeeded" as const) : ("running" as const),
          })),
          topicHash: "h",
        },
      }),
    }).execute({ topic_id: topic.id });
    const parsed = JSON.parse(out as string);
    expect(parsed).toMatchObject({ ok: true, deduped: true, perspectivesDone: "2/4" });
    expect(String(parsed.note)).toContain("已经在跑");
  });

  it("被拒（key 未配/选题没了）→ 原因原样回给总编辑", async () => {
    const out = await tool({
      deepResearch: async () => ({ accepted: false as const, reason: SEARCH_NOT_CONFIGURED }),
    }).execute({ topic_id: topic.id });
    expect(JSON.parse(out as string)).toEqual({ ok: false, error: SEARCH_NOT_CONFIGURED });
  });

  it("缺 topic_id → 直接拒，不投递", async () => {
    let called = false;
    const out = await tool({
      deepResearch: async () => {
        called = true;
        return { accepted: false as const, reason: "x" };
      },
    }).execute({});
    expect(JSON.parse(out as string).ok).toBe(false);
    expect(called).toBe(false);
  });
});
