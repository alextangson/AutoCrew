/** video_kit 的标题方法字段（docs/2026-10-03-title-methods-spec.md §五–§七）与 action=title_methods */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContent, saveContent } from "../storage/local-store.js";
import { executePrePublishTool } from "./pre-publish.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

let dataDir: string;
beforeEach(async () => { dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-title-")); });
afterEach(async () => { await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const CANDIDATES = [
  { title: "开小店的老板用AI回差评", method: "identity-call", reason: "点名身份" },
  { title: "AI 都会用为什么还加班", method: "name-the-need", reason: "点破需求" },
  { title: "回差评从半小时到五分钟", method: "before-after", reason: "前后对比" },
];
const KIT = { post_title: "开小店的老板用AI回差评", caption: "这期讲清楚小店老板怎么让 AI 先把差评回复理顺，看完就能上手。", cover_text: "差评别硬扛", title_candidates: CANDIDATES, title_method: "identity-call" };
const mk = (platform = "douyin", extra: Record<string, unknown> = {}) =>
  saveContent({ _provenance: HUMAN_WRITE, title: "口播稿", body: "口播正文讲 3 个步骤。".repeat(100), platform, status: "approved", videoDone: { renderedRevision: 1, at: "2026-10-01T00:00:00.000Z" }, ...extra }, dataDir);
const save = (id: string, platform: string, kit: Record<string, unknown>) =>
  executePrePublishTool({ action: "video_kit", content_id: id, platform, kit, _dataDir: dataDir });

describe("video_kit 标题方法", () => {
  it("记下候选和本平台方法 id；回执带 title_method", async () => {
    const c = await mk();
    const r = await save(c.id, "douyin", KIT);
    expect(r).toMatchObject({ ok: true, video_kit: { title_method: "identity-call" } });
    const kit = (await getContent(c.id, dataDir))!.videoKit!;
    expect(kit.titleMethod).toBe("identity-call");
    expect(kit.titleCandidates).toHaveLength(3);
  });

  it("方法 id 不存在 → kit_invalid 列出可用 id，不落盘", async () => {
    const c = await mk();
    const r = await save(c.id, "douyin", { ...KIT, title_method: "made-up" }) as { code: string; failures: Array<{ field: string; detail: string }> };
    expect(r.code).toBe("kit_invalid");
    expect(r.failures.find((f) => f.field === "title_method")!.detail).toContain("pitfall-list");
    expect((await getContent(c.id, dataDir))!.videoKit).toBeUndefined();
  });

  it("候选不分属 3 个类 → kit_invalid", async () => {
    const c = await mk();
    const same = [CANDIDATES[0], { ...CANDIDATES[1], method: "belief-clash" }, { ...CANDIDATES[2], method: "twist" }];
    expect(await save(c.id, "douyin", { ...KIT, title_candidates: same })).toMatchObject({ ok: false, code: "kit_invalid" });
  });

  it("缺候选与方法（旧格式）→ kit_invalid，指向两个字段", async () => {
    const c = await mk();
    const { title_candidates: _a, title_method: _b, ...old } = KIT;
    const r = await save(c.id, "douyin", old) as { failures: Array<{ field: string }> };
    expect(r.failures.map((f) => f.field)).toEqual(expect.arrayContaining(["title_candidates", "title_method"]));
  });

  it("创始人自己写：title_method=自拟 照收；整个 kit 被序列化成字符串也能读", async () => {
    const c = await mk();
    expect(await save(c.id, "douyin", JSON.stringify({ ...KIT, post_title: "我自己起的标题", title_method: "自拟" }) as unknown as Record<string, unknown>)).toMatchObject({ ok: true });
    expect((await getContent(c.id, dataDir))!.videoKit!.titleMethod).toBe("自拟");
  });

  it("同一视频不同平台各记各的方法 id", async () => {
    const d = await mk("douyin"), b = await mk("bilibili");
    await save(d.id, "douyin", KIT);
    await save(b.id, "bilibili", { ...KIT, post_title: "【干货】回差评从半小时到五分钟", title_method: "before-after" });
    expect((await getContent(d.id, dataDir))!.videoKit!.titleMethod).toBe("identity-call");
    expect((await getContent(b.id, dataDir))!.videoKit!.titleMethod).toBe("before-after");
  });

  it("标题数字正文里没有 → 回执带 warnings，但照样保存", async () => {
    const c = await mk();
    const r = await save(c.id, "douyin", { ...KIT, post_title: "AI回差评省下30分钟" });
    expect(r).toMatchObject({ ok: true, status: "kit_saved" });
    expect((r.warnings as string[])[0]).toContain("30");
    const ok = await save(c.id, "douyin", { ...KIT, post_title: "AI回差评的3个步骤" });
    expect(ok.warnings).toBeUndefined();
  });

  it("已发布带方法的稿满 4 条 → 交包回执带中期报告提醒", async () => {
    const kit = (m: string) => ({ platform: "douyin", postTitle: "t", caption: "c", storyboard: [], coverText: "x", coverPrompt: "", generatedAt: "", titleMethod: m });
    for (let i = 0; i < 3; i++) await mk("douyin", { status: "published", videoKit: kit("twist") });
    const c = await mk();
    expect((await save(c.id, "douyin", KIT)).title_trial_reminder).toBeUndefined();
    await mk("douyin", { status: "published", videoKit: kit("a-or-b") });
    expect(String((await save(c.id, "douyin", KIT)).title_trial_reminder)).toContain("中期");
  });
});

describe("action=title_methods", () => {
  it("返回方法库指引、可用 id 和试用期统计（旧稿归未标记）", async () => {
    await mk("douyin", { status: "published" });
    const r = await executePrePublishTool({ action: "title_methods", platform: "douyin", _dataDir: dataDir });
    expect(r).toMatchObject({ ok: true, self_written: "自拟", trial_report: { publishedWithMethod: 0, rows: [{ method: "未标记", clickRate: "无数据" }] } });
    expect(r.method_ids).toHaveLength(16);
    expect(String(r.guide)).toContain("本平台语气");
  });
});
