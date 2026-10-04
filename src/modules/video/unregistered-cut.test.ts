/**
 * 剪完未登记提醒（spec 2026-09-29）：匹配规则、三种信号、brief 分桶、剪辑桌条目、封面附件守卫。
 * 导出目录一律注入临时目录，不碰真实 ~/Movies。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportMatchesTitle, normalizeTitle } from "./unregistered-cut.js";
import { executeStatus } from "../../tools/status.js";
import { executeDesk } from "../../tools/desk.js";
import { executeAsset } from "../../tools/asset.js";
import { initializeProjectLayout, resolveContentProject } from "../../storage/content-project.js";
import { addAsset, getContent, saveContent, transitionStatus, type ContentStatus } from "../../storage/local-store.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

const T1 = "客户问一句「你们用 AI 吗」，你答得上来吗";
const T2 = "你每天纠正 AI 同一件事？它根本不会从纠正里学";

describe("标题匹配", () => {
  it("规范化：去空白标点、字母小写", () => {
    expect(normalizeTitle(T1)).toBe("客户问一句你们用ai吗你答得上来吗");
  });

  it("前缀命中：尾部后缀段按 - 切掉", () => {
    expect(exportMatchesTitle("客户问一句你们用AI吗-长版-1080p.mp4", T1)).toBe(true);
    expect(exportMatchesTitle("你每天纠正AI同一件事-1080p.mp4", T2)).toBe(true);
    expect(exportMatchesTitle("你每天纠正AI同一件事_final.MOV", T2)).toBe(true);
  });

  it("5 个字的前缀、中间片段、非视频扩展名都不命中", () => {
    expect(exportMatchesTitle("客户问一句-1080p.mp4", T1)).toBe(false);
    expect(exportMatchesTitle("你们用AI吗你答得上来吗.mp4", T1)).toBe(false);
    expect(exportMatchesTitle("客户问一句你们用AI吗.wav", T1)).toBe(false);
    expect(exportMatchesTitle("客户问一句你们用AI吗.srt", T1)).toBe(false);
  });
});

let dir: string, chatcut: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-cut-")));
  chatcut = path.join(dir, "chatcut-exports");
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

async function seed(title: string, status: ContentStatus = "approved", platform = "douyin"): Promise<string> {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title, body: "正文", platform, status: status === "editing" ? "approved" : status, tags: [], hashtags: [] }, dir);
  if (status === "editing") await transitionStatus(c.id, "editing", { viaHandoff: true }, dir);
  return c.id;
}
async function exportFile(name: string, where = chatcut) {
  await fs.mkdir(where, { recursive: true });
  await fs.writeFile(path.join(where, name), "x");
}
const brief = () => executeStatus({ brief: true, _dataDir: dir, _chatcutExportDir: chatcut }) as Promise<Record<string, any>>;
const editorDesk = () => executeDesk({ action: "inbox", employee: "editor", _dataDir: dir, _chatcutExportDir: chatcut }) as Promise<Record<string, any>>;

describe("信号与分桶", () => {
  it("导出文件命中：从待认稿 / 等 A-roll 扣掉，单独成桶，不进已派工；总数守恒", async () => {
    const hit = await seed(T1);
    await seed("另一条还没剪的视频稿", "draft_ready");
    await seed("正在剪的视频稿", "editing");
    await exportFile("客户问一句你们用AI吗-长版-1080p.mp4");
    const r = await brief();
    expect(r.counts).toMatchObject({ awaiting_approval: 1, awaiting_aroll: 0, cut_unregistered: 1, dispatched: 1 });
    expect(r.brief).toBe("0 待写 / 1 待认稿 / 0 等 A-roll / 1 剪完未登记 / 1 已派工待登记 / 0 待发布");
    expect(r).not.toHaveProperty("warnings");
    const desk = await editorDesk();
    const item = desk.items.find((i: any) => i.content_id === hit);
    expect(item).toMatchObject({ reason: "cut_unregistered", signals: { export_files: ["客户问一句你们用AI吗-长版-1080p.mp4"], cover_assets: 0 } });
    expect(item.next_action).toContain("handoff");
    expect(desk.items.filter((i: any) => !i.reason)).toHaveLength(1);
  });

  it("封面附件命中", async () => {
    const id = await seed("只回传了封面的视频稿", "draft_ready");
    await addAsset(id, { filename: "cover.png", type: "cover" }, dir);
    expect((await brief()).counts).toMatchObject({ awaiting_aroll: 0, cut_unregistered: 1 });
    const item = (await editorDesk()).items.find((i: any) => i.content_id === id);
    expect(item.signals).toMatchObject({ cover_assets: 1, export_files: [] });
  });

  it("项目 05-cover 任意子目录有图就命中；只有非图片不算", async () => {
    await initializeProjectLayout(dir, "lib-deadbeef", "default");
    const id = await seed("项目里放了封面的视频稿");
    const root = resolveContentProject(id, dir)!.project_root;
    await fs.mkdir(path.join(root, "05-cover", "review-a"), { recursive: true });
    await fs.writeFile(path.join(root, "05-cover", "review-a", "notes.txt"), "x");
    expect((await brief()).counts.cut_unregistered).toBe(0);
    await fs.writeFile(path.join(root, "05-cover", "review-a", "a.JPG"), "x");
    expect((await brief()).counts.cut_unregistered).toBe(1);
    const item = (await editorDesk()).items.find((i: any) => i.content_id === id);
    expect(item.signals.project_cover_dirs).toEqual(["review-a"]);
  });

  it("已 editing / published 的稿、非视频平台都不算", async () => {
    await seed(T1, "editing");
    await seed(T2, "approved", "wechat_mp");
    await exportFile("客户问一句你们用AI吗-1080p.mp4");
    await exportFile("你每天纠正AI同一件事-1080p.mp4");
    expect((await brief()).counts).toMatchObject({ cut_unregistered: 0, dispatched: 1 });
  });

  it("剪映导出目录：设了也扫；没设只看 ChatCut 目录不报错", async () => {
    await seed(T2, "draft_ready");
    const jianying = path.join(dir, "jianying");
    await exportFile("你每天纠正AI同一件事-1080p.mp4", jianying);
    expect((await brief()).counts.cut_unregistered).toBe(0);
    await fs.writeFile(path.join(dir, "video.json"), JSON.stringify({ jianyingExportDir: jianying }));
    expect((await brief()).counts.cut_unregistered).toBe(1);
  });

  it.skipIf(process.getuid?.() === 0)("目录读不了（EACCES）：warnings + brief 末尾提示；ENOENT 无 warning", async () => {
    await seed(T1);
    expect(await brief()).not.toHaveProperty("warnings");
    await fs.mkdir(chatcut, { recursive: true });
    await fs.chmod(chatcut, 0o000);
    try {
      const r = await brief();
      expect(r.warnings).toEqual([`读不了 ChatCut 导出目录：${chatcut}（EACCES）`]);
      expect(r.brief.endsWith("（读不了导出目录）")).toBe(true);
      expect((await editorDesk()).warnings).toHaveLength(1);
    } finally {
      await fs.chmod(chatcut, 0o755);
    }
  });
});

describe("asset add 封面守卫", () => {
  const add = (id: string, type: string) =>
    executeAsset({ _dataDir: dir, action: "add", content_id: id, filename: "c.png", asset_type: type }) as Promise<Record<string, any>>;

  it("draft_ready 视频稿：照常保存并回 warning", async () => {
    const id = await seed("视频稿", "draft_ready");
    const r = await add(id, "cover");
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("gate4");
    expect((await getContent(id, dir))!.assets.map((a) => a.type)).toEqual(["cover"]);
  });

  it("editing 稿、非 cover 类型、非视频平台：不回 warning", async () => {
    expect(await add(await seed("剪辑中", "editing"), "cover")).not.toHaveProperty("warning");
    expect(await add(await seed("视频稿2", "draft_ready"), "broll")).not.toHaveProperty("warning");
    expect(await add(await seed("公众号", "approved", "wechat_mp"), "cover")).not.toHaveProperty("warning");
  });
});
