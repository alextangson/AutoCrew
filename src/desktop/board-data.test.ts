import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeProjectLayout, resolveContentProject } from "../storage/content-project.js";
import { getContent, saveContent, saveTopic, transitionStatus } from "../storage/local-store.js";
import { boardData, countChars } from "./board-data.js";

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

it("列沿用「我的内容」口径：视频定稿进待录制，非视频定稿进待发布，归档不进任何列", async () => {
  const video = await saveContent({ title: "视频", body: "正文", status: "draft_ready", platform: "douyin", tags: [] }, dir);
  const article = await saveContent({ title: "图文", body: "正文", status: "draft_ready", platform: "wechat_mp", tags: [] }, dir);
  const gone = await saveContent({ title: "归档", body: "正文", status: "needs_evidence", platform: "douyin", tags: [] }, dir);
  await transitionStatus(gone.id, "archived", {}, dir);
  const data = await boardData(dir);
  const col = Object.fromEntries(data.items.map((i) => [i.id, i.column]));
  expect(col[video.id]).toBe("待录制");
  expect(col[article.id]).toBe("待发布");
  expect(col[gone.id]).toBeUndefined();
});

it("已开写的选题不再出现在选题列", async () => {
  const t = await saveTopic({ title: "开写了", tags: [] }, dir);
  const idle = await saveTopic({ title: "还没写", tags: [], source: "radar:爱范儿", score: 71 }, dir);
  await saveContent({ title: "开写了", body: "", status: "drafting", platform: "douyin", topicId: t.id, tags: [] }, dir);
  const data = await boardData(dir);
  expect(data.topics.map((x) => x.id)).toEqual([idle.id]);
  expect(data.topics[0]).toMatchObject({ source: "radar:爱范儿", score: 71 });
});

it("发布计划里任一平台已提交 → 稿件同步为已发布并进已发布列", async () => {
  const c = await saveContent({ title: "图文", body: "正文", status: "publish_ready", platform: "wechat_mp", tags: [] }, dir);
  await writePlan(c.id, JSON.stringify({ platforms: [
    { platform: "douyin", publication: { status: "scheduled", scheduled_at: "2099-10-02T18:00:00+08:00" } },
    { platform: "wechat_video", publication: { status: "not_submitted" } },
  ] }));
  const item = (await boardData(dir)).items.find((i) => i.id === c.id)!;
  expect(item.column).toBe("已发布");
  expect(item.publishTime).toBe("2099-10-02T18:00:00+08:00");
  expect((await getContent(c.id, dir))?.status).toBe("published");
});

it("发布计划格式坏：留在待发布，记录标成读不到", async () => {
  const c = await saveContent({ title: "图文", body: "正文", status: "publish_ready", platform: "wechat_mp", tags: [] }, dir);
  await writePlan(c.id, "{not json");
  const item = (await boardData(dir)).items.find((i) => i.id === c.id)!;
  expect(item.column).toBe("待发布");
  expect(item.publish).toMatchObject({ kind: "unreadable" });
});

it("没有登记过成片 → 不给语速；字数去空白", async () => {
  expect((await boardData(dir)).wordsPerMinute).toBeNull();
  expect(countChars("# 标题\n\n你好 世界\nab")).toBe(6);
});
