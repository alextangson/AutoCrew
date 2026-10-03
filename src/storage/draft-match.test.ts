import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptionStats, getContent, recordAdoption, saveContent, serializeContentWrite, transitionStatus, updateContent, updateContentIfDraftMatches } from "./local-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-draft-match-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const draft = () => saveContent({ title: "社区菜园", body: "我们一起给菜苗浇水。", platform: "wechat_mp", status: "draft_ready", tags: [] }, dir);

describe("draft compare-and-update", () => {
  it("稿件匹配时保存指纹绑定的裁决并保留无关字段", async () => {
    const content = await draft();
    await updateContent(content.id, { tags: ["保留用户标签"] }, dir);
    const result = await updateContentIfDraftMatches(content.id, content, { adoption: { verdict: "light_edit", draftHash: "confirmed-draft-hash", recordedAt: "now" } }, dir);
    expect(result).toMatchObject({ ok: true, content: { title: content.title, body: content.body, tags: ["保留用户标签"], adoption: { verdict: "light_edit", draftHash: "confirmed-draft-hash" } } });
    expect((await getContent(content.id, dir))?.versions).toHaveLength(1);
  });

  it.each([
    { title: "换个标题" }, { body: "编辑器保存了新的正文。" }, { platform: "douyin" },
  ])("标题/正文/平台变动拒绝旧裁决: %j", async patch => {
    const content = await draft();
    await updateContent(content.id, patch, dir);
    const before = await getContent(content.id, dir);
    expect(await updateContentIfDraftMatches(content.id, content, { adoption: { verdict: "adopted", recordedAt: "now" } }, dir)).toEqual({ ok: false, reason: "stale" });
    expect(await getContent(content.id, dir)).toEqual(before);
  });

  it("与编辑器updateContent共用队列，排在前面的改稿不能被旧hash穿透", async () => {
    const content = await draft();
    let release!: () => void;
    const hold = serializeContentWrite(content.id, () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const editorWrite = updateContent(content.id, { body: "编辑器的新稿" }, dir);
    const oldFeedback = updateContentIfDraftMatches(content.id, content, {
      writingFeedback: [{ instruction: "旧稿结尾改一下", scope: "whole", at: "now" }],
      adoption: { verdict: "adopted", recordedAt: "now" },
    }, dir);
    release();
    await hold;
    await editorWrite;
    expect(await oldFeedback).toEqual({ ok: false, reason: "stale" });
    const saved = await getContent(content.id, dir);
    expect(saved?.body).toBe("编辑器的新稿");
    expect(saved?.writingFeedback).toBeUndefined();
    expect(saved?.adoption).toBeUndefined();
  });

  it("写入按调用顺序排队：先调用的 updateContent 排在后面同步排进去的写之前（不因锁外读文件快慢换序）", async () => {
    // 系列范围外的稿只走单稿队列（范围内的会退出来改走系列锁，那条由上面「共用队列」覆盖）
    const content = await saveContent({ title: "社区菜园", body: "我们一起给菜苗浇水。", platform: "wechat_mp", status: "drafting", tags: [] }, dir);
    const editorWrite = updateContent(content.id, { body: "编辑器的新稿" }, dir);
    const seen = serializeContentWrite(content.id, async () => (await getContent(content.id, dir))?.body);
    await editorWrite;
    expect(await seen).toBe("编辑器的新稿");
  });

  it("锁内补丁函数合并最新反馈，旧快照不会覆盖其他入口留下的历史", async () => {
    const content = await draft();
    const fromEditor = { instruction: "编辑器已确认的局部建议", scope: "selection" as const, at: "first", selection: "菜苗" };
    await updateContent(content.id, { writingFeedback: [fromEditor] }, dir);
    const result = await updateContentIfDraftMatches(content.id, content, current => ({
      writingFeedback: [...(current.writingFeedback ?? []), { instruction: "新的整篇建议", scope: "whole", at: "second" }],
    }), dir);
    expect(result).toMatchObject({ ok: true, content: { writingFeedback: [fromEditor, expect.objectContaining({ instruction: "新的整篇建议" })] } });
    let called = false;
    const stale = await updateContentIfDraftMatches(content.id, { ...content, body: "过期" }, () => {
      called = true;
      return {};
    }, dir);
    expect(stale).toEqual({ ok: false, reason: "stale" });
    expect(called).toBe(false);
  });

  it("稿件不存在返回missing且不创建目录", async () => {
    const existing = await draft();
    await fs.rm(path.join(dir, "contents", existing.id), { recursive: true });
    expect(await updateContentIfDraftMatches(existing.id, existing, { body: "不能创建" }, dir)).toEqual({ ok: false, reason: "missing" });
    expect(await getContent(existing.id, dir)).toBeNull();
  });
});

describe("adoption denominator", () => {
  it("明确退稿保留裁决，计入采纳率分母", async () => {
    const accepted = await draft();
    const rejected = await draft();
    await recordAdoption(accepted.id, "adopted", dir);
    await recordAdoption(rejected.id, "rejected", dir);
    expect((await getContent(rejected.id, dir))?.adoption?.verdict).toBe("rejected");
    expect(await adoptionStats(dir)).toEqual({ judged: 2, adopted: 1, lightEdit: 0, rewritten: 0, rate: 0.5 });
  });
});

describe("draft compare-and-transition", () => {
  it.each([{ title: "新标题" }, { body: "编辑器修改的正文" }, { platform: "douyin" }])("锁内拒绝旧稿状态推进，force也不能跨过稿件核对: %j", async patch => {
    const content = await draft();
    await updateContent(content.id, patch, dir);
    const before = await getContent(content.id, dir);
    expect(await transitionStatus(content.id, "reviewing", { expectedDraft: content, force: true }, dir)).toMatchObject({ ok: false, staleDraft: true });
    expect(await getContent(content.id, dir)).toEqual(before);
  });

  it("排在编辑器后面的状态推进不能穿过写锁套到新稿", async () => {
    const content = await draft();
    let release!: () => void;
    const held = serializeContentWrite(content.id, () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const edited = updateContent(content.id, { body: "排队保存的新稿" }, dir);
    const transition = transitionStatus(content.id, "reviewing", { expectedDraft: content }, dir);
    release();
    await held;
    await edited;
    expect(await transition).toMatchObject({ ok: false, staleDraft: true });
    expect((await getContent(content.id, dir))?.status).toBe("draft_ready");
  });

  it("同稿恢复重试不写第二条交接；显式旧状态仍拒绝", async () => {
    const content = await saveContent({ title: "同稿重试", body: "尚待宿主审阅的正文", platform: "wechat_mp", status: "drafting", tags: [] }, dir);
    expect(await transitionStatus(content.id, "draft_ready", { expectedDraft: content }, dir)).toMatchObject({ ok: true });
    const before = await getContent(content.id, dir);
    expect(before?.handoffs).toHaveLength(1);
    expect(await transitionStatus(content.id, "draft_ready", { expectedDraft: content }, dir)).toMatchObject({ ok: true });
    expect(await getContent(content.id, dir)).toEqual(before);
    expect(await transitionStatus(content.id, "draft_ready", { expectedDraft: content, expectedStatus: "drafting" }, dir)).toMatchObject({ ok: false });
    expect(await transitionStatus(content.id, "draft_ready", {}, dir)).toMatchObject({ ok: false });
  });

  it("改稿按结论指纹失效，合并时匹配新稿的新结论保留", async () => {
    const content = await draft();
    const hash = (body: string) => createHash("sha256").update(JSON.stringify([content.title, body, content.platform])).digest("hex");
    const review = { status: "passed" as const, rounds: 0, fixed: 0, issues: [], reviewedAt: "first", source: { kind: "host_self_review" as const, reviewerHost: "claude", writerHost: "claude", independent: false as const, draftHash: hash(content.body) } };
    await updateContent(content.id, { review }, dir);
    await updateContent(content.id, { body: "已经变动的新稿" }, dir);
    expect((await getContent(content.id, dir))?.review?.status).toBe("stale");
    const newBody = "与新结论一起保存的稿件";
    const newReview = { ...review, reviewedAt: "second", source: { ...review.source, draftHash: hash(newBody) } };
    await updateContent(content.id, { body: newBody, review: newReview }, dir);
    expect((await getContent(content.id, dir))?.review).toEqual(newReview);
    await updateContent(content.id, { tags: ["只改标签"] }, dir);
    expect((await getContent(content.id, dir))?.review).toEqual(newReview);
  });
});
