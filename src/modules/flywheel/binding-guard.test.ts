/**
 * Codex 第二轮保留项（2026-10-03）：已有精确绑定的稿不被标题再挂第二条作品（归属转人工、指标照留）、
 * 改绑按跨归属最新快照、严格读拒绝坏条目。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindWorkManually, createHistoryRecord } from "./work-binding.js";
import { appendOutcomes, listOutcomes } from "./outcome-store.js";
import { importPerformanceRows } from "./row-import.js";
import { lookupPlatformItem } from "./platform-items.js";
import type { PerformanceOutcome } from "./outcome-schema.js";
import { reviewedRow } from "../insights/metric-review.js";
import { saveContent } from "../../storage/local-store.js";

const TITLE = "AI给自己造了个身体，接管了我家的全屋智能";
const A_ID = "7686140658221976866";
const B_ID = "7685292405297286406";
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-binding-guard-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const row = (over: Partial<PerformanceOutcome>): PerformanceOutcome => ({
  contentId: null, platform: "douyin", platformTitle: TITLE, publishedAt: "2026-09-16T14:31:37.000Z", metricDate: "2026-10-03",
  platformItemId: A_ID, metrics: { views: 7629 }, source: "auto", recordedAt: "2026-10-03T08:00:00.000Z", needsReview: false, reviewReasons: [], ...over,
});

async function boundHistory() {
  const r = await createHistoryRecord({ title: TITLE, published_date: "2026-09-16", items: [{ platform: "douyin", item_id: A_ID }] }, dir);
  if (!r.ok) throw new Error(r.error);
  return r.contentId;
}

describe("已精确绑定的稿，同平台另一条作品不能靠标题挂上去", () => {
  it("另一条同标题作品：不归属、不登记绑定、转人工", async () => {
    const id = await boundHistory();
    await importPerformanceRows("douyin", [{ title: TITLE, publishedAt: "2026-09-17T02:00:00.000Z", platformItemId: B_ID, metrics: { views: 3, likes: 1 } }],
      { source: "auto", metricDate: "2026-10-04", dataDir: dir });
    expect(await lookupPlatformItem("douyin", B_ID, dir)).toBeNull();
    const b = (await listOutcomes(dir)).find((o) => o.platformItemId === B_ID)!;
    expect(b.contentId).toBeNull();
    expect(b.needsReview).toBe(true);
    expect(b.reviewReasons.join("")).toContain(`douyin:${A_ID}`);
    expect(id).toBeTruthy();
  });

  it("这条复核理由只关归属：指标级复核保留全部指标", async () => {
    await boundHistory();
    await importPerformanceRows("douyin", [{ title: TITLE, publishedAt: "2026-09-17T02:00:00.000Z", platformItemId: B_ID, metrics: { views: 3, likes: 1 } }],
      { source: "auto", metricDate: "2026-10-04", dataDir: dir });
    const b = (await listOutcomes(dir)).find((o) => o.platformItemId === B_ID)!;
    expect(b.needsReview).toBe(true);
    expect(reviewedRow(b)?.metrics).toEqual({ views: 3, likes: 1 });
  });

  it("人工绑定把这条作品认给某篇稿后，归属复核理由清掉", async () => {
    await boundHistory();
    const other = await saveContent({ title: "别的稿", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    await importPerformanceRows("douyin", [{ title: TITLE, publishedAt: "2026-09-17T02:00:00.000Z", platformItemId: B_ID, metrics: { views: 3 } }],
      { source: "auto", metricDate: "2026-10-04", dataDir: dir });
    expect(await bindWorkManually(other.id, "douyin", B_ID, dir)).toMatchObject({ ok: true, reattributed: 1 });
    const b = (await listOutcomes(dir)).find((o) => o.contentId === other.id)!;
    expect(b.needsReview).toBe(false);
    expect(b.reviewReasons).toEqual([]);
  });
});

describe("改绑时按跨归属的最新快照取值", () => {
  it("目标稿同数据日期有更旧的快照、原归属有更新的：改绑后保留更新的 7629", async () => {
    const a = await saveContent({ title: "A", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    const b = await saveContent({ title: "B", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    await appendOutcomes([
      row({ contentId: b.id, metrics: { views: 100 }, recordedAt: "2026-10-03T01:00:00.000Z" }),
      row({ contentId: a.id, metrics: { views: 7629 }, recordedAt: "2026-10-03T09:00:00.000Z" }),
    ], dir);
    expect(await bindWorkManually(b.id, "douyin", A_ID, dir)).toMatchObject({ ok: true });
    const v = await listOutcomes(dir);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ contentId: b.id, metrics: { views: 7629 } });
  });
});

describe("严格读：坏条目不被静默丢掉", () => {
  it.each([
    ["未知 via", { schemaVersion: 1, items: { "douyin:1": { contentId: "c", boundAt: "t", via: "bogus" } } }],
    ["items 是数组", { schemaVersion: 1, items: [] }],
    ["缺 contentId", { schemaVersion: 1, items: { "douyin:1": { boundAt: "t", via: "url" } } }],
  ])("%s → 人工绑定拒绝，文件原样", async (_n, file) => {
    const c = await saveContent({ title: "稿", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    const raw = JSON.stringify(file);
    await fs.writeFile(path.join(dir, "platform-items.json"), raw);
    expect(await bindWorkManually(c.id, "douyin", A_ID, dir)).toMatchObject({ ok: false, error: expect.stringContaining("platform-items.json") });
    expect(await fs.readFile(path.join(dir, "platform-items.json"), "utf8")).toBe(raw);
  });
});
