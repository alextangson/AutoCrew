import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeFlywheel } from "./flywheel.js";
import { saveContent, updateContent } from "../storage/local-store.js";
import { listOutcomes } from "../modules/flywheel/outcome-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-flytool-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("executeFlywheel", () => {
  it("import_csv: imports from a csv file path and returns report", async () => {
    const csvPath = path.join(testDir, "douyin.csv");
    await fs.writeFile(
      csvPath,
      "作品名称,发布时间,播放量,完播率\n老视频,2025-12-01 09:00,5000,28%\n",
      "utf-8",
    );
    const r = (await executeFlywheel({
      action: "import_csv",
      platform: "douyin",
      csv_path: csvPath,
      _dataDir: testDir,
    })) as { ok: boolean; data: { imported: number; historical: number } };
    expect(r.ok).toBe(true);
    expect(r.data.imported).toBe(1);
    expect(r.data.historical).toBe(1);
  });

  it("record: manual paste entry for a known content", async () => {
    const c = await saveContent(
      { title: "口播稿A", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt: "2026-06-01T10:00:00.000Z" }, testDir);

    const r = (await executeFlywheel({
      action: "record",
      content_id: c.id,
      metrics: { views: 800, completionRate: 41 },
      _dataDir: testDir,
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(await listOutcomes(testDir)).toHaveLength(1);
  });

  it("record: rejects unknown content id", async () => {
    const r = (await executeFlywheel({
      action: "record",
      content_id: "nope",
      metrics: { views: 1 },
      _dataDir: testDir,
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
  });

  it("report: returns counts, needsReview and baseline insights", async () => {
    const csvPath = path.join(testDir, "douyin.csv");
    await fs.writeFile(
      csvPath,
      "作品名称,发布时间,播放量,完播率\n视频1,2025-12-01 09:00,1000,30%\n视频2,2025-12-02 09:00,2000,31%\n视频3,2025-12-03 09:00,3000,33%\n",
      "utf-8",
    );
    await executeFlywheel({ action: "import_csv", platform: "douyin", csv_path: csvPath, _dataDir: testDir });

    const r = (await executeFlywheel({ action: "report", _dataDir: testDir })) as {
      ok: boolean;
      data: { totalOutcomes: number; needsReview: unknown[]; baselineInsights: string[]; traitSampleSize: number };
    };
    expect(r.ok).toBe(true);
    expect(r.data.totalOutcomes).toBe(3);
    expect(r.data.baselineInsights.length).toBeGreaterThan(0);
    expect(r.data.traitSampleSize).toBe(0); // 三条均为 historical，无打标条目
  });
});
