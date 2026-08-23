/**
 * binding.test.ts — 平台作品 id 绑定的裁决与自愈（spec §5.1）。
 *
 * 三条口径写死在这里：
 * 1. **绑定表 > matchDraft**：认对一次以后，标题被改也照样认得出；
 * 2. **只有硬证据才登记**：链接解析出的 id 相等（url）/ 归一化标题精确相等（title）；
 *    dice 模糊命中照常归属，但**不登记**——把猜测写进表会让错误自我固化；
 * 3. **冲突以绑定表为准 + needsReview**：系统不自动改判，把分歧摆到人面前。
 * 幂等键不动（spec §4.1 红线）：绑定只改归属，不改键的构成。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveItemBinding, recordOutcome, listOutcomes, listLatestOutcomes, diceSimilarity } from "./outcome-store.js";
import { importPerformanceRows } from "./row-import.js";
import { commitBindings, lookupPlatformItem, readPlatformItems } from "./platform-items.js";
import { saveContent, updateContent } from "../../storage/local-store.js";
import type { TypedRow } from "../../adapters/browser/pull-types.js";

const DY_ID = "7412345678901234567";
const PUB = "2026-06-01T10:00:00.000Z";
const DATE = "2026-06-08";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-binding-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function publish(title: string, over: { publishUrl?: string; publishedAt?: string } = {}) {
  const c = await saveContent({ title, body: "正文", platform: "douyin", status: "published", tags: [] }, dir);
  await updateContent(c.id, { publishedAt: over.publishedAt ?? PUB, publishUrl: over.publishUrl ?? null }, dir);
  return c;
}

const row = (over: Partial<TypedRow> = {}): TypedRow => ({
  title: "标题",
  publishedAt: PUB,
  metrics: { views: 100 },
  ...over,
});

const importRows = (rows: TypedRow[]) =>
  importPerformanceRows("douyin", rows, { source: "auto", metricDate: DATE, dataDir: dir });

describe("绑定优先级：映射表 > matchDraft", () => {
  it("行无 itemId → 老路照走（matchDraft 归属，不登记任何绑定）", async () => {
    const c = await publish("护肤五件事");
    const r = await resolveItemBinding({ platform: "douyin", platformTitle: "护肤五件事", publishedAt: PUB, dataDir: dir });
    expect(r.contentId).toBe(c.id);
    expect(r.pending).toBeNull();
    expect(await readPlatformItems(dir)).toEqual({});
  });

  it("映射表命中 → 直接用映射的 contentId，连标题都不用对", async () => {
    const c = await publish("原始标题");
    await commitBindings([{ platform: "douyin", itemId: DY_ID, contentId: c.id, via: "title" }], dir);

    const r = await resolveItemBinding({
      platform: "douyin",
      platformTitle: "作者后来改成了完全不同的标题",
      publishedAt: PUB,
      platformItemId: DY_ID,
      dataDir: dir,
    });
    expect(r.contentId).toBe(c.id);
    expect(r.reviewReasons).toEqual([]);
    expect(r.pending).toBeNull(); // 已绑定，不重复登记
  });

  it("平台别名不分叉：xhs 登记的绑定，xiaohongshu 的行照样命中", async () => {
    await commitBindings([{ platform: "xhs", itemId: "note-1", contentId: "c-xhs", via: "url" }], dir);
    const r = await resolveItemBinding({
      platform: "xiaohongshu",
      platformTitle: "随便什么标题",
      publishedAt: null,
      platformItemId: "note-1",
      dataDir: dir,
    });
    expect(r.contentId).toBe("c-xhs");
  });
});

describe("登记条件：硬证据才写表", () => {
  it("精确标题命中 → 登记 via title", async () => {
    const c = await publish("5个护肤技巧！");
    const report = await importRows([row({ title: "5个护肤技巧", platformItemId: DY_ID })]);

    expect(report.matched).toBe(1);
    const bound = await lookupPlatformItem("douyin", DY_ID, dir);
    expect(bound).toEqual({ contentId: c.id, boundAt: expect.any(String), via: "title" });
  });

  it("稿件 publishUrl 解析出的 id 与行内 id 相等 → 登记 via url（标题只是模糊像）", async () => {
    const draftTitle = "5个护肤技巧让你皮肤变好";
    const rowTitle = "5个护肤技巧让你皮肤变";
    expect(diceSimilarity(draftTitle, rowTitle)).toBeGreaterThanOrEqual(0.8); // 自校验：确实走的模糊命中
    const c = await publish(draftTitle, { publishUrl: `https://www.douyin.com/video/${DY_ID}` });

    await importRows([row({ title: rowTitle, publishedAt: null, platformItemId: DY_ID })]);
    expect(await lookupPlatformItem("douyin", DY_ID, dir)).toMatchObject({ contentId: c.id, via: "url" });
  });

  it("dice 模糊命中但没有链接佐证 → 照常归属，但**不登记**", async () => {
    const c = await publish("5个护肤技巧让你皮肤变好");
    const report = await importRows([row({ title: "5个护肤技巧让你皮肤变", publishedAt: null, platformItemId: DY_ID })]);

    expect(report.matched).toBe(1);
    expect((await listOutcomes(dir))[0].contentId).toBe(c.id);
    expect(await readPlatformItems(dir)).toEqual({}); // 猜出来的归属不进表
  });

  it("链接指向别的作品 id → 不算 url 证据（标题也不精确就完全不登记）", async () => {
    await publish("5个护肤技巧让你皮肤变好", { publishUrl: "https://www.douyin.com/video/9999999999999999999" });
    await importRows([row({ title: "5个护肤技巧让你皮肤变", publishedAt: null, platformItemId: DY_ID })]);
    expect(await readPlatformItems(dir)).toEqual({});
  });

  it("谁都没匹配上（历史行）→ 归属 null，不登记", async () => {
    await publish("完全无关的稿子");
    const report = await importRows([row({ title: "AutoCrew 诞生前的老视频", platformItemId: DY_ID })]);
    expect(report.historical).toBe(1);
    expect(await readPlatformItems(dir)).toEqual({});
  });
});

describe("自愈：认对一次，标题再改也不丢", () => {
  it("第一批按标题认亲登记，第二批标题被改仍归同一稿", async () => {
    const c = await publish("开箱这台新机器");
    await importRows([row({ title: "开箱这台新机器", platformItemId: DY_ID })]);

    const second = await importRows([
      row({ title: "【已改名】这台机器我用了三个月", metricDate: "2026-06-15", platformItemId: DY_ID }),
    ]);
    expect(second.matched).toBe(1);
    const latest = await listLatestOutcomes(dir);
    expect(latest.every((o) => o.contentId === c.id)).toBe(true);
  });

  it("先历史后绑定：同一作品不双计（幂等键不分叉的红线仍然成立）", async () => {
    const c = await publish("完全对不上的稿件标题");
    await importRows([row({ title: "老视频甲", platformItemId: DY_ID })]); // 无人认领 → historical
    await commitBindings([{ platform: "douyin", itemId: DY_ID, contentId: c.id, via: "url" }], dir);
    await importRows([row({ title: "老视频甲", platformItemId: DY_ID })]); // 这次归到 c

    expect((await listOutcomes(dir)).map((o) => o.contentId)).toEqual([c.id]); // 历史版本被对账吸收
    expect(await listLatestOutcomes(dir)).toHaveLength(1);
  });
});

describe("对账：冲突以映射表为准 + needsReview", () => {
  it("映射表指 A，matchDraft 精确命中 B → 归 A，并说清楚分歧在哪", async () => {
    const a = await publish("甲稿标题");
    const b = await publish("乙稿标题");
    await commitBindings([{ platform: "douyin", itemId: DY_ID, contentId: a.id, via: "url" }], dir);

    const report = await importRows([row({ title: "乙稿标题", platformItemId: DY_ID })]);
    const outcome = (await listOutcomes(dir))[0];

    expect(outcome.contentId).toBe(a.id);
    expect(outcome.needsReview).toBe(true);
    expect(outcome.reviewReasons.join()).toContain(a.id);
    expect(outcome.reviewReasons.join()).toContain(b.id);
    expect(report.needsReview).toHaveLength(1);
  });

  it("映射表与 matchDraft 一致 → 不打扰人", async () => {
    const c = await publish("同一稿");
    await commitBindings([{ platform: "douyin", itemId: DY_ID, contentId: c.id, via: "title" }], dir);
    await importRows([row({ title: "同一稿", platformItemId: DY_ID })]);
    expect((await listOutcomes(dir))[0].needsReview).toBe(false);
  });
});

describe("逐条 recordOutcome 走同一套绑定", () => {
  it("带 itemId 且标题精确对得上 → 登记绑定", async () => {
    const c = await publish("手动回填这篇");
    const r = await recordOutcome(
      {
        contentId: c.id,
        platform: "douyin",
        platformTitle: "手动回填这篇",
        publishedAt: PUB,
        metricDate: DATE,
        platformItemId: DY_ID,
        metrics: { views: 500 },
        source: "paste",
      },
      dir,
    );
    expect(r.ok).toBe(true);
    expect(await lookupPlatformItem("douyin", DY_ID, dir)).toMatchObject({ contentId: c.id, via: "title" });
  });

  it("传入的 contentId 与既有绑定冲突 → 以绑定为准 + needsReview", async () => {
    const a = await publish("甲稿");
    const b = await publish("乙稿");
    await commitBindings([{ platform: "douyin", itemId: DY_ID, contentId: a.id, via: "url" }], dir);

    const r = await recordOutcome(
      {
        contentId: b.id,
        platform: "douyin",
        platformTitle: "乙稿",
        publishedAt: PUB,
        metricDate: DATE,
        platformItemId: DY_ID,
        metrics: { views: 500 },
        source: "paste",
      },
      dir,
    );
    expect(r.outcome?.contentId).toBe(a.id);
    expect(r.outcome?.needsReview).toBe(true);
  });

  it("不带 itemId 的老调用一字不变（不多读盘、不改归属、不写表）", async () => {
    const c = await publish("老路径");
    const r = await recordOutcome(
      {
        contentId: c.id,
        platform: "douyin",
        platformTitle: "老路径",
        publishedAt: PUB,
        metricDate: DATE,
        metrics: { views: 10 },
        source: "paste",
      },
      dir,
    );
    expect(r.outcome?.contentId).toBe(c.id);
    expect(r.outcome?.needsReview).toBe(false);
    expect(await readPlatformItems(dir)).toEqual({});
  });
});
