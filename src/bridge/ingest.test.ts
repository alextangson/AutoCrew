import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rowsToCsvText, handleBridgeMessage } from "./ingest.js";
import { parseCsv } from "../modules/flywheel/csv-import.js";
import { listOutcomes } from "../modules/flywheel/outcome-store.js";
import type { BridgeMessage } from "./protocol.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-bridge-ingest-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ─── rowsToCsvText ────────────────────────────────────────────────────────────

describe("rowsToCsvText", () => {
  it("produces header + one data row", () => {
    const csv = rowsToCsvText([{ a: "1", b: "2" }]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("a,b");
    expect(lines[1]).toBe("1,2");
  });

  it("quotes fields that contain commas", () => {
    const csv = rowsToCsvText([{ x: "hello,world" }]);
    expect(csv).toContain('"hello,world"');
  });

  it("quotes fields that contain double-quotes (escaped as \"\")", () => {
    const csv = rowsToCsvText([{ x: 'say "hi"' }]);
    expect(csv).toContain('"say ""hi"""');
  });

  it("sanitizes newlines to single space (parseCsv 不支持换行内嵌字段)", () => {
    const csv = rowsToCsvText([{ x: "line1\nline2" }]);
    expect(csv).toContain("line1 line2");
    expect(csv).not.toContain("line1\nline2");
  });

  it("returns empty string for empty rows array", () => {
    expect(rowsToCsvText([])).toBe("");
  });

  // ─── round-trip property: rowsToCsvText ↔ parseCsv ───────────────────────

  it("round-trips plain values through parseCsv", () => {
    const rows = [{ 标题: "测试视频", 播放量: "12345", 完播率: "0.35" }];
    const csv = rowsToCsvText(rows);
    const back = parseCsv(csv);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ 标题: "测试视频", 播放量: "12345", 完播率: "0.35" });
  });

  it("round-trips values with commas and quotes", () => {
    const rows = [{ a: 'say "hi", ok', b: "normal,value", c: 'with ""quotes""' }];
    const csv = rowsToCsvText(rows);
    const back = parseCsv(csv);
    expect(back).toHaveLength(1);
    expect(back[0]["a"]).toBe('say "hi", ok');
    expect(back[0]["b"]).toBe("normal,value");
    expect(back[0]["c"]).toBe('with ""quotes""');
  });

  it("row with embedded \\n and \\r\\n survives parseCsv intact — no row tearing", () => {
    // DOM innerText 会带换行；不清洗的话首列撕裂 → 误导性 rejected（指向选择器校准），
    // 非首列撕裂 → 表头错位静默腐蚀 journal
    const rows = [
      {
        作品名称: "标题第一行\n标题第二行",
        播放量: "12345",
        完播率: "0.35\r\n后缀",
        点赞量: "500",
      },
    ];
    const back = parseCsv(rowsToCsvText(rows));
    expect(back).toHaveLength(1); // 行没有被撕裂
    expect(back[0]["作品名称"]).toBe("标题第一行 标题第二行");
    expect(back[0]["播放量"]).toBe("12345");
    expect(back[0]["完播率"]).toBe("0.35 后缀");
    expect(back[0]["点赞量"]).toBe("500"); // 所有指标列对齐无错位
  });

  it("sanitizes bare \\r too (转义检查只看 \\n 会漏)", () => {
    const back = parseCsv(rowsToCsvText([{ a: "left\rright", b: "ok" }]));
    expect(back).toHaveLength(1);
    expect(back[0]["a"]).toBe("left right");
    expect(back[0]["b"]).toBe("ok");
  });

  it("round-trips Chinese header names and emoji values", () => {
    const rows = [{ 作品名称: "测试🔥", 播放量: "1万" }];
    const csv = rowsToCsvText(rows);
    const back = parseCsv(csv);
    expect(back[0]["作品名称"]).toBe("测试🔥");
    expect(back[0]["播放量"]).toBe("1万");
  });
});

// ─── handleBridgeMessage ─────────────────────────────────────────────────────

describe("handleBridgeMessage — ping", () => {
  it("returns pong", async () => {
    const resp = await handleBridgeMessage({ type: "ping" });
    expect(resp).toEqual({ ok: true, type: "pong" });
  });
});

describe("handleBridgeMessage — ingest_rows", () => {
  // Real douyin column names from PLATFORM_MAPPINGS
  const douyinRow: Record<string, string> = {
    作品名称: "如何护肤5个技巧",
    发布时间: "2026-06-01 10:00",
    播放量: "12345",
    完播率: "0.35",
    "5s完播率": "0.55",
    点赞量: "500",
    评论量: "80",
    分享量: "30",
    收藏量: "120",
    粉丝增量: "50",
  };

  it("imports douyin rows into a real temp dataDir and journals them", async () => {
    const msg: BridgeMessage = {
      type: "ingest_rows",
      platform: "douyin",
      rows: [douyinRow],
    };
    const resp = await handleBridgeMessage(msg, testDir);
    expect(resp.ok).toBe(true);
    expect(resp.type).toBe("ingest_result");

    const outcomes = await listOutcomes(testDir);
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    const o = outcomes[0];
    expect(o.platform).toBe("douyin");
    expect(o.platformTitle).toBe("如何护肤5个技巧");
    expect(o.metrics.views).toBe(12345);
  });

  it("returns ImportReport data with imported count", async () => {
    const msg: BridgeMessage = {
      type: "ingest_rows",
      platform: "douyin",
      rows: [douyinRow, { ...douyinRow, 作品名称: "第二个视频", 播放量: "9999" }],
    };
    const resp = await handleBridgeMessage(msg, testDir);
    expect(resp.ok).toBe(true);
    const report = resp.data as { total: number; imported: number };
    expect(report.total).toBe(2);
    expect(report.imported).toBe(2);
  });

  it("uses localDateStamp as metricDate when no 数据日期 column present", async () => {
    const msg: BridgeMessage = {
      type: "ingest_rows",
      platform: "douyin",
      rows: [douyinRow], // no 数据日期
    };
    await handleBridgeMessage(msg, testDir);
    const outcomes = await listOutcomes(testDir);
    // metricDate should be YYYY-MM-DD today's format
    expect(outcomes[0].metricDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rejects unknown platform with error listing valid values", async () => {
    const msg: BridgeMessage = {
      type: "ingest_rows",
      platform: "unknown_platform",
      rows: [{ a: "1" }],
    };
    const resp = await handleBridgeMessage(msg, testDir);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/unknown_platform/);
    // Should list valid platforms
    expect(resp.error).toMatch(/douyin/);
  });

  it("rejects empty rows array", async () => {
    const msg: BridgeMessage = {
      type: "ingest_rows",
      platform: "douyin",
      rows: [],
    };
    const resp = await handleBridgeMessage(msg, testDir);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/空/);
  });

  it("passes through importPerformanceCsv errors as ok:false", async () => {
    // Force an error by sending platform not in PLATFORM_MAPPINGS
    const msg: BridgeMessage = {
      type: "ingest_rows",
      platform: "nonexistent",
      rows: [{ x: "y" }],
    };
    const resp = await handleBridgeMessage(msg, testDir);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBeTruthy();
  });
});
