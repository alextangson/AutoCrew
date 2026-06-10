import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBaseline, compareToBaseline, trackPerformance, getPerformanceScore } from "./quality-baseline.js";
import { recordOutcome, listOutcomes } from "../flywheel/outcome-store.js";
import { saveContent, updateContent } from "../../storage/local-store.js";
import { addPerformanceEntry } from "../profile/creator-profile.js";
import { getPack } from "../packs/index.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-baseline-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

async function seedOutcome(contentId: string | null, title: string, views: number, metricDate: string) {
  await recordOutcome(
    {
      contentId,
      platform: "douyin",
      platformTitle: title,
      publishedAt: "2026-06-01T10:00:00.000Z",
      metricDate,
      metrics: { views, completionRate: 30 },
      source: "csv",
    },
    testDir,
  );
}

describe("buildBaseline from outcome store", () => {
  it("builds baseline from outcome store entries (including historical)", async () => {
    await seedOutcome("c1", "标题一", 1000, "2026-06-08");
    await seedOutcome("c2", "标题二", 2000, "2026-06-08");
    await seedOutcome(null, "历史作品", 3000, "2026-06-08");

    const baseline = await buildBaseline(testDir);
    expect(baseline.sampleSize).toBe(3);
    expect(baseline.avgMetrics.views).toBe(2000);
  });

  it("uses only the latest snapshot per item, not every metricDate", async () => {
    await seedOutcome("c1", "标题一", 1000, "2026-06-07");
    await seedOutcome("c1", "标题一", 1500, "2026-06-08"); // 同一作品的更新快照
    await seedOutcome("c2", "标题二", 2000, "2026-06-08");
    await seedOutcome("c3", "标题三", 3000, "2026-06-08");

    const baseline = await buildBaseline(testDir);
    expect(baseline.sampleSize).toBe(3); // c1 只算一次
    expect(baseline.avgMetrics.views).toBe(Math.round((1500 + 2000 + 3000) / 3));
  });

  it("emits an avgMetrics-level day-1 insight when history exists but nothing is matched", async () => {
    // day-1 形状：纯历史回灌，sampleSize 过 3 但 traitSampleSize = 0
    for (let i = 0; i < 10; i++) {
      await seedOutcome(null, `历史作品${i}`, 5000 + i * 100, "2026-06-08");
    }
    const baseline = await buildBaseline(testDir);
    expect(baseline.sampleSize).toBe(10);
    expect(baseline.traitSampleSize).toBe(0);
    expect(baseline.insights[0]).toContain("平均播放");
    expect(baseline.insights[0]).toContain("打标");
    expect(baseline.insights[0]).not.toContain("数据还不够多");
  });

  it("averages a metric only over entries that carry it (no zero-dilution across platforms)", async () => {
    // 真实场景：小红书导出没有完播率列，视频号有——缺失平台不得把均值拖向 0
    await recordOutcome(
      { contentId: null, platform: "wechat_video", platformTitle: "视频A", publishedAt: "2026-06-01T10:00:00.000Z", metricDate: "2026-06-08", metrics: { views: 500, completionRate: 6 }, source: "csv" },
      testDir,
    );
    await recordOutcome(
      { contentId: null, platform: "wechat_video", platformTitle: "视频B", publishedAt: "2026-06-01T10:00:00.000Z", metricDate: "2026-06-08", metrics: { views: 300, completionRate: 4 }, source: "csv" },
      testDir,
    );
    await recordOutcome(
      { contentId: null, platform: "xiaohongshu", platformTitle: "笔记无完播率", publishedAt: "2026-06-01T10:00:00.000Z", metricDate: "2026-06-08", metrics: { views: 1000 }, source: "csv" },
      testDir,
    );

    const baseline = await buildBaseline(testDir);
    expect(baseline.avgMetrics.views).toBe(600); // 三条都有 views
    expect(baseline.avgMetrics.completionRate).toBe(5); // 只在有完播率的 2 条上平均，不是 (6+4+0)/3≈3
  });

  it("falls back to legacy profile.performanceHistory when outcome store empty", async () => {
    for (const [id, views] of [["a", 100], ["b", 200], ["c", 300]] as const) {
      await addPerformanceEntry({ contentId: id, platform: "douyin", metrics: { views } }, testDir);
    }
    const baseline = await buildBaseline(testDir);
    expect(baseline.sampleSize).toBe(3);
    expect(baseline.avgMetrics.views).toBe(200);
  });
});

describe("trackPerformance writes through outcome store", () => {
  it("records into outcome journal with source=paste", async () => {
    const c = await saveContent(
      { title: "手动回填的稿子", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt: "2026-06-01T10:00:00.000Z" }, testDir);

    const r = await trackPerformance(c.id, { views: 500, likes: 20 }, testDir);
    expect(r.ok).toBe(true);

    const outcomes = await listOutcomes(testDir);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].contentId).toBe(c.id);
    expect(outcomes[0].source).toBe("paste");
  });

  it("surfaces the rejection reason when metrics are invalid", async () => {
    const c = await saveContent(
      {
        title: "数据有误的稿子",
        body: "正文",
        platform: "douyin",
        status: "published",
        publishedAt: "2026-06-01T10:00:00.000Z",
        tags: [],
      },
      testDir,
    );

    const r = await trackPerformance(c.id, { completionRate: 200 }, testDir);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("完播率");
  });
});

// 10 条历史回灌（高播放、无对应 content）+ 3 条 matched（真实 content、播放较低）。
// 这是 week-1 的典型数据形状：历史条目会占满 top 档位，修复前 traits 切分会拿
// 真实 traits 对比全零档位，捏造"平均 0 字"类建议。
async function seedMixedData(): Promise<{ topBody: string }> {
  for (let i = 0; i < 10; i++) {
    await seedOutcome(null, `历史作品${i}`, 5000 + i * 100, "2026-06-08");
  }
  const bodies = [
    "这是第一篇正文。\n\n讲了三个要点，篇幅适中。\n\n记得点赞关注。",
    "这是第二篇正文，内容稍长一点。\n\n也讲了几个要点。\n\n欢迎评论留言。",
    "这是第三篇正文。\n\n干货比较多，讲得也细。\n\n喜欢的话收藏一下。",
  ];
  for (let i = 0; i < 3; i++) {
    const c = await saveContent(
      {
        title: `匹配稿${i}`,
        body: bodies[i],
        platform: "douyin",
        status: "published",
        publishedAt: "2026-06-01T10:00:00.000Z",
        tags: [],
      },
      testDir,
    );
    await seedOutcome(c.id, `匹配稿${i}`, 800 + i * 200, "2026-06-08");
  }
  return { topBody: bodies[2] }; // 匹配稿2 views 最高 → top 档位
}

describe("buildBaseline with mixed historical + matched data", () => {
  it("does not fabricate comparative insights from zero-trait historical bands", async () => {
    await seedMixedData();

    const baseline = await buildBaseline(testDir);
    // avgMetrics / sampleSize 在全量（含历史）上计算
    expect(baseline.sampleSize).toBe(13);
    expect(baseline.avgMetrics.views).toBe(Math.round(57500 / 13));
    // traits 来自真实 matched contents，不是全零档位
    expect(baseline.topContentTraits.avgLength).toBeGreaterThan(0);
    expect(baseline.lowContentTraits.avgLength).toBeGreaterThan(0);
    // 不得出现"平均 0 字"类捏造对比
    for (const insight of baseline.insights) {
      expect(insight).not.toMatch(/平均 0 字/);
    }
  });

  it("compareToBaseline does not report all-poor against fabricated zero traits", async () => {
    const { topBody } = await seedMixedData();
    const draft = await saveContent(
      { title: "新草稿", body: topBody, platform: "douyin", status: "draft_ready", tags: [] },
      testDir,
    );

    const r = await compareToBaseline(draft.id, testDir);
    const lengthComp = r.comparisons.find((c) => c.dimension === "内容长度");
    expect(String(lengthComp?.baseline)).not.toMatch(/^0 字/);
    expect(lengthComp?.status).not.toBe("poor");
    expect(r.comparisons.every((c) => c.status === "poor")).toBe(false);
  });

  it("compareToBaseline returns insufficient-data when no entries match AutoCrew contents", async () => {
    // day-1 状态：纯历史回灌，0 条 matched —— sampleSize 过 3 但 trait 档位全空
    for (let i = 0; i < 10; i++) {
      await seedOutcome(null, `历史作品${i}`, 5000 + i * 100, "2026-06-08");
    }
    const draft = await saveContent(
      { title: "新草稿", body: "随便写点正文。\n\n第二段内容。", platform: "douyin", status: "draft_ready", tags: [] },
      testDir,
    );

    const r = await compareToBaseline(draft.id, testDir);
    expect(r.matchScore).toBe(50);
    expect(r.comparisons).toHaveLength(0);
    expect(r.summary).toContain("打标");
    expect(JSON.stringify(r)).not.toContain("0 字");
  });
});

describe("pack-weighted performance scoring", () => {
  const pack = getPack("koubo");

  it("douyin entry scores by completion5s-led weights", () => {
    const score = getPerformanceScore(
      { contentId: "a", platform: "douyin", metrics: { completion5s: 37.39, completionRate: 1.89, views: 3376, favorites: 95 }, recordedAt: "x" },
      pack,
    );
    // 8×37.39 + 15×1.89 + 0.01×3376 + 4×95 = 299.12 + 28.35 + 33.76 + 380 = 741.23
    expect(score).toBeCloseTo(741.23, 1);
  });

  it("xiaohongshu entry scores without completion metrics", () => {
    const score = getPerformanceScore(
      { contentId: "b", platform: "xiaohongshu", metrics: { views: 1985, favorites: 99, follows: 27 }, recordedAt: "x" },
      pack,
    );
    // 0.02×1985 + 6×99 + 10×27 = 39.7 + 594 + 270 = 903.7
    expect(score).toBeCloseTo(903.7, 1);
  });

  it("unknown platform falls back to default weights", () => {
    const score = getPerformanceScore(
      { contentId: "c", platform: "bilibili", metrics: { completionRate: 10, views: 100 }, recordedAt: "x" },
      pack,
    );
    // default: 15×10 + 0.01×100 = 151
    expect(score).toBeCloseTo(151, 1);
  });
});
