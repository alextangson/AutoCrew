import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeFlywheel, expandPath } from "./flywheel.js";
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

  it("record: honors metric_date for backfill", async () => {
    const c = await saveContent(
      { title: "口播稿B", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    const r = (await executeFlywheel({
      action: "record",
      content_id: c.id,
      metrics: { views: 500 },
      metric_date: "2026-06-05",
      _dataDir: testDir,
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    const outcomes = await listOutcomes(testDir);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].metricDate).toBe("2026-06-05");
  });

  it("record: rejects non-numeric metric values with a helpful error", async () => {
    const c = await saveContent(
      { title: "口播稿C", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    const r = (await executeFlywheel({
      action: "record",
      content_id: c.id,
      metrics: { views: 800, completionRate: "41%" as unknown as number },
      _dataDir: testDir,
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("completionRate");
    expect(await listOutcomes(testDir)).toHaveLength(0);
  });

  it("record: passes through outcome validator errors", async () => {
    const c = await saveContent(
      { title: "口播稿D", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    const r = (await executeFlywheel({
      action: "record",
      content_id: c.id,
      metrics: { completionRate: 200 },
      _dataDir: testDir,
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("完播率");
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

  it("report: works counts distinct works while totalOutcomes counts snapshots", async () => {
    const csvPath = path.join(testDir, "douyin.csv");
    await fs.writeFile(
      csvPath,
      "作品名称,发布时间,播放量,完播率\n视频1,2025-12-01 09:00,1000,30%\n视频2,2025-12-02 09:00,2000,31%\n视频3,2025-12-03 09:00,3000,33%\n",
      "utf-8",
    );
    // 同一份 CSV 两个数据日期导入 = 周常回填的真实形状：3 个作品 × 2 份快照
    await executeFlywheel({
      action: "import_csv", platform: "douyin", csv_path: csvPath, metric_date: "2026-06-08", _dataDir: testDir,
    });
    await executeFlywheel({
      action: "import_csv", platform: "douyin", csv_path: csvPath, metric_date: "2026-06-15", _dataDir: testDir,
    });

    const r = (await executeFlywheel({ action: "report", _dataDir: testDir })) as {
      ok: boolean;
      data: {
        totalOutcomes: number;
        works: {
          total: number;
          matched: number;
          historical: number;
          items: Array<{ title: string; platform: string; metricDate: string; metrics: Record<string, number> }>;
        };
        byPlatform: Record<string, number>;
        avgMetrics: Record<string, number>;
      };
    };
    expect(r.ok).toBe(true);
    expect(r.data.totalOutcomes).toBe(6); // 快照数随每周导入增长
    expect(r.data.works).toMatchObject({ total: 3, matched: 0, historical: 3 }); // 作品数不变
    // 作品明细(V5.6.2 数据回流页):每作品一条,取最新快照,携带标题/平台/日期/指标
    expect(r.data.works.items).toHaveLength(3);
    expect(r.data.works.items.every((it) => it.metricDate === "2026-06-15")).toBe(true);
    expect(r.data.works.items[0]).toMatchObject({ platform: "douyin" });
    expect(typeof r.data.works.items[0].metrics.views).toBe("number");
    expect(r.data.byPlatform).toEqual({ douyin: 3 }); // 按作品计，不按快照
    expect(r.data.avgMetrics.views).toBe(2000); // report 直接暴露 avgMetrics
  });

  it("record: platform_title supersedes the unmatched historical CSV entry", async () => {
    const c = await saveContent(
      { title: "我的草稿标题", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt: "2026-06-01T10:00:00.000Z" }, testDir);

    // CSV 标题与草稿差异大 → matchDraft 失败，落为 historical
    const csvPath = path.join(testDir, "douyin.csv");
    await fs.writeFile(csvPath, "作品名称,发布时间,播放量\n平台改过的标题,2026-06-01 09:00,5000\n", "utf-8");
    await executeFlywheel({
      action: "import_csv", platform: "douyin", csv_path: csvPath, metric_date: "2026-06-08", _dataDir: testDir,
    });
    const before = await listOutcomes(testDir);
    expect(before).toHaveLength(1);
    expect(before[0].contentId).toBeNull();

    // 用 platform_title=CSV 原标题补录 → 历史条目被打标版本替代，不双计
    const r = (await executeFlywheel({
      action: "record",
      content_id: c.id,
      platform_title: "平台改过的标题",
      metrics: { views: 5000 },
      metric_date: "2026-06-08",
      _dataDir: testDir,
    })) as { ok: boolean };
    expect(r.ok).toBe(true);

    const after = await listOutcomes(testDir);
    expect(after).toHaveLength(1);
    expect(after[0].platformTitle).toBe("平台改过的标题");
    expect(after[0].contentId).toBe(c.id);
  });
});

describe("expandPath", () => {
  it("expands ~/ to the home directory", () => {
    expect(expandPath("~/x.csv")).toBe(path.join(os.homedir(), "x.csv"));
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandPath("/abs/x.csv")).toBe("/abs/x.csv");
  });
});
