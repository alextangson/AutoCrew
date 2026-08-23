/**
 * row-import.test.ts — TypedRow 入库漏斗的批内语义（spec §4.1 写死的口径）：
 * 批内 last-wins / replaced 含批内覆盖 / 暴涨只对照批前存量 / 幂等键不含 platformItemId /
 * 行级 rejected 不连累同批 / 单次 append / 并发批次不互相覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPerformanceRows } from "./row-import.js";
import { listOutcomes, listLatestOutcomes, recordOutcome } from "./outcome-store.js";
import type { TypedRow } from "../../adapters/browser/pull-types.js";

const DATE = "2026-06-08";
const PUB = "2026-06-01T10:00:00.000Z";

let dirA: string;
let dirB: string;

beforeEach(async () => {
  dirA = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-rowimport-a-"));
  dirB = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-rowimport-b-"));
});

afterEach(async () => {
  for (const dir of [dirA, dirB]) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

const row = (over: Partial<TypedRow> = {}): TypedRow => ({
  title: "行A",
  publishedAt: PUB,
  metrics: { views: 100 },
  ...over,
});

const importInto = (dir: string, rows: TypedRow[], source: "csv" | "paste" | "auto" = "auto") =>
  importPerformanceRows("douyin", rows, { source, metricDate: DATE, dataDir: dir });

/** 建立 n 条同平台存量（views ≈ 1000），用于暴涨中位数 */
async function seedPeers(dir: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await recordOutcome(
      {
        contentId: `seed-${i}`,
        platform: "douyin",
        platformTitle: `种子${i}`,
        publishedAt: "2026-05-01T00:00:00.000Z",
        metricDate: "2026-06-01",
        metrics: { views: 1000 + i },
        source: "csv",
      },
      dir,
    );
  }
}

const find = async (dir: string, title: string) => (await listOutcomes(dir)).find((o) => o.platformTitle === title);

describe("批内 last-wins 与 replaced 口径", () => {
  it("同键后行覆盖前行；replaced 计入批内覆盖；journal 只 append 去重后的行", async () => {
    const report = await importInto(dirA, [
      row({ title: "同一条", metrics: { views: 100 } }),
      row({ title: "另一条", metrics: { views: 50 } }),
      row({ title: "同一条", metrics: { views: 300 } }),
    ]);

    expect(report.total).toBe(3);
    expect(report.imported).toBe(3);
    expect(report.replaced).toBe(1); // 批内覆盖算一次替换
    expect(report.historical).toBe(3);

    const outcomes = await listOutcomes(dirA);
    expect(outcomes).toHaveLength(2);
    expect((await find(dirA, "同一条"))?.metrics.views).toBe(300); // 后行赢

    const raw = await fs.readFile(path.join(dirA, "outcomes.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(2); // 单次 append，被覆盖的行根本不落盘
  });

  it("与批前存量同键 → replaced，且不新增作品数", async () => {
    await importInto(dirA, [row({ title: "老作品", metrics: { views: 100 } })]);
    const second = await importInto(dirA, [row({ title: "老作品", metrics: { views: 260 } })]);
    expect(second.replaced).toBe(1);
    expect(await listOutcomes(dirA)).toHaveLength(1);
    expect((await find(dirA, "老作品"))?.metrics.views).toBe(260);
  });
});

describe("暴涨检测只对照批前存量", () => {
  it("批内首行的判定与逐条 recordOutcome 完全一致", async () => {
    await seedPeers(dirA, 5);
    await seedPeers(dirB, 5);

    await importInto(dirA, [row({ title: "暴涨稿", metrics: { views: 100000 } }), row({ title: "跟随稿", metrics: { views: 900 } })]);
    const single = await recordOutcome(
      {
        contentId: null,
        platform: "douyin",
        platformTitle: "暴涨稿",
        publishedAt: PUB,
        metricDate: DATE,
        metrics: { views: 100000 },
        source: "auto",
      },
      dirB,
    );

    const batched = await find(dirA, "暴涨稿");
    expect(single.outcome?.needsReview).toBe(true); // 自校验：确实触发了暴涨
    expect(batched?.needsReview).toBe(single.outcome?.needsReview);
    expect(batched?.reviewReasons).toEqual(single.outcome?.reviewReasons);
  });

  it("批内新行不抬高基数：批前不足 5 条时整批都不判暴涨（逐条路径则会判）", async () => {
    await seedPeers(dirA, 4);
    await seedPeers(dirB, 4);
    const rows = [
      row({ title: "甲", metrics: { views: 1000 } }),
      row({ title: "乙", metrics: { views: 1000 } }),
      row({ title: "暴涨", metrics: { views: 999999 } }),
    ];

    await importInto(dirA, rows);
    expect((await find(dirA, "暴涨"))?.needsReview).toBe(false);

    // 同样三行走逐条路径：写到第三行时存量已 6 条，会被判暴涨——批量口径的差异是明示的
    for (const r of rows) {
      await recordOutcome(
        { contentId: null, platform: "douyin", platformTitle: r.title, publishedAt: PUB, metricDate: DATE, metrics: r.metrics, source: "auto" },
        dirB,
      );
    }
    expect((await find(dirB, "暴涨"))?.needsReview).toBe(true);
  });
});

describe("幂等键不分叉（platformItemId 只是属性）", () => {
  it("同一行带/不带 platformItemId 两次导入 → 一条生效，作品数不翻倍", async () => {
    const first = await importInto(dirA, [row({ title: "同一作品", platformItemId: "item-1", metrics: { views: 100 } })], "auto");
    expect(first.imported).toBe(1);
    expect((await find(dirA, "同一作品"))?.platformItemId).toBe("item-1");

    const second = await importInto(dirA, [row({ title: "同一作品", metrics: { views: 180 } })], "csv");
    expect(second.replaced).toBe(1);

    const outcomes = await listOutcomes(dirA);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].metrics.views).toBe(180); // latest-wins
    expect(await listLatestOutcomes(dirA)).toHaveLength(1); // flywheel 统计不翻倍
  });

  it("先无 id 后有 id 也是同一条（自动通道补 id 不会造出第二个作品）", async () => {
    await importInto(dirA, [row({ title: "补 id 作品", metrics: { views: 10 } })], "csv");
    const second = await importInto(dirA, [row({ title: "补 id 作品", platformItemId: "item-9", metrics: { views: 20 } })], "auto");
    expect(second.replaced).toBe(1);
    const outcomes = await listOutcomes(dirA);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].platformItemId).toBe("item-9");
    expect(outcomes[0].source).toBe("auto");
  });
});

describe("行级 rejected 不连累同批", () => {
  it("空标题/无指标/非法值单独拒收，合格行照常入库，行号可定位", async () => {
    const report = await importInto(dirA, [
      row({ title: "好行一", metrics: { views: 10 } }),
      row({ title: "  ", metrics: { views: 10 } }),
      row({ title: "无指标", metrics: {} }),
      row({ title: "好行二", metrics: { views: 20 } }),
      row({ title: "负播放", metrics: { views: -5 } }),
    ]);

    expect(report.imported).toBe(2);
    expect(report.rejected.map((r) => r.row)).toEqual([2, 3, 5]);
    expect(report.rejected[0].error).toContain("标题");
    expect(report.rejected[1].error).toContain("指标");
    expect(await listOutcomes(dirA)).toHaveLength(2);
  });

  it("整批全废 → 不写文件，也不抛", async () => {
    const report = await importInto(dirA, [row({ title: "", metrics: {} })]);
    expect(report.imported).toBe(0);
    expect(report.rejected).toHaveLength(1);
    await expect(fs.readFile(path.join(dirA, "outcomes.jsonl"), "utf-8")).rejects.toThrow();
  });
});

describe("impressions（曝光）", () => {
  it("落盘且与 views 分列", async () => {
    await importInto(dirA, [row({ title: "曝光稿", metrics: { views: 300, impressions: 9000 } })]);
    const o = await find(dirA, "曝光稿");
    expect(o?.metrics.impressions).toBe(9000);
    expect(o?.metrics.views).toBe(300);
  });

  it("小数曝光量 → 行级拒收（曝光是计数不是比率）", async () => {
    const report = await importInto(dirA, [row({ title: "坏曝光", metrics: { impressions: 1234.5 } })]);
    expect(report.imported).toBe(0);
    expect(report.rejected[0].error).toContain("曝光量");
  });

  it("只有曝光没有播放也算有效行", async () => {
    const report = await importInto(dirA, [row({ title: "只有曝光", metrics: { impressions: 500 } })]);
    expect(report.imported).toBe(1);
  });
});

describe("写队列（进程内并发）", () => {
  it("两批并发写同一 dataDir：行不丢，同键仍只算一次替换", async () => {
    const [a, b] = await Promise.all([
      importInto(dirA, [row({ title: "并发甲", metrics: { views: 1 } }), row({ title: "共有行", metrics: { views: 2 } })]),
      importInto(dirA, [row({ title: "并发乙", metrics: { views: 3 } }), row({ title: "共有行", metrics: { views: 4 } })]),
    ]);
    expect(a.imported + b.imported).toBe(4);
    expect(a.replaced + b.replaced).toBe(1); // 后入队的那批才看得见前一批的行
    const outcomes = await listOutcomes(dirA);
    expect(outcomes.map((o) => o.platformTitle).sort()).toEqual(["共有行", "并发乙", "并发甲"].sort());
  });
});

describe("行自带数据日期", () => {
  it("行上的 metricDate 覆盖批次默认值", async () => {
    await importInto(dirA, [row({ title: "自带日期", metricDate: "2026-06-20", metrics: { views: 10 } })]);
    expect((await find(dirA, "自带日期"))?.metricDate).toBe("2026-06-20");
  });
});
