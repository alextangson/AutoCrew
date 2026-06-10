import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordOutcome, listOutcomes, getOutcomesForContent } from "./outcome-store.js";

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
