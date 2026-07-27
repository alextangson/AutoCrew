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
  researchImportAssetHandler,
  researchListAssetsHandler,
  researchStatusHandler,
} from "./research-handlers.js";
import {
  getResearchAsset,
  saveResearchAsset,
  type ResearchAsset,
} from "../modules/research/research-asset-store.js";
import type { ArticleImageReview } from "../modules/publish/article-images.js";
import type { BriefAssetPick } from "../modules/research/brief-store.js";
import type { FetchedImage } from "../modules/research/fetch-image.js";
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
import {
  getTopic,
  saveContent,
  saveTopic,
  updateTopic,
  type Content,
  type Topic,
} from "../storage/local-store.js";

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

// ─── 素材侧的夹具（R1b-B） ───────────────────────────────────────────────────

/** 手搓 PNG 头：24 字节里写死 800×600，magic/IHDR 都真，够 store 与配图校验收下 */
function pngBytes(seed: string): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(800, 16);
  head.writeUInt32BE(600, 20);
  return Buffer.concat([head, Buffer.from(seed, "utf-8")]);
}

/** 真 WebP 头：正文配图按字节魔数只收 png/jpg，webp 必须在那一层被认出来 */
function webpBytes(): Buffer {
  const b = Buffer.alloc(32);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(24, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8 ", 12, "latin1");
  return b;
}

function seedAsset(over: Partial<FetchedImage> = {}): Promise<ResearchAsset> {
  const image: FetchedImage = {
    bytes: pngBytes(over.finalUrl ?? "chart"),
    format: "png",
    width: 800,
    height: 600,
    finalUrl: "https://example.com/chart.png",
    ...over,
  };
  return saveResearchAsset(
    {
      topicId: topic.id,
      sourceUrl: image.finalUrl,
      sourcePageUrl: "https://example.com/report",
      caption: "提效曲线",
    },
    image,
    dataDir,
  );
}

const pickFor = (assetId: string): BriefAssetPick => ({
  url: "https://example.com/chart.png",
  sourcePageUrl: "https://example.com/report",
  caption: "提效曲线",
  assetId,
});

const listed = (res: Record<string, unknown>) =>
  (res.data as { assets: Array<Record<string, unknown>> }).assets;

const newContent = (body = "开头\n\n[IMAGE: 一张图]\n\n结尾"): Promise<Content> =>
  saveContent(
    { title: "稿件", body, status: "draft_ready", tags: [], topicId: topic.id, platform: "wechat_mp" },
    dataDir,
  );

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

  it("链接级候选（R1a 旧简报，没跑过下载）→ stored:false，无 fileUrl", async () => {
    await seedJob();
    await saveBrief(topic.id, briefFixture(), dataDir);
    const res = await researchListAssetsHandler(p());
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ revision: 1, total: 1, storedCount: 0 });
    expect(listed(res)[0]).toMatchObject({
      url: "https://example.com/chart.png",
      sourcePageUrl: "https://example.com/report",
      stored: false,
    });
    expect(listed(res)[0].fileUrl).toBeUndefined();
  });

  it("已下载的：stored:true + 尺寸 + 取图地址", async () => {
    const asset = await seedAsset();
    await seedJob();
    await saveBrief(topic.id, briefFixture({ assetPicks: [pickFor(asset.assetId)] }), dataDir);

    const res = await researchListAssetsHandler(p());
    expect(res.data).toMatchObject({ total: 1, storedCount: 1 });
    expect(listed(res)[0]).toMatchObject({
      stored: true,
      width: 800,
      height: 600,
      caption: "提效曲线",
      fileUrl: `/api/research-asset?asset_id=${asset.assetId}`,
    });
  });

  it("降级那张：stored:false 且原因原样带出来", async () => {
    await seedJob();
    await saveBrief(
      topic.id,
      briefFixture({
        assetPicks: [
          {
            url: "https://example.com/chart.png",
            sourcePageUrl: "https://example.com/report",
            caption: "提效曲线",
            downloadError: "对方站点拒绝取图（多半是防盗链）",
          },
        ],
      }),
      dataDir,
    );
    const res = await researchListAssetsHandler(p());
    expect(res.data).toMatchObject({ storedCount: 0 });
    expect(listed(res)[0]).toMatchObject({ stored: false, downloadError: "对方站点拒绝取图（多半是防盗链）" });
  });

  it("索引说有、文件没了 → stored:false 并说清楚（不假装能显示）", async () => {
    const asset = await seedAsset();
    await fs.rm(path.join(dataDir, asset.file));
    await seedJob();
    await saveBrief(topic.id, briefFixture({ assetPicks: [pickFor(asset.assetId)] }), dataDir);

    const res = await researchListAssetsHandler(p());
    expect(res.data).toMatchObject({ storedCount: 0 });
    expect(listed(res)[0]).toMatchObject({ stored: false, downloadError: "素材文件已丢失，只剩链接" });
  });
});

describe("research:import_asset", () => {
  const importP = (extra: Record<string, unknown> = {}) => p(extra);

  it("happy：走正文配图既有承接口落进第一个空位，素材转 imported", async () => {
    const asset = await seedAsset();
    const content = await newContent();

    const res = await researchImportAssetHandler(
      importP({ asset_id: asset.assetId, content_id: content.id }),
    );
    expect(res.ok).toBe(true);
    const data = res.data as { review: ArticleImageReview; index: number; deduped: boolean };
    expect(data).toMatchObject({ index: 0, deduped: false });

    const entry = data.review.entries[0];
    expect(entry).toMatchObject({ status: "ready", origin: "research", sourceAssetId: asset.assetId });
    // 字节真落到该稿件的配图目录里（不是引用研究素材库的路径）
    expect(entry.imagePath).toContain(path.join("contents", content.id));
    expect((await fs.readFile(entry.imagePath!)).equals(await fs.readFile(path.join(dataDir, asset.file)))).toBe(true);
    expect((await getResearchAsset(asset.assetId, dataDir))?.status).toBe("imported");
  });

  it("幂等：同一素材再导同一位置 → deduped，revision 不动", async () => {
    const asset = await seedAsset();
    const content = await newContent();
    const first = await researchImportAssetHandler(
      importP({ asset_id: asset.assetId, content_id: content.id, index: 0 }),
    );
    const revision = (first.data as { review: ArticleImageReview }).review.entries[0].revision;

    const again = await researchImportAssetHandler(
      importP({ asset_id: asset.assetId, content_id: content.id, index: 0 }),
    );
    expect(again.ok).toBe(true);
    const data = again.data as { review: ArticleImageReview; deduped: boolean };
    expect(data.deduped).toBe(true);
    expect(data.review.entries[0].revision).toBe(revision);
  });

  it("跨 content 重复导：一张图可以进两篇稿子，两边都真落地", async () => {
    const asset = await seedAsset();
    const a = await newContent();
    const b = await newContent();

    const first = await researchImportAssetHandler(importP({ asset_id: asset.assetId, content_id: a.id }));
    const second = await researchImportAssetHandler(importP({ asset_id: asset.assetId, content_id: b.id }));

    expect(first.ok && second.ok).toBe(true);
    expect((second.data as { deduped: boolean }).deduped).toBe(false);
    const entry = (second.data as { review: ArticleImageReview }).review.entries[0];
    expect(entry.status).toBe("ready");
    expect(entry.imagePath).toContain(path.join("contents", b.id));
  });

  it("指定位置：落到第 index 槽，不动别的槽", async () => {
    const asset = await seedAsset();
    const content = await newContent("正文\n\n[IMAGE: 第一张]\n\n更多\n\n[IMAGE: 第二张]");
    const res = await researchImportAssetHandler(
      importP({ asset_id: asset.assetId, content_id: content.id, index: 1 }),
    );
    const review = (res.data as { review: ArticleImageReview }).review;
    expect(review.entries[0].status).toBe("missing");
    expect(review.entries[1]).toMatchObject({ status: "ready", sourceAssetId: asset.assetId });
  });

  it.each([
    ["content 不存在", { content_id: "content-1-gone" }, "稿件不存在"],
    ["asset 不存在", { asset_id: "rasset-1-gone" }, "研究素材不存在"],
    ["content_id 形状不合法", { content_id: "not-an-id" }, "合法 content_id"],
  ])("%s → ok:false 且说清是什么问题", async (_label, over, expected) => {
    const asset = await seedAsset();
    const content = await newContent();
    const res = await researchImportAssetHandler(
      importP({ asset_id: asset.assetId, content_id: content.id, ...over }),
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(expected);
  });

  it("素材不属于该选题 → 拒（界面串了选题时不能静默照做）", async () => {
    const asset = await seedAsset();
    const content = await newContent();
    const other = await saveTopic({ title: "别的选题", description: "x", tags: [] }, dataDir);
    const res = await researchImportAssetHandler(
      importP({ topic_id: other.id, asset_id: asset.assetId, content_id: content.id }),
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("不属于该选题");
  });

  it("稿件里没有插图位 → 说人话地拒，不凭空造一个位置", async () => {
    const asset = await seedAsset();
    const content = await newContent("一段没有任何插图标记的正文");
    const res = await researchImportAssetHandler(
      importP({ asset_id: asset.assetId, content_id: content.id }),
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("还没有插图位");
  });

  it("素材文件丢了 → 拒，不写一个坏图进配图区", async () => {
    const asset = await seedAsset();
    const content = await newContent();
    await fs.rm(path.join(dataDir, asset.file));
    const res = await researchImportAssetHandler(
      importP({ asset_id: asset.assetId, content_id: content.id }),
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("研究素材文件");
  });

  it("webp 素材 → 被既有承接口的格式校验挡下（没绕开它的校验）", async () => {
    const asset = await seedAsset({
      format: "webp",
      bytes: webpBytes(),
      finalUrl: "https://example.com/pic.webp",
    });
    const content = await newContent();
    const res = await researchImportAssetHandler(
      importP({ asset_id: asset.assetId, content_id: content.id }),
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("PNG/JPG");
  });

  it("缺必填 / 非对象 payload → 守卫拦下", async () => {
    expect((await researchImportAssetHandler(null as unknown as Record<string, unknown>)).ok).toBe(false);
    expect((await researchImportAssetHandler(p({ content_id: "content-1-a" }))).ok).toBe(false);
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
