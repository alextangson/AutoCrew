import { describe, expect, it } from "vitest";
import type { Content } from "../lib";
import {
  editEditorState, editorDirty, emptyEditorState, readEditorBuffer, reconcileEditorState, restoreEditorState,
} from "./editor-sync";

const original: Content = {
  id: "article-1", title: "原来标题", body: "原来正文", platform: "wechat_mp", status: "draft_ready",
  hashtags: [], createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z",
};
const updated: Content = { ...original, title: "最新标题", body: "最新正文", updatedAt: "2026-09-22T00:01:00Z" };

describe("稿件实时同步", () => {
  it("初次载入及无未保存输入时，后台标题与正文一并自动更新", () => {
    const opened = reconcileEditorState(emptyEditorState, original);
    const refreshed = reconcileEditorState(opened, updated);
    expect(refreshed.draft).toEqual({ title: updated.title, body: updated.body });
    expect(editorDirty(refreshed)).toBe(false);
    expect(refreshed.remoteChanged).toBe(false);
  });

  it("正在编辑时保留本地输入，连续刷新仍提示远端新版本", () => {
    const opened = restoreEditorState(original, null);
    const typing = editEditorState(opened, { body: "我还没存的字" });
    const refreshed = reconcileEditorState(typing, updated);
    const polledAgain = reconcileEditorState(refreshed, updated);
    expect(polledAgain.draft).toEqual({ title: original.title, body: "我还没存的字" });
    expect(polledAgain.content).toEqual(updated);
    expect(polledAgain.remoteChanged).toBe(true);
    expect(editorDirty(polledAgain)).toBe(true);
  });

  it("后台只有状态/审稿变化时更新元数据，不提示正文冲突、不丢输入", () => {
    const typing = editEditorState(restoreEditorState(original, null), { title: "我的新标题" });
    const refreshed = reconcileEditorState(typing, { ...original, status: "reviewing", updatedAt: updated.updatedAt });
    expect(refreshed.content?.status).toBe("reviewing");
    expect(refreshed.draft.title).toBe("我的新标题");
    expect(refreshed.remoteChanged).toBe(false);
  });

  it("本地正文已与后台一致时自动清理脏状态与过期更新提示", () => {
    const typing = editEditorState(restoreEditorState(original, null), { title: updated.title, body: updated.body });
    const refreshed = reconcileEditorState(typing, updated);
    expect(editorDirty(refreshed)).toBe(false);
    expect(refreshed.remoteChanged).toBe(false);
  });

  it("用户手动改到后台最新内容时也清理更新提示", () => {
    const typing = editEditorState(restoreEditorState(original, null), { body: "本地文字" });
    const conflict = reconcileEditorState(typing, updated);
    const resolved = editEditorState(conflict, { title: updated.title, body: updated.body });
    expect(resolved.remoteChanged).toBe(false);
    expect(editorDirty(resolved)).toBe(false);
  });

  it("保存以真实回执的正文和规范化标题为准", () => {
    const typing = editEditorState(restoreEditorState(original, null), { title: " 最新标题 ", body: updated.body });
    const saved = reconcileEditorState(typing, updated, typing.draft);
    expect(saved.draft).toEqual({ title: updated.title, body: updated.body });
    expect(editorDirty(saved)).toBe(false);
  });

  it("保存期间继续输入的正文保留，随后自己的刷新也不会覆盖它", () => {
    const submitted = editEditorState(restoreEditorState(original, null), { title: updated.title, body: updated.body });
    const moreTyping = editEditorState(submitted, { body: `${updated.body}，保存期间继续输入` });
    const saved = reconcileEditorState(moreTyping, updated, submitted.draft);
    const polled = reconcileEditorState(saved, updated);
    expect(polled.draft.body).toBe(moreTyping.draft.body);
    expect(editorDirty(polled)).toBe(true);
    expect(polled.remoteChanged).toBe(false);
  });

  it("收下提案后显示已落库版本，同时保留等待回执期间单独改的标题", () => {
    const before = restoreEditorState(original, null);
    const whileSaving = editEditorState(before, { title: "我继续写的标题" });
    const saved = reconcileEditorState(whileSaving, updated, before.draft);
    expect(saved.draft).toEqual({ title: "我继续写的标题", body: updated.body });
    expect(editorDirty(saved)).toBe(true);
  });

  it("只收下正文提案时，保留此前尚未保存的本地标题", () => {
    const before = editEditorState(restoreEditorState(original, null), { title: "未保存标题" });
    const saved = reconcileEditorState(before, updated, { body: before.draft.body });
    expect(saved.draft).toEqual({ title: "未保存标题", body: updated.body });
    expect(editorDirty(saved)).toBe(true);
  });
});

describe("本地未保存稿恢复", () => {
  it("恢复新版缓冲时，即使后台更晚修改也不丢本地未保存文字", () => {
    const restored = restoreEditorState(updated, {
      title: original.title, body: "未保存正文", at: Date.parse(original.updatedAt) + 100,
      baseUpdatedAt: original.updatedAt,
    });
    expect(restored.draft.body).toBe("未保存正文");
    expect(restored.remoteChanged).toBe(true);
  });

  it("缓冲的冲突提示在刷新后仍然保留", () => {
    const restored = restoreEditorState(updated, {
      title: original.title, body: "未保存正文", at: Date.parse(updated.updatedAt) + 100,
      baseUpdatedAt: updated.updatedAt, remoteChanged: true,
    });
    expect(restored.remoteChanged).toBe(true);
  });

  it("旧格式缓冲继续支持恢复较新的输入，但过期副本不遮盖服务器正文", () => {
    const stale = { title: original.title, body: "旧缓冲", at: Date.parse(original.updatedAt) + 100 };
    expect(restoreEditorState(original, stale).draft.body).toBe("旧缓冲");
    expect(restoreEditorState(updated, stale).draft.body).toBe(updated.body);
  });

  it("缓存和已保存内容相同时无需再次恢复或提示冲突", () => {
    const restored = restoreEditorState(updated, {
      title: updated.title, body: updated.body, at: Date.now(), baseUpdatedAt: original.updatedAt, remoteChanged: true,
    });
    expect(editorDirty(restored)).toBe(false);
    expect(restored.remoteChanged).toBe(false);
  });

  it.each([null, "broken json", "{}", JSON.stringify({ title: 12, body: "正文", at: 10 })])
    ("忽略损坏或不完整的缓存 %s", (raw) => {
      expect(readEditorBuffer(raw)).toBeNull();
    });
});
