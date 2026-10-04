/**
 * Codex 评审 feature/old-works-nas-backfill（2 P1 + 4 P2）的回归测试，每条对应一项。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHistoryRecord, deleteHistoryRecord } from "./work-binding.js";
import { claimWorkByTitle, readClaimsStrict } from "./work-claims.js";
import { appendOutcomes, listOutcomes } from "./outcome-store.js";
import { importPerformanceRows } from "./row-import.js";
import { commitBindings, lookupPlatformItem } from "./platform-items.js";
import type { PerformanceOutcome } from "./outcome-schema.js";
import { previewStorage } from "../../storage/library-manager.js";

const PUB = "2026-09-24T04:00:00.000Z";
const TITLE = "什么时候该用 Jev，什么时候该用大模型";
const BV = "BV1xx411c7mD";

let dir: string;
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-claims-review-"))); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const row = (over: Partial<PerformanceOutcome> = {}): PerformanceOutcome => ({
  contentId: null, platform: "bilibili", platformTitle: TITLE, publishedAt: PUB, metricDate: "2026-09-24",
  metrics: { views: 10 }, source: "csv", recordedAt: "2026-09-24T08:00:00.000Z", needsReview: false, reviewReasons: [], ...over,
});
async function history(title = "Jev 什么时候用", date = "2026-09-24", itemId = "7681645549023497523") {
  const r = await createHistoryRecord({ title, published_date: date, items: [{ platform: "douyin", item_id: itemId }] }, dir);
  if (!r.ok) throw new Error(r.error);
  return r.contentId;
}
const bili = async () => (await listOutcomes(dir)).filter((o) => o.platform === "bilibili");

describe("P1 认领过的无编号作品，后来的快照带着作品 id 进来", () => {
  it("按认领归属并登记 id 绑定，新数据不被旧快照藏掉", async () => {
    const id = await history();
    await appendOutcomes([row()], dir);
    await claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir);
    await importPerformanceRows("bilibili", [{ title: TITLE, publishedAt: PUB, platformItemId: BV, metrics: { views: 999 } }], { source: "auto", metricDate: "2026-10-01", dataDir: dir });
    expect((await bili()).find((o) => o.metricDate === "2026-10-01")).toMatchObject({ contentId: id, metrics: { views: 999 } });
    expect(await lookupPlatformItem("bilibili", BV, dir)).toMatchObject({ contentId: id, via: "manual" });
  });

  it("id 已绑给别的稿、和认领冲突 → 按绑定归属并标复核理由，不悄悄选一边", async () => {
    const id = await history();
    const other = await history("另一条", "2026-09-25", "7681645549023497524");
    await appendOutcomes([row()], dir);
    await claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir);
    await commitBindings([{ platform: "bilibili", itemId: BV, contentId: other, via: "manual" }], dir);
    const report = await importPerformanceRows("bilibili", [{ title: TITLE, publishedAt: PUB, platformItemId: BV, metrics: { views: 999 } }], { source: "auto", metricDate: "2026-10-01", dataDir: dir });
    expect(report.needsReview.length).toBe(1);
    expect(JSON.stringify(report.needsReview)).toContain(id);
    expect((await bili()).find((o) => o.metricDate === "2026-10-01")?.contentId).toBe(other);
  });
});

describe("P1 work_claim 与 history_delete 并发", () => {
  it("认领先发、删除后发：删完后不留认领、行回到未归属", async () => {
    const id = await history();
    await appendOutcomes([row()], dir);
    await Promise.all([claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir), deleteHistoryRecord(id, dir)]);
    expect(await readClaimsStrict(dir)).toEqual({});
    expect((await bili()).map((o) => o.contentId)).toEqual([null]);
  });

  it("删除先发、认领后发：认领在队列里重查发现记录已删 → 拒绝", async () => {
    const id = await history();
    await appendOutcomes([row()], dir);
    const [, claim] = await Promise.all([deleteHistoryRecord(id, dir), claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir)]);
    expect(claim.ok).toBe(false);
    expect(await readClaimsStrict(dir)).toEqual({});
    expect((await bili()).map((o) => o.contentId)).toEqual([null]);
  });
});

describe("P2 目标键已有旧的本稿快照、同日有更新的未归属快照", () => {
  it("用最新那条补上（999），不因目标键已存在就跳过", async () => {
    const id = await history();
    await appendOutcomes([row({ contentId: id, metrics: { views: 10 } }), row({ metrics: { views: 999 }, recordedAt: "2026-09-25T08:00:00.000Z" })], dir);
    const r = await claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir);
    expect(r).toMatchObject({ ok: true, copied: 1 });
    expect((await bili()).map((o) => o.metrics.views)).toEqual([999]);
  });
});

describe("P2 认领表坏了不能悄悄当成没认领", () => {
  it("入账报告里出现可见的归属错误", async () => {
    await fs.writeFile(path.join(dir, "work-claims.json"), "{broken");
    const report = await importPerformanceRows("bilibili", [{ title: TITLE, publishedAt: PUB, metrics: { views: 1 } }], { source: "csv", metricDate: "2026-10-01", dataDir: dir });
    expect(JSON.stringify(report.needsReview)).toContain("work-claims.json");
  });
});

describe("P2 资料库迁移带上认领表和绑定表", () => {
  it("work-claims.json / platform-items.json 不进「留在本机」清单", async () => {
    const local = path.join(dir, "machine");
    const ws = path.join(local);
    await fs.mkdir(ws, { recursive: true });
    vi.stubEnv("AUTOCREW_LOCAL_DIR", local);
    vi.stubEnv("AUTOCREW_DATA_DIR", "");
    await fs.writeFile(path.join(ws, "work-claims.json"), JSON.stringify({ schemaVersion: 1, claims: {} }));
    await fs.writeFile(path.join(ws, "platform-items.json"), JSON.stringify({ schemaVersion: 1, items: {} }));
    const plan = await previewStorage({ action: "migrate", target: path.join(dir, "NAS") });
    expect(plan.retained.filter((r) => r.includes("work-claims") || r.includes("platform-items"))).toEqual([]);
  });
});
