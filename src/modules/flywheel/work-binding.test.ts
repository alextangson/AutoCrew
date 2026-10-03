/**
 * work-binding.test.ts — 回流认领规格 2026-10-03 的验收清单（边界情况逐条一个测试）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindWorkManually, createHistoryRecord, deleteHistoryRecord } from "./work-binding.js";
import { listOutcomes, appendOutcomes, matchDraft, resolveItemBinding } from "./outcome-store.js";
import { importPerformanceRows } from "./row-import.js";
import { lookupPlatformItem, readPlatformItems, commitBindings } from "./platform-items.js";
import { isTruncatedItemId, type PerformanceOutcome } from "./outcome-schema.js";
import { saveContent, updateContent, getContent, listContents, transitionStatus } from "../../storage/local-store.js";

const GOOD_DY = "7690860367378926899";
const TRUNC_DY = "7690860367378927000";
const SPH = "export/UzFfBgAAxNOOCG4_C1vak8zT4DCaEJZCSZTQPjalYTp7CXrAjA";
const PUB = "2026-10-02T10:00:00.000Z";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-work-binding-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

async function published(title: string, extra: Record<string, unknown> = {}) {
  const c = await saveContent({ title, body: "正文", platform: "douyin", status: "published", tags: [] }, dir);
  await updateContent(c.id, { publishedAt: PUB, ...extra }, dir);
  return c;
}

const row = (over: Partial<PerformanceOutcome> = {}): PerformanceOutcome => ({
  contentId: null, platform: "wechat_video", platformTitle: "深度思考开到max反而跑偏", publishedAt: PUB,
  metricDate: "2026-10-03", platformItemId: SPH, metrics: { views: 3154 }, source: "auto",
  recordedAt: "2026-10-03T08:00:00.000Z", needsReview: false, reviewReasons: [], ...over,
});

describe("③ 人工绑定", () => {
  it("登记 via=manual，并给已入账的同作品行按新归属各补一条（旧行不改）", async () => {
    const c = await published("深度思考开到 max");
    await appendOutcomes([row({ metricDate: "2026-10-02" }), row()], dir);
    const r = await bindWorkManually(c.id, "wechat_video", SPH, dir);
    expect(r).toMatchObject({ ok: true, status: "bound", reattributed: 2 });
    expect((await lookupPlatformItem("wechat_video", SPH, dir))?.via).toBe("manual");
    const visible = await listOutcomes(dir);
    expect(visible.map((o) => [o.contentId, o.metricDate]).sort()).toEqual([[c.id, "2026-10-02"], [c.id, "2026-10-03"]]);
    const journal = (await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8")).trim().split("\n");
    expect(journal).toHaveLength(4); // 2 原始 + 2 补行
  });

  it("边界：同一平台作品已绑定别的稿子 → 拒绝并报出现有归属，不覆盖", async () => {
    const a = await published("稿 A");
    const b = await published("稿 B");
    await commitBindings([{ platform: "wechat_video", itemId: SPH, contentId: a.id, via: "title" }], dir);
    const r = await bindWorkManually(b.id, "wechat_video", SPH, dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(a.id);
    expect(r.existing?.contentId).toBe(a.id);
    expect((await lookupPlatformItem("wechat_video", SPH, dir))?.contentId).toBe(a.id);
  });

  it("边界：稿子 id 不存在 / 平台不认识 / 作品 id 空 → 拒绝并说清哪项不对", async () => {
    const c = await published("稿");
    expect(await bindWorkManually("content-1-nope00", "douyin", GOOD_DY, dir)).toMatchObject({ ok: false, error: expect.stringContaining("稿子 id") });
    expect(await bindWorkManually(c.id, "tiktok", GOOD_DY, dir)).toMatchObject({ ok: false, error: expect.stringContaining("平台「tiktok」不认识") });
    expect(await bindWorkManually(c.id, "douyin", "  ", dir)).toMatchObject({ ok: false, error: expect.stringContaining("作品 id 是空的") });
    expect(await bindWorkManually(c.id, "douyin", 7690860367378926899, dir)).toMatchObject({ ok: false, error: expect.stringContaining("字符串") });
    expect(await readPlatformItems(dir)).toEqual({});
  });

  it("边界：重复执行同一绑定 → 幂等，不重复追加行", async () => {
    const c = await published("稿");
    await appendOutcomes([row()], dir);
    await bindWorkManually(c.id, "wechat_video", SPH, dir);
    const again = await bindWorkManually(c.id, "wechat_video", SPH, dir);
    expect(again).toMatchObject({ ok: true, status: "already", reattributed: 0 });
    const journal = (await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf8")).trim().split("\n");
    expect(journal).toHaveLength(2);
  });

  it("边界：截坏的抖音 id 不能拿来绑定；正确 19 位 id 原样登记", async () => {
    const c = await published("稿");
    expect(isTruncatedItemId("douyin", TRUNC_DY)).toBe(true);
    expect(isTruncatedItemId("douyin", GOOD_DY)).toBe(false);
    expect(await bindWorkManually(c.id, "douyin", TRUNC_DY, dir)).toMatchObject({ ok: false, error: expect.stringContaining("截坏") });
    expect(await bindWorkManually(c.id, "douyin", GOOD_DY, dir)).toMatchObject({ ok: true, itemId: GOOD_DY });
    expect(Object.keys(await readPlatformItems(dir))).toEqual([`douyin:${GOOD_DY}`]);
  });
});

describe("边界：截坏 id 的旧行不参与绑定", () => {
  it("带截坏 id 的行不查表、不登记；下次带正确 id 的行覆盖它", async () => {
    const c = await published("深度思考开到max，AI反而更容易跑偏");
    // 表里哪怕有一条（错误地）用截坏 id 登记的绑定，也不被采信
    await commitBindings([{ platform: "douyin", itemId: TRUNC_DY, contentId: "content-1-other0", via: "url" }], dir);
    const r = await resolveItemBinding({ platform: "douyin", platformTitle: c.title, publishedAt: PUB, platformItemId: TRUNC_DY, dataDir: dir });
    expect(r).toMatchObject({ contentId: c.id, pending: null, reviewReasons: [] });
    await importPerformanceRows("douyin", [{ title: c.title, publishedAt: PUB, platformItemId: TRUNC_DY, metrics: { views: 1 } }], { source: "auto", metricDate: "2026-10-03", dataDir: dir });
    expect(await lookupPlatformItem("douyin", TRUNC_DY, dir)).toMatchObject({ contentId: "content-1-other0" }); // 没有新登记
    await importPerformanceRows("douyin", [{ title: c.title, publishedAt: PUB, platformItemId: GOOD_DY, metrics: { views: 2 } }], { source: "auto", metricDate: "2026-10-03", dataDir: dir });
    expect((await lookupPlatformItem("douyin", GOOD_DY, dir))?.contentId).toBe(c.id);
    const latest = (await listOutcomes(dir)).filter((o) => o.platform === "douyin");
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ platformItemId: GOOD_DY, metrics: { views: 2 } });
  });
});

describe("② 认领放宽：候选含发布包平台，标题含各平台 post_title", () => {
  it("稿子登记成抖音，发布包是视频号 → 视频号的行按 post_title 精确认领并登记 title 绑定", async () => {
    const c = await published("thinking effort 开到 max");
    await updateContent(c.id, { videoKit: { platform: "wechat_video", postTitle: "深度思考开到max反而跑偏", caption: "", storyboard: [], coverText: "", coverPrompt: "", generatedAt: PUB } }, dir);
    expect((await matchDraft("wechat_video", "深度思考开到max反而跑偏", PUB, dir))?.id).toBe(c.id);
    await importPerformanceRows("wechat_video", [{ title: "深度思考开到max反而跑偏", publishedAt: PUB, platformItemId: SPH, metrics: { views: 3 } }], { source: "auto", metricDate: "2026-10-03", dataDir: dir });
    expect(await lookupPlatformItem("wechat_video", SPH, dir)).toMatchObject({ contentId: c.id, via: "title" });
  });

  it("边界：放宽后的模糊命中照常归属但不登记绑定；时间窗不变（超窗不认）", async () => {
    const c = await published("thinking effort 开到 max");
    await updateContent(c.id, { videoKit: { platform: "wechat_video", postTitle: "深度思考开到max反而跑偏了吗", caption: "", storyboard: [], coverText: "", coverPrompt: "", generatedAt: PUB } }, dir);
    const fuzzy = "深度思考开到max反而跑偏";
    const r = await resolveItemBinding({ platform: "wechat_video", platformTitle: fuzzy, publishedAt: PUB, platformItemId: SPH, dataDir: dir });
    expect(r.contentId).toBe(c.id);
    expect(r.pending).toBeNull();
    expect(await matchDraft("wechat_video", fuzzy, "2026-10-09T10:00:00.000Z", dir)).toBeNull();
  });

  it("没登记过这个平台的稿子不进候选（小红书行不会认到只发了视频号的稿）", async () => {
    const c = await published("thinking effort 开到 max");
    await updateContent(c.id, { videoKit: { platform: "wechat_video", postTitle: "深度思考开到max反而跑偏", caption: "", storyboard: [], coverText: "", coverPrompt: "", generatedAt: PUB } }, dir);
    expect(await matchDraft("xiaohongshu", "深度思考开到max反而跑偏", PUB, dir)).toBeNull();
  });
});

describe("④ 历史作品记录", () => {
  const items = [{ platform: "douyin", item_id: GOOD_DY }, { platform: "wechat_video", item_id: SPH }];

  it("建记录：已发布、imported_history、无正文，一条记录挂多个平台绑定，已入账行补归属", async () => {
    await appendOutcomes([row()], dir);
    const r = await createHistoryRecord({ title: "让Agent帮你买东西", published_date: "2026-09-04", items }, dir);
    expect(r).toMatchObject({ ok: true, status: "created" });
    if (!r.ok) return;
    const c = await getContent(r.contentId, dir);
    expect(c).toMatchObject({ status: "published", source: "imported_history", body: "" });
    expect(c?.publishedAt?.slice(0, 10)).toBe("2026-09-04");
    expect((await lookupPlatformItem("douyin", GOOD_DY, dir))).toMatchObject({ contentId: r.contentId, via: "manual" });
    expect((await lookupPlatformItem("wechat_video", SPH, dir))?.contentId).toBe(r.contentId);
    expect((await listOutcomes(dir))[0].contentId).toBe(r.contentId);
  });

  it("边界：历史记录重复创建（同标题同日期同平台作品）→ 识别为已存在，不重复建", async () => {
    const first = await createHistoryRecord({ title: "让Agent帮你买东西", published_date: "2026-09-04", items }, dir);
    const second = await createHistoryRecord({ title: "让 Agent 帮你买东西", published_date: "2026-09-04", items }, dir);
    expect(second).toMatchObject({ ok: true, status: "exists" });
    if (!first.ok || !second.ok) return;
    expect(second.contentId).toBe(first.contentId);
    expect((await listContents(dir)).filter((c) => c.source === "imported_history")).toHaveLength(1);
  });

  it("平台作品已绑给别的稿 → 整条拒绝，不留半条记录", async () => {
    const other = await published("别的稿");
    await bindWorkManually(other.id, "wechat_video", SPH, dir);
    const r = await createHistoryRecord({ title: "x", published_date: "2026-09-04", items }, dir);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining(other.id) });
    expect((await listContents(dir)).filter((c) => c.source === "imported_history")).toHaveLength(0);
    expect(await lookupPlatformItem("douyin", GOOD_DY, dir)).toBeNull();
  });

  it("边界：删除历史记录 → 同时删绑定；回流原始行保留，归属回到未绑定", async () => {
    await appendOutcomes([row()], dir);
    const r = await createHistoryRecord({ title: "让Agent帮你买东西", published_date: "2026-09-04", items }, dir);
    if (!r.ok) throw new Error(r.error);
    const del = await deleteHistoryRecord(r.contentId, dir);
    expect(del).toMatchObject({ ok: true, retracted: 1 });
    expect(await readPlatformItems(dir)).toEqual({});
    const visible = await listOutcomes(dir);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ contentId: null, platformItemId: SPH, metrics: { views: 3154 } });
    expect((await listContents(dir)).some((c) => c.id === r.contentId)).toBe(false);
    // 删了再建：又能挂回去
    const again = await createHistoryRecord({ title: "让Agent帮你买东西", published_date: "2026-09-04", items }, dir);
    expect(again).toMatchObject({ ok: true, status: "created" });
    expect((await listOutcomes(dir))[0].contentId).toBe(again.ok ? again.contentId : "");
  });

  it("history_delete 只删历史记录，普通稿拒绝", async () => {
    const c = await published("普通稿");
    expect(await deleteHistoryRecord(c.id, dir)).toMatchObject({ ok: false, error: expect.stringContaining("不是历史作品记录") });
  });

  it("边界：历史记录不走状态机，force 也推不动", async () => {
    const r = await createHistoryRecord({ title: "x", published_date: "2026-09-04", items }, dir);
    if (!r.ok) throw new Error(r.error);
    const t = await transitionStatus(r.contentId, "drafting", { force: true }, dir);
    expect(t).toMatchObject({ ok: false, error: expect.stringContaining("imported_history") });
  });

  it("参数校验：日期格式、空 items、坏平台都说清楚", async () => {
    expect(await createHistoryRecord({ title: "x", published_date: "9-4", items }, dir)).toMatchObject({ ok: false, error: expect.stringContaining("YYYY-MM-DD") });
    expect(await createHistoryRecord({ title: "x", published_date: "2026-09-04", items: [] }, dir)).toMatchObject({ ok: false, error: expect.stringContaining("至少") });
    expect(await createHistoryRecord({ title: "x", published_date: "2026-09-04", items: [{ platform: "weibo", item_id: "1" }] }, dir)).toMatchObject({ ok: false, error: expect.stringContaining("items[0]") });
  });
});
