/** Codex 第四轮（2026-10-03）：补归属的目标键冲突、守卫留未绑定时撤回旧的猜测归属、确认时清归属复核理由 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindWorkManually, createHistoryRecord } from "./work-binding.js";
import { appendOutcomes, listOutcomes } from "./outcome-store.js";
import { importPerformanceRows } from "./row-import.js";
import { ATTRIBUTION_REVIEW_PREFIX, type PerformanceOutcome } from "./outcome-schema.js";
import { saveContent } from "../../storage/local-store.js";

const TITLE = "AI给自己造了个身体，接管了我家的全屋智能";
const A_ID = "7686140658221976866";
const B_ID = "7685292405297286406";
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-r4-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const row = (over: Partial<PerformanceOutcome>): PerformanceOutcome => ({
  contentId: null, platform: "douyin", platformTitle: TITLE, publishedAt: "2026-09-16T14:31:37.000Z", metricDate: "2026-10-03",
  platformItemId: A_ID, metrics: { views: 7629 }, source: "auto", recordedAt: "2026-10-03T08:00:00.000Z", needsReview: false, reviewReasons: [], ...over,
});
const draft = (title = "稿") => saveContent({ title, body: "b", platform: "douyin", status: "published", tags: [] }, dir);

describe("P1-1 目标键已有快照", () => {
  it("目标稿同日有更新的无 id 快照（手填）：不被旧的作品快照盖掉", async () => {
    const c = await draft();
    await appendOutcomes([
      row({ recordedAt: "2026-10-03T01:00:00.000Z", metrics: { views: 100 } }),
      row({ contentId: c.id, platformItemId: undefined, recordedAt: "2026-10-03T09:00:00.000Z", metrics: { views: 7629 }, source: "paste" }),
    ], dir);
    expect(await bindWorkManually(c.id, "douyin", A_ID, dir)).toMatchObject({ ok: true });
    expect((await listOutcomes(dir)).filter((o) => o.contentId === c.id).map((o) => o.metrics.views)).toEqual([7629]);
  });

  it("目标稿同日有无 id 的更旧快照：用作品的新快照", async () => {
    const c = await draft();
    await appendOutcomes([
      row({ contentId: c.id, platformItemId: undefined, recordedAt: "2026-10-03T01:00:00.000Z", metrics: { views: 100 }, source: "paste" }),
      row({ recordedAt: "2026-10-03T09:00:00.000Z", metrics: { views: 7629 } }),
    ], dir);
    expect(await bindWorkManually(c.id, "douyin", A_ID, dir)).toMatchObject({ ok: true });
    expect((await listOutcomes(dir)).filter((o) => o.contentId === c.id).map((o) => o.metrics.views)).toEqual([7629]);
  });

  it("目标键已是另一条作品的快照 → 不覆盖，回执报出来", async () => {
    const c = await draft();
    await appendOutcomes([
      row({ contentId: c.id, platformItemId: B_ID, metrics: { views: 5 }, recordedAt: "2026-10-03T01:00:00.000Z" }),
      row({ recordedAt: "2026-10-03T09:00:00.000Z" }),
    ], dir);
    const r = await bindWorkManually(c.id, "douyin", A_ID, dir);
    expect(r).toMatchObject({ ok: false, partial: true });
    expect(r.ok ? "" : r.error).toContain(B_ID);
    expect((await listOutcomes(dir)).find((o) => o.contentId === c.id)?.platformItemId).toBe(B_ID);
  });
});

describe("P1-2 守卫留未绑定时撤回旧的猜测归属", () => {
  it("B 先被标题猜到稿上，A 精确绑定后 B 的新快照可见、旧的猜测归属撤回", async () => {
    const c = await draft(TITLE);
    await appendOutcomes([row({ contentId: c.id, platformItemId: B_ID, metrics: { views: 100 }, metricDate: "2026-10-02", publishedAt: "2026-09-16T10:00:00.000Z" })], dir);
    expect(await bindWorkManually(c.id, "douyin", A_ID, dir)).toMatchObject({ ok: true });
    await importPerformanceRows("douyin", [{ title: TITLE, publishedAt: "2026-09-16T10:00:00.000Z", platformItemId: B_ID, metrics: { views: 3 } }],
      { source: "auto", metricDate: "2026-10-04", dataDir: dir });
    const b = (await listOutcomes(dir)).filter((o) => o.platformItemId === B_ID);
    expect(b.some((o) => o.contentId === c.id)).toBe(false);
    const fresh = b.find((o) => o.metricDate === "2026-10-04")!;
    expect(fresh).toMatchObject({ contentId: null, metrics: { views: 3 }, needsReview: true });
  });
});

describe("P2 已归属快照带着归属复核理由，人工确认时也清掉", () => {
  it("status already 时也把理由清掉（只在状态有变时追加）", async () => {
    const r = await createHistoryRecord({ title: TITLE, published_date: "2026-09-16", items: [{ platform: "douyin", item_id: A_ID }] }, dir);
    if (!r.ok) throw new Error(r.error);
    const reason = `${ATTRIBUTION_REVIEW_PREFIX}旧理由`;
    await appendOutcomes([row({ contentId: r.contentId, needsReview: true, reviewReasons: [reason], recordedAt: "2026-10-03T10:00:00.000Z" })], dir);
    expect(await bindWorkManually(r.contentId, "douyin", A_ID, dir)).toMatchObject({ ok: true, status: "already" });
    expect((await listOutcomes(dir)).find((o) => o.contentId === r.contentId)).toMatchObject({ needsReview: false, reviewReasons: [] });
    const lines = (await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8")).trim().split("\n").length;
    await bindWorkManually(r.contentId, "douyin", A_ID, dir);
    expect((await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8")).trim().split("\n").length).toBe(lines);
  });
});

describe("演练发现：绑定后不丢同一作品早期没带 id 的快照", () => {
  it("09-26 无 id 快照 + 10-03 带 id 快照，人工绑定后两天都在本稿名下", async () => {
    const c = await draft();
    await appendOutcomes([
      row({ platformItemId: undefined, metricDate: "2026-09-26", metrics: { views: 6811 } }),
      row({ metricDate: "2026-10-03", metrics: { views: 7629 } }),
    ], dir);
    expect(await bindWorkManually(c.id, "douyin", A_ID, dir)).toMatchObject({ ok: true, reattributed: 2 });
    const mine = (await listOutcomes(dir)).filter((o) => o.contentId === c.id).map((o) => [o.metricDate, o.metrics.views]).sort();
    expect(mine).toEqual([["2026-09-26", 6811], ["2026-10-03", 7629]]);
  });

  it("同标题同日有另一条带 id 的作品时，无 id 的快照有歧义，不挂", async () => {
    const c = await draft();
    await appendOutcomes([
      row({ platformItemId: undefined, metricDate: "2026-09-26", metrics: { views: 6811 } }),
      row({ metricDate: "2026-10-03" }),
      row({ platformItemId: B_ID, metricDate: "2026-10-02", metrics: { views: 0 } }),
    ], dir);
    expect(await bindWorkManually(c.id, "douyin", A_ID, dir)).toMatchObject({ ok: true, reattributed: 1 });
  });
});
