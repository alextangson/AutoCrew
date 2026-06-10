import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBaseline, trackPerformance } from "./quality-baseline.js";
import { recordOutcome, listOutcomes } from "../flywheel/outcome-store.js";
import { saveContent, updateContent } from "../../storage/local-store.js";
import { addPerformanceEntry } from "../profile/creator-profile.js";

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
});
