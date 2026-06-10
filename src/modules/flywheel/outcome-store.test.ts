import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordOutcome, listOutcomes, getOutcomesForContent, matchDraft, diceSimilarity } from "./outcome-store.js";
import { saveContent, updateContent } from "../../storage/local-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-flywheel-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const baseInput = {
  contentId: "c1",
  platform: "douyin",
  platformTitle: "5个护肤技巧",
  publishedAt: "2026-06-01T10:00:00.000Z",
  metricDate: "2026-06-08",
  metrics: { views: 1000, completionRate: 35 },
  source: "csv" as const,
};

describe("recordOutcome", () => {
  it("records a valid outcome", async () => {
    const r = await recordOutcome(baseInput, testDir);
    expect(r.ok).toBe(true);
    expect(r.replaced).toBe(false);
    const all = await listOutcomes(testDir);
    expect(all).toHaveLength(1);
    expect(all[0].contentId).toBe("c1");
    expect(all[0].recordedAt).toBeTruthy();
  });

  it("rejects invalid outcome (completionRate > 100)", async () => {
    const r = await recordOutcome({ ...baseInput, metrics: { completionRate: 200 } }, testDir);
    expect(r.ok).toBe(false);
    expect(await listOutcomes(testDir)).toHaveLength(0);
  });

  it("is idempotent: same key overwrites, latest wins", async () => {
    await recordOutcome(baseInput, testDir);
    const r2 = await recordOutcome(
      { ...baseInput, metrics: { views: 1500, completionRate: 36 } },
      testDir,
    );
    expect(r2.replaced).toBe(true);
    const all = await listOutcomes(testDir);
    expect(all).toHaveLength(1);
    expect(all[0].metrics.views).toBe(1500);
  });

  it("different metricDate creates a new snapshot, not a replace", async () => {
    await recordOutcome(baseInput, testDir);
    await recordOutcome({ ...baseInput, metricDate: "2026-06-09" }, testDir);
    expect(await listOutcomes(testDir)).toHaveLength(2);
  });

  it("flags view-count spike vs platform median as needsReview", async () => {
    // 5 条普通数据建立中位数 ~1000
    for (let i = 0; i < 5; i++) {
      await recordOutcome(
        { ...baseInput, contentId: `c${i}`, metricDate: "2026-06-08", metrics: { views: 1000 + i } },
        testDir,
      );
    }
    const spike = await recordOutcome(
      { ...baseInput, contentId: "c-spike", metrics: { views: 100000 } },
      testDir,
    );
    expect(spike.ok).toBe(true);
    expect(spike.outcome?.needsReview).toBe(true);
    expect(spike.outcome?.reviewReasons.join()).toContain("中位数");
  });

  it("does not flag views below the 20x median threshold", async () => {
    // 5 条普通数据建立中位数 ~1000
    for (let i = 0; i < 5; i++) {
      await recordOutcome(
        { ...baseInput, contentId: `c${i}`, metricDate: "2026-06-08", metrics: { views: 1000 + i } },
        testDir,
      );
    }
    const high = await recordOutcome(
      { ...baseInput, contentId: "c-high", metrics: { views: 15000 } },
      testDir,
    );
    expect(high.ok).toBe(true);
    expect(high.outcome?.needsReview).toBe(false);
  });
});

describe("listOutcomes", () => {
  it("survives a corrupt journal line: valid records still readable", async () => {
    await recordOutcome(baseInput, testDir);
    await recordOutcome({ ...baseInput, contentId: "c2", platformTitle: "另一篇" }, testDir);
    // 模拟 append 中途崩溃留下的截断行
    await fs.appendFile(path.join(testDir, "outcomes.jsonl"), '{"contentId":"c-trunc', "utf-8");
    const all = await listOutcomes(testDir);
    expect(all).toHaveLength(2);
  });
});

describe("getOutcomesForContent", () => {
  it("returns only outcomes linked to the content id", async () => {
    await recordOutcome(baseInput, testDir);
    await recordOutcome({ ...baseInput, contentId: "c2", platformTitle: "另一篇" }, testDir);
    const got = await getOutcomesForContent("c1", testDir);
    expect(got).toHaveLength(1);
    expect(got[0].contentId).toBe("c1");
  });
});

describe("diceSimilarity", () => {
  it("identical strings = 1", () => {
    expect(diceSimilarity("护肤技巧分享", "护肤技巧分享")).toBe(1);
  });
  it("unrelated strings ≈ 0", () => {
    expect(diceSimilarity("护肤技巧分享", "汽车保养指南")).toBeLessThan(0.2);
  });
  it("minor truncation stays high", () => {
    expect(diceSimilarity("5个护肤技巧让你皮肤变好", "5个护肤技巧让你皮肤变")).toBeGreaterThan(0.8);
  });
});

describe("matchDraft", () => {
  async function publishContent(title: string, publishedAt: string) {
    const c = await saveContent(
      { title, body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt }, testDir);
    return c;
  }

  it("matches by exact normalized title", async () => {
    const c = await publishContent("5个护肤技巧！", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "5个护肤技巧", null, testDir);
    expect(hit?.id).toBe(c.id);
  });

  it("matches fuzzy title within 48h publish window", async () => {
    const c = await publishContent("5个护肤技巧让你皮肤变好", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "5个护肤技巧让你皮肤变好了", "2026-06-02T09:00:00.000Z", testDir);
    expect(hit?.id).toBe(c.id);
  });

  it("rejects fuzzy match outside 48h window", async () => {
    await publishContent("5个护肤技巧让你皮肤变好", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "5个护肤技巧让你皮肤变好了", "2026-06-20T09:00:00.000Z", testDir);
    expect(hit).toBeNull();
  });

  it("returns null for unknown title (historical item)", async () => {
    await publishContent("完全无关的标题", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "AutoCrew 诞生前的老视频", null, testDir);
    expect(hit).toBeNull();
  });

  it("does not match drafts of another platform", async () => {
    await publishContent("跨平台同标题", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("xiaohongshu", "跨平台同标题", null, testDir);
    expect(hit).toBeNull();
  });

  it("returns null when the title normalizes to empty (no matching basis)", async () => {
    // 双方标题归一化后都为空（纯符号/emoji）→ 不能凭空判定精确命中
    await publishContent("！！！", "2026-01-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "🔥🔥🔥", null, testDir);
    expect(hit).toBeNull();
  });

  it("rejects mid-range fuzzy score (0.6-0.8) when item publish time is missing", async () => {
    // 自校验：分数确实落在 [0.6, 0.8) 区间，否则该测试覆盖的不是 strict 分支
    const score = diceSimilarity("5个护肤技巧让你皮肤变好", "护肤技巧让皮肤变好哦呀");
    expect(score).toBeGreaterThanOrEqual(0.6);
    expect(score).toBeLessThan(0.8);
    await publishContent("5个护肤技巧让你皮肤变好", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "护肤技巧让皮肤变好哦呀", null, testDir);
    expect(hit).toBeNull();
  });

  it("matches via strict tier (>=0.8) when item publish time is missing", async () => {
    // 自校验：分数确实 ≥ 0.8
    const score = diceSimilarity("5个护肤技巧让你皮肤变好", "5个护肤技巧让你皮肤变");
    expect(score).toBeGreaterThanOrEqual(0.8);
    const c = await publishContent("5个护肤技巧让你皮肤变好", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "5个护肤技巧让你皮肤变", null, testDir);
    expect(hit?.id).toBe(c.id);
  });

  it("treats unparseable draft publish time as missing — strict tier, not silent window failure", async () => {
    const c = await publishContent("5个护肤技巧让你皮肤变好", "not-a-date");
    const hit = await matchDraft("douyin", "5个护肤技巧让你皮肤变", "2026-06-02T09:00:00.000Z", testDir);
    expect(hit?.id).toBe(c.id);
  });
});
