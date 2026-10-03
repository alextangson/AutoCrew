/** 一次性回填脚本 scripts/backfill-bindings-20261003.mts：dry-run 不写、截坏 id 整体停、apply 先备份且幂等 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planBackfill, applyBackfill, DRAFT_BINDINGS, HISTORY } from "../../scripts/backfill-bindings-20261003.mjs";
import { listContents } from "./local-store.js";
import { listOutcomes } from "../modules/flywheel/outcome-store.js";
import { readPlatformItems } from "../modules/flywheel/platform-items.js";

let dir: string;
let backups: string;

const ids = new Map<string, string>();
let seq = 100;
function idFor(platform: string, key: string): string {
  const k = `${platform}|${key}`;
  if (!ids.has(k)) ids.set(k, platform === "douyin" ? `76900000000000${seq++}11` : `${platform}-item-${seq++}`);
  return ids.get(k)!;
}

async function seed(truncateFirstDouyin = false) {
  await fs.mkdir(path.join(dir, "contents"), { recursive: true });
  for (const d of DRAFT_BINDINGS) {
    const id = `content-1790000000000-${d.suffix}`;
    await fs.mkdir(path.join(dir, "contents", id), { recursive: true });
    await fs.writeFile(path.join(dir, "contents", id, "meta.json"), JSON.stringify({
      id, title: d.label, body: "正文", platform: "douyin", status: "published", tags: [], siblings: [], hashtags: [],
      publishedAt: "2026-10-02T10:00:00.000Z", publishUrl: null, performanceData: {}, assets: [], versions: [],
      createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z",
    }));
  }
  const rows = [...DRAFT_BINDINGS.flatMap((d) => d.items), ...HISTORY.flatMap((h) => h.items)].map((s, i) => {
    let itemId = idFor(s.platform, `${s.date}|${s.title}`);
    if (truncateFirstDouyin && i === 0) itemId = "7690860367378927000";
    return JSON.stringify({ contentId: null, platform: s.platform, platformTitle: s.title, publishedAt: `${s.date || "2026-10-03"}T10:00:00+08:00`,
      metricDate: "2026-10-03", platformItemId: itemId, metrics: { views: 10 + i }, source: "auto", recordedAt: "2026-10-03T08:00:00.000Z", needsReview: false, reviewReasons: [] });
  });
  await fs.writeFile(path.join(dir, "outcomes.jsonl"), rows.join("\n") + "\n");
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-backfill-1003-"));
  backups = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-backfill-1003-bak-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(backups, { recursive: true, force: true });
});

describe("backfill-bindings-20261003", () => {
  it("dry-run 只算计划不写盘：7 个绑定 + 10 条将新建的历史记录", async () => {
    await seed();
    const before = await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8");
    const plan = await planBackfill(dir);
    expect(plan.problems).toEqual([]);
    expect(plan.drafts.flatMap((d) => d.items)).toHaveLength(7);
    expect(plan.history).toHaveLength(10);
    expect(plan.history.every((h) => h.existingId === null)).toBe(true);
    expect(await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8")).toBe(before);
    await expect(fs.stat(path.join(dir, "platform-items.json"))).rejects.toThrow();
  });

  it("抖音只找到截坏 id → 报「先跑一次抖音回流」，apply 一行都不写", async () => {
    await seed(true);
    const plan = await planBackfill(dir);
    expect(plan.problems.join("\n")).toContain("需要先跑一次抖音回流");
    await expect(applyBackfill(plan, dir, backups)).rejects.toThrow("没有写入");
    expect(await readPlatformItems(dir)).toEqual({});
    expect(await fs.readdir(backups)).toEqual([]);
  });

  it("apply 先备份再写；19 位抖音 id 原样登记；重跑幂等", async () => {
    await seed();
    const { backup } = await applyBackfill(await planBackfill(dir), dir, backups);
    expect((await fs.readdir(backup)).sort()).toEqual(["outcomes.jsonl", "platform-items.json.absent", "project-layout.json.absent", "project-registry.json.absent"]);
    const items = await readPlatformItems(dir);
    expect(Object.keys(items)).toHaveLength(7 + HISTORY.reduce((n, h) => n + h.items.length, 0));
    expect(Object.values(items).every((b) => b.via === "manual")).toBe(true);
    const dy = idFor("douyin", "2026-10-02|深度思考开到max，AI反而更容易跑偏");
    expect(items[`douyin:${dy}`].contentId).toBe("content-1790000000000-j2v9ag");
    expect((await listContents(dir)).filter((c) => c.source === "imported_history")).toHaveLength(10);
    expect((await listOutcomes(dir)).every((o) => o.contentId !== null)).toBe(true);
    const journal = (await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8")).length;

    const again = await planBackfill(dir);
    expect(again.problems).toEqual([]);
    expect([...again.drafts.flatMap((d) => d.items), ...again.history.flatMap((h) => h.items)].every((i) => i.status === "already")).toBe(true);
    expect(again.history.every((h) => h.existingId)).toBe(true);
    await applyBackfill(again, dir, backups);
    expect((await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8")).length).toBe(journal);
    expect((await listContents(dir)).filter((c) => c.source === "imported_history")).toHaveLength(10);
  });
});
