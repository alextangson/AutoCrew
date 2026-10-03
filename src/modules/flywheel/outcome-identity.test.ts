/**
 * Codex 第二轮（2026-10-03）：作品身份带上可信的平台作品 id——同平台同标题同日的两条不同作品永不合并。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindWorkManually, createHistoryRecord } from "./work-binding.js";
import { appendOutcomes, listOutcomes, listLatestOutcomes } from "./outcome-store.js";
import { importPerformanceRows } from "./row-import.js";
import { lookupPlatformItem } from "./platform-items.js";
import type { PerformanceOutcome } from "./outcome-schema.js";
import { saveContent } from "../../storage/local-store.js";

const TITLE = "AI给自己造了个身体，接管了我家的全屋智能";
const PRIV = "7685292405297286406";
const PUBL = "7686140658221976866";
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-identity-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const row = (over: Partial<PerformanceOutcome>): PerformanceOutcome => ({
  contentId: null, platform: "douyin", platformTitle: TITLE, publishedAt: "2026-09-16T10:00:00.000Z", metricDate: "2026-10-03",
  metrics: { views: 0 }, source: "auto", recordedAt: "2026-10-03T08:00:00.000Z", needsReview: false, reviewReasons: [], ...over,
});
const priv = (o: Partial<PerformanceOutcome> = {}) => row({ platformItemId: PRIV, publishedAt: "2026-09-16T10:00:00.000Z", metrics: { views: 0 }, ...o });
const publ = (o: Partial<PerformanceOutcome> = {}) => row({ platformItemId: PUBL, publishedAt: "2026-09-16T14:31:37.000Z", metrics: { views: 7629 }, ...o });

describe("同标题同日的两条不同作品不合并", () => {
  it.each([["公开在前", [publ(), priv()]], ["私密在前", [priv(), publ()]]])("%s：两条都在；绑公开那条只补公开的快照", async (_n, rows) => {
    await appendOutcomes(rows as PerformanceOutcome[], dir);
    expect((await listOutcomes(dir)).map((o) => o.platformItemId).sort()).toEqual([PRIV, PUBL].sort());
    const r = await createHistoryRecord({ title: TITLE, published_date: "2026-09-16", items: [{ platform: "douyin", item_id: PUBL }] }, dir);
    if (!r.ok) throw new Error(r.error);
    expect(r.bindings[0].reattributed).toBe(1);
    const v = await listOutcomes(dir);
    expect(v.find((o) => o.platformItemId === PUBL)).toMatchObject({ contentId: r.contentId, metrics: { views: 7629 } });
    expect(v.find((o) => o.platformItemId === PRIV)).toMatchObject({ contentId: null, metrics: { views: 0 } });
  });

  it("没有 id 的旧快照仍按标题@日期归到唯一那条带 id 的作品（不拆成两个作品）", async () => {
    await appendOutcomes([row({ platformItemId: undefined, metricDate: "2026-09-26", metrics: { views: 6811 }, publishedAt: "2026-09-16T14:31:37.000Z" }), publ()], dir);
    expect(await listLatestOutcomes(dir)).toHaveLength(1);
  });

  it("截坏 id 的旧行按无 id 处理：带正确 id 的新行同日覆盖它", async () => {
    await appendOutcomes([publ({ platformItemId: "7686140658221977000", metrics: { views: 1 } }), publ()], dir);
    const v = await listOutcomes(dir);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ platformItemId: PUBL, metrics: { views: 7629 } });
  });
});

describe("已有精确绑定的稿，同平台别的作品不能靠标题挂上去", () => {
  it("历史记录已人工绑了公开那条，下一次回流里同标题的私密那条留未绑定并转人工", async () => {
    const r = await createHistoryRecord({ title: TITLE, published_date: "2026-09-16", items: [{ platform: "douyin", item_id: PUBL }] }, dir);
    if (!r.ok) throw new Error(r.error);
    await importPerformanceRows("douyin", [
      { title: TITLE, publishedAt: "2026-09-16T14:31:37.000Z", platformItemId: PUBL, metrics: { views: 7700 } },
      { title: TITLE, publishedAt: "2026-09-16T10:00:00.000Z", platformItemId: PRIV, metrics: { views: 0 } },
    ], { source: "auto", metricDate: "2026-10-04", dataDir: dir });
    expect(await lookupPlatformItem("douyin", PRIV, dir)).toBeNull();
    const v = (await listOutcomes(dir)).filter((o) => o.metricDate === "2026-10-04");
    expect(v.find((o) => o.platformItemId === PUBL)).toMatchObject({ contentId: r.contentId, metrics: { views: 7700 } });
    const p = v.find((o) => o.platformItemId === PRIV)!;
    expect(p.contentId).toBeNull();
    expect(p.needsReview).toBe(true);
    expect(p.reviewReasons.join("")).toContain(PUBL);
  });
});

describe("改绑时按跨归属的最新快照取值", () => {
  it("目标稿同数据日期有更旧的快照、原归属有更新的：改绑后保留更新的 7629", async () => {
    const a = await saveContent({ title: "A", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    const b = await saveContent({ title: "B", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    await appendOutcomes([
      publ({ contentId: b.id, metrics: { views: 100 }, recordedAt: "2026-10-03T01:00:00.000Z" }),
      publ({ contentId: a.id, metrics: { views: 7629 }, recordedAt: "2026-10-03T09:00:00.000Z" }),
    ], dir);
    expect(await bindWorkManually(b.id, "douyin", PUBL, dir)).toMatchObject({ ok: true });
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
    expect(await bindWorkManually(c.id, "douyin", PUBL, dir)).toMatchObject({ ok: false, error: expect.stringContaining("platform-items.json") });
    expect(await fs.readFile(path.join(dir, "platform-items.json"), "utf8")).toBe(raw);
  });
});
