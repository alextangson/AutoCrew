import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCsv, parseMetricNumber, importPerformanceCsv, PLATFORM_MAPPINGS } from "./csv-import.js";
import { saveContent, updateContent } from "../../storage/local-store.js";
import { listOutcomes } from "./outcome-store.js";

describe("parseCsv", () => {
  it("parses headers and rows", () => {
    const rows = parseCsv("标题,播放量\n护肤技巧,1234\n汽车保养,5678");
    expect(rows).toHaveLength(2);
    expect(rows[0]["标题"]).toBe("护肤技巧");
    expect(rows[1]["播放量"]).toBe("5678");
  });

  it("strips UTF-8 BOM and handles CRLF", () => {
    const rows = parseCsv("﻿标题,播放量\r\n护肤技巧,1234\r\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]["标题"]).toBe("护肤技巧");
  });

  it("handles quoted fields containing commas", () => {
    const rows = parseCsv('标题,播放量\n"护肤，进阶版",1234');
    expect(rows[0]["标题"]).toBe("护肤，进阶版");
  });

  it("handles escaped quotes inside quoted fields", () => {
    const rows = parseCsv('标题,播放量\n"他说""真香""",99');
    expect(rows[0]["标题"]).toBe('他说"真香"');
  });

  it("skips blank lines", () => {
    const rows = parseCsv("标题,播放量\n护肤,1\n\n汽车,2\n");
    expect(rows).toHaveLength(2);
  });
});

describe("parseMetricNumber", () => {
  it("parses plain numbers and comma separators", () => {
    expect(parseMetricNumber("1234")).toBe(1234);
    expect(parseMetricNumber("1,234")).toBe(1234);
  });
  it("parses 万 and w suffix", () => {
    expect(parseMetricNumber("1.2万")).toBe(12000);
    expect(parseMetricNumber("3.4w")).toBe(34000);
  });
  it("parses percentage as plain number (completionRate semantics)", () => {
    expect(parseMetricNumber("12.3%")).toBe(12.3);
  });
  it("returns undefined for empty or non-numeric", () => {
    expect(parseMetricNumber("")).toBeUndefined();
    expect(parseMetricNumber("-")).toBeUndefined();
    expect(parseMetricNumber(undefined)).toBeUndefined();
  });
  it("parses 亿 suffix", () => {
    expect(parseMetricNumber("1.2亿")).toBe(120000000);
  });
  it("returns undefined for malformed number like 1.2.3万", () => {
    expect(parseMetricNumber("1.2.3万")).toBeUndefined();
  });
  it("returns undefined for datetime string like 2026-06-01 10:00", () => {
    expect(parseMetricNumber("2026-06-01 10:00")).toBeUndefined();
  });
  it("returns undefined for .万", () => {
    expect(parseMetricNumber(".万")).toBeUndefined();
  });
  it("parses zero", () => {
    expect(parseMetricNumber("0")).toBe(0);
  });
  it("parses negative numbers", () => {
    expect(parseMetricNumber("-5")).toBe(-5);
  });
});

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-csv-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const DOUYIN_CSV = `﻿作品名称,发布时间,播放量,完播率,点赞量,评论量,分享量,收藏量,粉丝增量
5个护肤技巧,2026-06-01 10:00,1.2万,32.5%,300,45,20,80,15
AutoCrew 之前的老视频,2025-12-01 09:00,5000,28%,100,10,5,30,3
坏数据行,2026-06-01 10:00,-,-,-,-,-,-,-`;

describe("importPerformanceCsv", () => {
  it("imports rows, matches drafts, marks historical, rejects empty", async () => {
    const c = await saveContent(
      { title: "5个护肤技巧", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt: "2026-06-01T10:30:00.000Z" }, testDir);

    const report = await importPerformanceCsv("douyin", DOUYIN_CSV, "2026-06-08", testDir);

    expect(report.total).toBe(3);
    expect(report.imported).toBe(2);
    expect(report.matched).toBe(1);
    expect(report.historical).toBe(1);
    expect(report.rejected).toHaveLength(1);

    const outcomes = await listOutcomes(testDir);
    expect(outcomes).toHaveLength(2);
    const matched = outcomes.find((o) => o.contentId === c.id);
    expect(matched?.metrics.views).toBe(12000);
    expect(matched?.metrics.completionRate).toBe(32.5);
    expect(matched?.metrics.follows).toBe(15);
    const historical = outcomes.find((o) => o.contentId === null);
    expect(historical?.platformTitle).toBe("AutoCrew 之前的老视频");
  });

  it("re-import of same file replaces instead of duplicating (idempotent)", async () => {
    await importPerformanceCsv("douyin", DOUYIN_CSV, "2026-06-08", testDir);
    const second = await importPerformanceCsv("douyin", DOUYIN_CSV, "2026-06-08", testDir);
    expect(second.replaced).toBe(2);
    expect(await listOutcomes(testDir)).toHaveLength(2);
  });

  it("errors on unknown platform", async () => {
    await expect(importPerformanceCsv("bilibili", DOUYIN_CSV, "2026-06-08", testDir)).rejects.toThrow(
      /没有.*映射/,
    );
  });

  it("re-import after confirm_published supersedes the historical entry (no double count)", async () => {
    const CSV = `作品名称,发布时间,播放量,完播率\n护肤新稿,2026-06-01 10:00,1000,30%`;
    await importPerformanceCsv("douyin", CSV, "2026-06-08", testDir); // 未匹配 → historical
    const c = await saveContent(
      { title: "护肤新稿", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt: "2026-06-01T10:00:00.000Z" }, testDir);
    const second = await importPerformanceCsv("douyin", CSV, "2026-06-08", testDir); // 匹配 → contentId 键
    expect(second.matched).toBe(1);
    const outcomes = await listOutcomes(testDir);
    const forTitle = outcomes.filter((o) => o.platformTitle === "护肤新稿");
    expect(forTitle).toHaveLength(1);
    expect(forTitle[0].contentId).toBe(c.id);
  });

  it("normalizes 数据日期 column without timezone shift (2026/6/8 → 2026-06-08)", async () => {
    const CSV = `作品名称,发布时间,播放量,完播率,数据日期\n护肤A,2026-06-01 10:00,1000,30%,2026/6/8`;
    await importPerformanceCsv("douyin", CSV, "2026-06-01", testDir);
    const outcomes = await listOutcomes(testDir);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].metricDate).toBe("2026-06-08");
  });

  it("normalizes datetime 数据日期 without timezone shift (2026-06-08 02:00 → 2026-06-08)", async () => {
    const CSV = `作品名称,发布时间,播放量,完播率,数据日期\n护肤B,2026-06-01 10:00,1000,30%,2026-06-08 02:00`;
    await importPerformanceCsv("douyin", CSV, "2026-06-01", testDir);
    const outcomes = await listOutcomes(testDir);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].metricDate).toBe("2026-06-08");
  });

  it("matched import supersedes historical twin across different metricDates", async () => {
    const WEEK1 = `作品名称,发布时间,播放量,完播率\n护肤周报,2026-06-01 10:00,1000,30%`;
    const WEEK2 = `作品名称,发布时间,播放量,完播率\n护肤周报,2026-06-01 10:00,2000,35%`;
    await importPerformanceCsv("douyin", WEEK1, "2026-06-08", testDir); // 未匹配 → historical
    const c = await saveContent(
      { title: "护肤周报", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt: "2026-06-01T10:00:00.000Z" }, testDir);
    const second = await importPerformanceCsv("douyin", WEEK2, "2026-06-15", testDir); // 匹配，不同数据日期
    expect(second.matched).toBe(1);
    const outcomes = await listOutcomes(testDir);
    const forTitle = outcomes.filter((o) => o.platformTitle === "护肤周报");
    expect(forTitle.length).toBeGreaterThan(0);
    expect(forTitle.every((o) => o.contentId === c.id)).toBe(true);
  });
});

describe("PLATFORM_MAPPINGS", () => {
  it("covers the three v1 platforms", () => {
    expect(Object.keys(PLATFORM_MAPPINGS).sort()).toEqual(["douyin", "wechat_video", "xiaohongshu"]);
  });
});

describe("ratioMetrics（抖音作品列表导出为小数比例）", () => {
  it("converts ratio completion rates to percentages without flagging needsReview", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-ratio-test-"));
    try {
      const CSV = `作品名称,发布时间,播放量,完播率\n口播A,2026-03-30 17:05:00,3376,0.018947\n口播B,2026-03-29 16:56:42,1419,0.027832`;
      const report = await importPerformanceCsv("douyin", CSV, "2026-06-10", dir);
      expect(report.imported).toBe(2);
      expect(report.needsReview).toHaveLength(0); // 已按映射声明转换，不再触发小数比例启发
      const outcomes = await listOutcomes(dir);
      const a = outcomes.find((o) => o.platformTitle === "口播A");
      expect(a?.metrics.completionRate).toBe(1.89); // 0.018947 → 1.89%
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves percentage-form values untouched even with the flag on", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-ratio-test2-"));
    try {
      const CSV = `作品名称,发布时间,播放量,完播率\n口播C,2026-03-30 17:05:00,3376,32.5%`;
      await importPerformanceCsv("douyin", CSV, "2026-06-10", dir);
      const outcomes = await listOutcomes(dir);
      expect(outcomes[0]?.metrics.completionRate).toBe(32.5); // 已是百分比（>1），不重复转换
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ratioMetrics boundary", () => {
  it("ratio 1.0 means 100% completion under the mapping declaration", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-ratio-boundary-"));
    try {
      const CSV = `作品名称,发布时间,播放量,完播率\n超短视频,2026-03-30 17:05:00,100,1`;
      await importPerformanceCsv("douyin", CSV, "2026-06-10", dir);
      const o = (await listOutcomes(dir))[0];
      expect(o.metrics.completionRate).toBe(100); // 比例声明下 1 = 100%，不是 1%
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("completion5s ingestion (douyin 作品列表)", () => {
  it("ingests 5s完播率 as ratio-converted completion5s", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-c5s-test-"));
    try {
      const CSV = `作品名称,发布时间,播放量,完播率,5s完播率\n口播D,2026-03-30 17:05:00,3376,0.018947,0.373904`;
      const report = await importPerformanceCsv("douyin", CSV, "2026-06-10", dir);
      expect(report.imported).toBe(1);
      expect(report.needsReview).toHaveLength(0);
      const o = (await listOutcomes(dir))[0];
      expect(o.metrics.completionRate).toBe(1.89);
      expect(o.metrics.completion5s).toBe(37.39);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
