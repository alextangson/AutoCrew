/**
 * 无编号行人工认领（老作品补齐规格 2026-10-04 ①）+ 存档原稿守卫（②）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHistoryRecord, deleteHistoryRecord } from "./work-binding.js";
import { claimWorkByTitle, readClaimsStrict } from "./work-claims.js";
import { attachArchiveDraft, readArchiveSource } from "./archive-draft.js";
import { appendOutcomes, listOutcomes } from "./outcome-store.js";
import { importPerformanceRows } from "./row-import.js";
import type { PerformanceOutcome } from "./outcome-schema.js";
import { getContent, saveContent } from "../../storage/local-store.js";
import { executeInsights } from "../../tools/insights.js";
import { executeWriter } from "../../tools/writer.js";
import { executeReviewDesk } from "../../tools/host-review.js";
import { executeContentSave } from "../../tools/content-save.js";
import { HISTORY_REFUSAL } from "../../storage/imported-history.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

const PUB = "2026-09-24T04:00:00.000Z"; // 北京 09-24
const TITLE = "什么时候该用 Jev，什么时候该用大模型";

let dir: string;
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-claims-"))); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const row = (over: Partial<PerformanceOutcome> = {}): PerformanceOutcome => ({
  contentId: null, platform: "bilibili", platformTitle: TITLE, publishedAt: PUB, metricDate: "2026-09-24",
  metrics: { views: 120 }, source: "csv", recordedAt: "2026-09-24T08:00:00.000Z", needsReview: false, reviewReasons: [], ...over,
});

async function history(title = "Jev 什么时候用", date = "2026-09-24", itemId = "7681645549023497523") {
  const r = await createHistoryRecord({ title, published_date: date, items: [{ platform: "douyin", item_id: itemId }] }, dir);
  if (!r.ok) throw new Error(r.error);
  return r.contentId;
}
const journalLines = async () => (await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8")).trim().split("\n").length;
const bili = async () => (await listOutcomes(dir)).filter((o) => o.platform === "bilibili");

describe("① 无编号行人工认领", () => {
  it("按 平台+标题+北京发布日 认领整组（各数据日期补一条，旧行不改）", async () => {
    const id = await history();
    await appendOutcomes([row({ metricDate: "2026-09-20" }), row()], dir);
    const r = await claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir);
    expect(r).toMatchObject({ ok: true, status: "claimed", copied: 2 });
    expect((await bili()).map((o) => o.contentId)).toEqual([id, id]);
    expect(await journalLines()).toBe(4);
    expect(Object.values(await readClaimsStrict(dir))[0]).toMatchObject({ contentId: id, via: "manual_claim" });
  });

  it("边界：同一「标题@日期」已归属别的稿 → 拒绝，报出现有归属，一行不写", async () => {
    const a = await history("稿 A", "2026-09-24", "7681645549023497523");
    const b = await history("稿 B", "2026-09-25", "7681645549023497524");
    await appendOutcomes([row()], dir);
    expect((await claimWorkByTitle(a, "bilibili", TITLE, "2026-09-24", dir)).ok).toBe(true);
    const before = await journalLines();
    const r = await claimWorkByTitle(b, "bilibili", TITLE, "2026-09-24", dir);
    expect(r).toMatchObject({ ok: false, existing: { contentId: a } });
    if (!r.ok) expect(r.error).toContain(a);
    expect(await journalLines()).toBe(before);
    // 行上已归属（不经认领表，比如按标题猜到的）也拒
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "普通稿", body: "x", platform: "bilibili", status: "published", tags: [] }, dir);
    await appendOutcomes([row({ platformTitle: "另一条", contentId: c.id })], dir);
    expect(await claimWorkByTitle(a, "bilibili", "另一条", "2026-09-24", dir)).toMatchObject({ ok: false, existing: { contentId: c.id } });
  });

  it("边界：重复执行 → already，不重复追加", async () => {
    const id = await history();
    await appendOutcomes([row()], dir);
    await claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir);
    const n = await journalLines();
    expect(await claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir)).toMatchObject({ ok: true, status: "already", copied: 0 });
    expect(await journalLines()).toBe(n);
  });

  it("找不到行 / 这组带作品 id / 参数不对 → 拒绝并说清", async () => {
    const id = await history();
    await appendOutcomes([row({ platform: "xiaohongshu", platformItemId: "6a95945b000000002901537b" })], dir);
    expect(await claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir)).toMatchObject({ ok: false, error: expect.stringContaining("没找到") });
    expect(await claimWorkByTitle(id, "xhs", TITLE, "2026-09-24", dir)).toMatchObject({ ok: false, error: expect.stringContaining("work_bind") });
    expect(await claimWorkByTitle(id, "tiktok", TITLE, "2026-09-24", dir)).toMatchObject({ ok: false, error: expect.stringContaining("不认识") });
    expect(await claimWorkByTitle(id, "bilibili", " ", "2026-09-24", dir)).toMatchObject({ ok: false, error: expect.stringContaining("标题") });
    expect(await claimWorkByTitle(id, "bilibili", TITLE, "9-24", dir)).toMatchObject({ ok: false, error: expect.stringContaining("YYYY-MM-DD") });
    expect(await claimWorkByTitle("content-1-nope00", "bilibili", TITLE, "2026-09-24", dir)).toMatchObject({ ok: false, error: expect.stringContaining("不存在") });
  });

  it("认领后同组新快照入账直接认到这篇（不被旧归属行藏掉）", async () => {
    const id = await history();
    await appendOutcomes([row()], dir);
    await claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir);
    await importPerformanceRows("bilibili", [{ title: TITLE, publishedAt: PUB, metrics: { views: 999 } }], { source: "csv", metricDate: "2026-10-01", dataDir: dir });
    const rows = await bili();
    expect(rows.map((o) => [o.contentId, o.metricDate]).sort()).toEqual([[id, "2026-09-24"], [id, "2026-10-01"]]);
  });

  it("边界：删历史记录 → 撤销认领，行回到未归属；之后入账不再认回去", async () => {
    const id = await history();
    await appendOutcomes([row()], dir);
    await claimWorkByTitle(id, "bilibili", TITLE, "2026-09-24", dir);
    const del = await deleteHistoryRecord(id, dir);
    expect(del).toMatchObject({ ok: true });
    if (del.ok) expect(del.removedBindings.some((k) => k.startsWith("认领 bilibili:"))).toBe(true);
    expect(await readClaimsStrict(dir)).toEqual({});
    expect((await bili()).map((o) => o.contentId)).toEqual([null]);
    await importPerformanceRows("bilibili", [{ title: TITLE, publishedAt: PUB, metrics: { views: 5 } }], { source: "csv", metricDate: "2026-10-01", dataDir: dir });
    expect((await bili()).every((o) => o.contentId === null)).toBe(true);
  });

  it("经 autocrew_insights work_claim 调用（work 被串成 JSON 字符串也照收）", async () => {
    const id = await history();
    await appendOutcomes([row()], dir);
    const r = await executeInsights({ action: "work_claim", work: JSON.stringify({ content_id: id, platform: "bilibili", title: TITLE, published_date: "2026-09-24" }), _dataDir: dir } as never);
    expect(r).toMatchObject({ ok: true, status: "claimed" });
  });
});

describe("② 存档原稿：只读查看，不进生产", () => {
  async function oldDraft(body = "# 旧稿正文\n第一段。") {
    const src = path.join(dir, "nas", "content-1787480815607-18yfm1");
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, "draft.md"), body);
    await fs.writeFile(path.join(src, "meta.json"), JSON.stringify({ title: "旧标题" }));
    return src;
  }

  it("挂上后记录来源路径 / 旧稿 id / 推断标记；body 仍为空；重复挂 already，换一篇拒绝", async () => {
    const id = await history();
    const src = await oldDraft();
    const s = { dir: src, oldId: "18yfm1", inferred: true };
    expect(await attachArchiveDraft(id, s, await readArchiveSource(s), dir)).toMatchObject({ ok: true, status: "attached" });
    const c = await getContent(id, dir);
    expect(c?.body).toBe("");
    expect(c?.archiveDraft).toMatchObject({ body: "# 旧稿正文\n第一段。", sourcePath: path.join(src, "draft.md"), oldContentId: "18yfm1", oldTitle: "旧标题", inferred: true });
    expect(await attachArchiveDraft(id, s, await readArchiveSource(s), dir)).toMatchObject({ ok: true, status: "already" });
    expect(await attachArchiveDraft(id, { ...s, oldId: "acguqh" }, await readArchiveSource(s), dir)).toMatchObject({ ok: false, error: expect.stringContaining("不覆盖") });
  });

  it("边界：draft.md 缺失 / 为空 / 文件夹不是这篇旧稿 → 不挂并说明", async () => {
    const src = await oldDraft("  \n");
    expect(await readArchiveSource({ dir: src, oldId: "18yfm1", inferred: false })).toMatchObject({ ok: false, code: "draft_empty" });
    await fs.rm(path.join(src, "draft.md"));
    expect(await readArchiveSource({ dir: src, oldId: "18yfm1", inferred: false })).toMatchObject({ ok: false, code: "draft_missing" });
    expect(await readArchiveSource({ dir: src, oldId: "acguqh", inferred: false })).toMatchObject({ ok: false, code: "id_mismatch" });
  });

  it("只挂在历史记录上：普通稿拒绝", async () => {
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "普通稿", body: "x", platform: "douyin", status: "drafting", tags: [] }, dir);
    const src = await oldDraft();
    const s = { dir: src, oldId: "18yfm1", inferred: false };
    expect(await attachArchiveDraft(c.id, s, await readArchiveSource(s), dir)).toMatchObject({ ok: false, error: expect.stringContaining("imported_history") });
  });

  it("边界：挂了存档原稿的历史记录照样被写稿 / 审稿 / 改稿入口拒收，原稿进不了 body", async () => {
    const id = await history();
    const src = await oldDraft();
    const s = { dir: src, oldId: "18yfm1", inferred: false };
    await attachArchiveDraft(id, s, await readArchiveSource(s), dir);
    const refused = { ok: false, code: "imported_history", error: HISTORY_REFUSAL };
    expect(await executeWriter({ action: "pack", content_id: id, _dataDir: dir })).toMatchObject(refused);
    expect(await executeWriter({ action: "submit", content_id: id, title: "t", body: "# 旧稿正文\n第一段。", _dataDir: dir })).toMatchObject(refused);
    expect(await executeReviewDesk({ action: "pack", content_id: id, _dataDir: dir })).toMatchObject(refused);
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "update", id, body: "# 旧稿正文\n第一段。", _dataDir: dir } as never)).toMatchObject(refused);
    expect((await getContent(id, dir))?.body).toBe("");
  });
});
