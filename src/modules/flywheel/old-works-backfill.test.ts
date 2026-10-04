/**
 * scripts/backfill-old-works-20261004.mts 的验收清单（规格「边界情况」逐条）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHistoryRecord } from "./work-binding.js";
import { appendOutcomes, listOutcomes } from "./outcome-store.js";
import { claimWorkByTitle } from "./work-claims.js";
import type { PerformanceOutcome } from "./outcome-schema.js";
import { listContents } from "../../storage/local-store.js";
import { isImportedHistory } from "../../storage/imported-history.js";
import { RECORDS, planOldWorks, applyOldWorks, describePlan } from "../../../scripts/backfill-old-works-20261004.mjs";

let root: string;
let dir: string;
let nas: string;
let backups: string;

const pub = (date: string) => `${date}T12:00:00+08:00`;
const row = (platform: string, date: string, title: string, itemId?: string): PerformanceOutcome => ({
  contentId: null, platform, platformTitle: `${title}（完整标题）`, publishedAt: pub(date), metricDate: "2026-09-26",
  ...(itemId ? { platformItemId: itemId } : {}), metrics: { views: 10 }, source: "csv",
  recordedAt: "2026-09-26T08:00:00.000Z", needsReview: false, reviewReasons: [],
});

/** 造一个和线上同形的小资料库：每条表项一组行；已有的 7 条历史记录先建好；NAS 放 6 篇旧稿 */
async function seed() {
  const rows: PerformanceOutcome[] = [];
  let n = 0;
  for (const r of RECORDS) {
    for (const s of r.idItems) rows.push(row(s.platform, s.date, s.title, s.platform === "xiaohongshu" ? `6a8d97cf00000000080123${String(n++).padStart(2, "0")}` : `export/id-${n++}`));
    for (const s of r.claims) rows.push(row(s.platform, s.date, s.title));
  }
  await appendOutcomes(rows, dir);
  let dy = 11;
  for (const r of RECORDS.filter((x) => !x.create)) {
    const c = await createHistoryRecord({ title: r.title, published_date: r.date, items: [{ platform: "douyin", item_id: `76816455490234975${dy++}` }] }, dir);
    if (!c.ok) throw new Error(c.error);
  }
  for (const r of RECORDS) {
    if (!r.archive) continue;
    const d = path.join(nas, `content-1787000000000-${r.archive.oldId}`);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, "draft.md"), `旧稿 ${r.archive.oldId} 正文`);
    await fs.writeFile(path.join(d, "meta.json"), JSON.stringify({ title: `旧标题 ${r.archive.oldId}` }));
  }
}

const snapshot = async (d: string) => {
  const out: Record<string, string> = {};
  for (const f of await fs.readdir(d, { recursive: true })) {
    const p = path.join(d, String(f));
    if ((await fs.stat(p)).isFile()) out[String(f)] = await fs.readFile(p, "utf8");
  }
  return out;
};

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-oldworks-")));
  dir = path.join(root, "data"); nas = path.join(root, "nas"); backups = path.join(root, "backup");
  await fs.mkdir(dir); await fs.mkdir(nas);
});
afterEach(async () => {
  await fs.chmod(nas, 0o755).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("回填脚本验收", () => {
  it("正常路径：建 3 条 8 月记录（四平台）、认领全部无编号行、挂 6 篇存档原稿（09-11 标推断）", async () => {
    await seed();
    const plan = await planOldWorks(dir, nas);
    expect(plan.problems).toEqual([]);
    await applyOldWorks(plan, dir, backups);
    const history = (await listContents(dir)).filter(isImportedHistory);
    expect(history).toHaveLength(10);
    expect(history.filter((c) => c.archiveDraft).map((c) => c.archiveDraft!.oldContentId).sort()).toEqual(["18yfm1", "1v12vp", "acguqh", "b45gxi", "n36s7w", "pjv94o"]);
    expect(history.find((c) => c.archiveDraft?.oldContentId === "b45gxi")?.archiveDraft?.inferred).toBe(true);
    expect(history.filter((c) => c.archiveDraft?.inferred).length).toBe(1);
    expect(history.every((c) => c.body === "")).toBe(true);
    const visible = await listOutcomes(dir);
    expect(visible.filter((o) => o.contentId === null)).toEqual([]);
    const aug22 = history.find((c) => c.title === "一起搞懂Agent Harness")!;
    expect(new Set(visible.filter((o) => o.contentId === aug22.id).map((o) => o.platform))).toEqual(new Set(["douyin", "wechat_video", "xiaohongshu", "bilibili"]));
  });

  it("边界：NAS 没挂载 → 停下说明，什么都不写", async () => {
    await seed();
    const before = await snapshot(dir);
    const plan = await planOldWorks(dir, path.join(root, "not-mounted"));
    expect(plan.problems[0]).toContain("没挂载");
    expect(describePlan(plan)).toContain("没挂载");
    await expect(applyOldWorks(plan, dir, backups)).rejects.toThrow(/没有写入/);
    expect(await snapshot(dir)).toEqual(before);
    await expect(fs.access(backups)).rejects.toThrow();
  });

  it("边界：旧稿 draft.md 缺失或为空 → 该条不挂、列出来，其余照做", async () => {
    await seed();
    await fs.rm(path.join(nas, "content-1787000000000-18yfm1", "draft.md"));
    await fs.writeFile(path.join(nas, "content-1787000000000-pjv94o", "draft.md"), "\n");
    const plan = await planOldWorks(dir, nas);
    expect(plan.problems).toEqual([]);
    const text = describePlan(plan);
    expect(text).toMatch(/不挂原稿、其余照做（2）/);
    expect(text).toContain("18yfm1");
    await applyOldWorks(plan, dir, backups);
    const attached = (await listContents(dir)).filter((c) => c.archiveDraft).map((c) => c.archiveDraft!.oldContentId).sort();
    expect(attached).toEqual(["1v12vp", "acguqh", "b45gxi", "n36s7w"]);
    expect((await listOutcomes(dir)).filter((o) => o.contentId === null)).toEqual([]);
  });

  it("边界：只读复制——NAS 目录设成只读也能跑完，文件一字不变", async () => {
    await seed();
    const before = await snapshot(nas);
    for (const d of await fs.readdir(nas)) await fs.chmod(path.join(nas, d), 0o555);
    await fs.chmod(nas, 0o555);
    await applyOldWorks(await planOldWorks(dir, nas), dir, backups);
    await fs.chmod(nas, 0o755);
    for (const d of await fs.readdir(nas)) await fs.chmod(path.join(nas, d), 0o755);
    expect(await snapshot(nas)).toEqual(before);
  });

  it("边界：无编号行已归属别的稿 → 计划报出现有归属，一行不写", async () => {
    await seed();
    const other = (await listContents(dir)).find((c) => c.title.startsWith("别再收藏"))!;
    const claimed = await claimWorkByTitle(other.id, "bilibili", "什么时候该用 Jev（完整标题）", "2026-09-24", dir);
    expect(claimed.ok).toBe(true);
    const before = await snapshot(dir);
    const plan = await planOldWorks(dir, nas);
    expect(plan.problems.some((p) => p.includes("什么时候该用 Jev") && p.includes(other.id))).toBe(true);
    await expect(applyOldWorks(plan, dir, backups)).rejects.toThrow(/没有写入/);
    expect(await snapshot(dir)).toEqual(before);
  });

  it("边界：重复执行幂等——第二次全是 already，不建新记录、不追加行", async () => {
    await seed();
    await applyOldWorks(await planOldWorks(dir, nas), dir, backups);
    const lines = (await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8")).split("\n").length;
    const plan2 = await planOldWorks(dir, nas);
    expect(plan2.problems).toEqual([]);
    const items = plan2.records.flatMap((r) => [...r.ids, ...r.claims]);
    expect(items.every((i) => i.status === "already")).toBe(true);
    expect(plan2.records.flatMap((r) => (r.archive ? [r.archive.status] : [])).every((s) => s === "already")).toBe(true);
    const { log } = await applyOldWorks(plan2, dir, backups);
    expect(log.filter((l) => l.startsWith("历史")).every((l) => l.includes("」exists "))).toBe(true);
    expect((await listContents(dir)).filter(isImportedHistory)).toHaveLength(10);
    expect((await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8")).split("\n").length).toBe(lines);
  });
});
