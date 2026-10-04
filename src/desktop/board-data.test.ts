import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeProjectLayout, resolveContentProject } from "../storage/content-project.js";
import { getContent, saveContent, saveTopic, transitionStatus } from "../storage/local-store.js";
import { boardData, countChars } from "./board-data.js";
import { reconcileAll } from "../modules/production/reconcile.js";
import { setProductionDeps } from "../modules/production/roots.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

// 对账只看注入的根：不碰真实 ~/Movies/ChatCut 与资料库收件箱
setProductionDeps({ roots: async () => ({ inbox: null, chatcut: null, jianying: null }) });

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-board-data-")));
  await initializeProjectLayout(dir, "lib-deadbeef", "default");
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const writePlan = async (id: string, text: string) => {
  const root = resolveContentProject(id, dir)!.project_root;
  await fs.mkdir(path.join(root, "06-publish"), { recursive: true });
  await fs.writeFile(path.join(root, "06-publish/publish-plan.json"), text);
};

it("列沿用「我的内容」口径：没认的稿留写稿中；认过的视频进待录制、非视频进待发布；归档不进任何列", async () => {
  const unapproved = await saveContent({ _provenance: HUMAN_WRITE, title: "等认", body: "正文", status: "draft_ready", platform: "douyin", tags: [] }, dir);
  const unapprovedArticle = await saveContent({ _provenance: HUMAN_WRITE, title: "等认图文", body: "正文", status: "draft_ready", platform: "wechat_mp", tags: [] }, dir);
  const video = await saveContent({ _provenance: HUMAN_WRITE, title: "视频", body: "正文", status: "approved", platform: "douyin", tags: [] }, dir);
  const article = await saveContent({ _provenance: HUMAN_WRITE, title: "图文", body: "正文", status: "approved", platform: "wechat_mp", tags: [] }, dir);
  const gone = await saveContent({ _provenance: HUMAN_WRITE, title: "归档", body: "正文", status: "needs_evidence", platform: "douyin", tags: [] }, dir);
  await transitionStatus(gone.id, "archived", {}, dir);
  const data = await boardData(dir);
  const col = Object.fromEntries(data.items.map((i) => [i.id, i.column]));
  expect(col[unapproved.id]).toBe("写稿中");
  expect(col[unapprovedArticle.id]).toBe("写稿中");
  expect(col[video.id]).toBe("待录制");
  expect(col[article.id]).toBe("待发布");
  expect(col[gone.id]).toBeUndefined();
});

it("选题会片单：会议位指向最近一次会议才算本周片单（选题会 §0.3）", async () => {
  const { saveMeetingCas } = await import("../modules/meetings/meeting-store.js");
  const { updateTopic } = await import("../storage/local-store.js");
  const now = await saveTopic({ title: "本周", tags: [] }, dir);
  const old = await saveTopic({ title: "上周", tags: [] }, dir);
  await updateTopic(now.id, { meetingSlot: { meetingDate: "2026-10-02", slotId: "s1" } }, dir);
  await updateTopic(old.id, { meetingSlot: { meetingDate: "2026-09-25", slotId: "s1" } }, dir);
  await saveMeetingCas({ date: "2026-10-02", slots: [], rejected: [], reviews: [] }, 0, dir);
  const slate = Object.fromEntries((await boardData(dir)).topics.map((t) => [t.id, t.inSlate]));
  expect(slate).toEqual({ [now.id]: true, [old.id]: false });
});

it("已开写的选题不再出现在选题列", async () => {
  const t = await saveTopic({ title: "开写了", tags: [] }, dir);
  const idle = await saveTopic({ title: "还没写", tags: [], source: "radar:爱范儿", score: 71 }, dir);
  await saveContent({ _provenance: HUMAN_WRITE, title: "开写了", body: "", status: "drafting", platform: "douyin", topicId: t.id, tags: [] }, dir);
  const data = await boardData(dir);
  expect(data.topics.map((x) => x.id)).toEqual([idle.id]);
  expect(data.topics[0]).toMatchObject({ source: "radar:爱范儿", score: 71 });
});

it("发布计划里任一平台已提交 → 看板归已发布列，但读看板不写状态（本体 §4 看板读零写入）；对账循环再同步状态", async () => {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title: "图文", body: "正文", status: "publish_ready", platform: "wechat_mp", tags: [] }, dir);
  await writePlan(c.id, JSON.stringify({ platforms: [
    { platform: "douyin", publication: { status: "scheduled", scheduled_at: "2099-10-02T18:00:00+08:00" } },
    { platform: "wechat_video", publication: { status: "not_submitted" } },
  ] }));
  const before = await fs.readFile(path.join(resolveContentProject(c.id, dir)!.project_root, "00-project/autocrew/meta.json"), "utf8");
  const item = (await boardData(dir)).items.find((i) => i.id === c.id)!;
  expect(item.column).toBe("已发布");
  expect(item.publishTime).toBe("2099-10-02T18:00:00+08:00");
  expect(await fs.readFile(path.join(resolveContentProject(c.id, dir)!.project_root, "00-project/autocrew/meta.json"), "utf8")).toBe(before);
  expect((await getContent(c.id, dir))?.status).toBe("publish_ready");
  await reconcileAll(dir);
  const saved = await getContent(c.id, dir);
  expect(saved?.status).toBe("published");
  // 发布时间取平台上的时间，不是对账跑到它的时刻
  expect(saved?.publishedAt).toBe("2099-10-02T18:00:00+08:00");
});

it("发布计划格式坏：留在待发布，记录标成读不到", async () => {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title: "图文", body: "正文", status: "publish_ready", platform: "wechat_mp", tags: [] }, dir);
  await writePlan(c.id, "{not json");
  const item = (await boardData(dir)).items.find((i) => i.id === c.id)!;
  expect(item.column).toBe("待发布");
  expect(item.publish).toMatchObject({ kind: "unreadable" });
});

it("没有登记过成片 → 不给语速；字数去空白", async () => {
  expect((await boardData(dir)).wordsPerMinute).toBeNull();
  expect(countChars("# 标题\n\n你好 世界\nab")).toBe(6);
});

it("正在写：drafting 且占位标题 / 写手认领还活着才算；别的状态、过期认领、别的岗位都不算", async () => {
  const { isBeingWritten } = await import("./board-data.js");
  const now = Date.parse("2026-10-04T10:00:00Z");
  const claim = (employee: "writer" | "cover", leaseUntil: string) => ({ employee, host: "claude-code", token: "t", at: "2026-10-04T09:50:00Z", leaseUntil });
  expect(isBeingWritten({ status: "drafting", title: "［生成中］某选题" }, now)).toBe(true);
  expect(isBeingWritten({ status: "drafting", title: "［调研中］某选题" }, now)).toBe(true);
  expect(isBeingWritten({ status: "drafting", title: "手写", claim: claim("writer", "2026-10-04T10:20:00Z") }, now)).toBe(true);
  expect(isBeingWritten({ status: "drafting", title: "手写", claim: claim("writer", "2026-10-04T09:59:00Z") }, now)).toBe(false);
  expect(isBeingWritten({ status: "drafting", title: "手写", claim: claim("cover", "2026-10-04T10:20:00Z") }, now)).toBe(false);
  expect(isBeingWritten({ status: "draft_ready", title: "［生成中］残留", claim: claim("writer", "2026-10-04T10:20:00Z") }, now)).toBe(false);
  expect(isBeingWritten({ status: "drafting", title: "［生成中断］某选题" }, now)).toBe(false);
});

it("稿件移入回收站后离开看板、进回收站，恢复后回到原列", async () => {
  const { softDeleteContent, restoreContent, listTrash } = await import("../storage/local-store.js");
  const c = await saveContent({ _provenance: HUMAN_WRITE, title: "弃用", body: "正文", status: "draft_ready", platform: "douyin", tags: [] }, dir);
  expect((await boardData(dir)).items.find((i) => i.id === c.id)?.writing).toBe(false);
  await softDeleteContent(c.id, dir);
  expect((await boardData(dir)).items.some((i) => i.id === c.id)).toBe(false);
  expect((await listTrash(dir)).contents.map((x) => x.id)).toContain(c.id);
  await restoreContent(c.id, dir);
  expect((await boardData(dir)).items.find((i) => i.id === c.id)?.column).toBe("写稿中");
});
