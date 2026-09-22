import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptionStats, getContent, recordAdoption, saveContent, serializeContentWrite, updateContent, updateContentIfDraftMatches } from "./local-store.js";

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
