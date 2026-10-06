/** 等你拍板：收件箱里已用过的原片挪走、忽略、预览路由、封面字预填、稿子不进列表 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { draftHash } from "../../storage/draft-hash.js";
import { contentFile } from "../../storage/content-project.js";
import { getContent } from "../../storage/local-store.js";
import { decideItem } from "./inbox-decide.js";
import { openInboxFileMedia } from "./inbox-attachment.js";
import { readInbox } from "./inbox-read.js";
import { USED_DIR } from "./inbox-used.js";
import { reconcileAll } from "./reconcile.js";
import { exists, founderApprove, setContent, makeEnv, png, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

const inboxFiles = async () => (await readInbox(env.dir)).items.filter((i) => i.type === "inbox_file");

describe("收件箱里字节已是某条稿的原片", () => {
  it("不列成「没对上」，挪进「已用过/」；重名加后缀不覆盖", async () => {
    const c = await videoContent(env, "已有原片的稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "已有原片的稿-原片.mov"), "same-bytes"), request_id: "a" });
    await put(path.join(env.inbox, USED_DIR, "ED7AF053.MOV"), "older");
    const copy = await put(path.join(env.inbox, "ED7AF053.MOV"), "same-bytes");
    await reconcileAll(env.dir);
    expect(await exists(copy)).toBe(false);
    expect(await fs.readFile(path.join(env.inbox, USED_DIR, "ED7AF053-2.MOV"), "utf8")).toBe("same-bytes");
    expect(await fs.readFile(path.join(env.inbox, USED_DIR, "ED7AF053.MOV"), "utf8")).toBe("older");
    expect(await inboxFiles()).toEqual([]);
    // 「已用过/」里的不再被扫
    await reconcileAll(env.dir);
    expect(await inboxFiles()).toEqual([]);
  });

  it("挪不走：照样列出来，写明挂在哪条、为什么没挪", async () => {
    const c = await videoContent(env, "另一条原片稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "另一条原片稿-原片.mov"), "dup-bytes"), request_id: "a" });
    await put(path.join(env.inbox, USED_DIR), "我是个文件，不是文件夹");
    await put(path.join(env.inbox, "COPY.MOV"), "dup-bytes");
    await reconcileAll(env.dir);
    const [it] = await inboxFiles();
    expect(it.summary).toContain("没挪走");
    expect(String(it.detail.reason)).toContain("已经挂在《另一条原片稿》上，但没挪走");
    expect(it.actions.map((a) => a.action)).toEqual(["ignore_inbox_file"]);
  });
});

describe("没对上的视频", () => {
  async function setup() {
    const target = await videoContent(env, "等原片的稿");
    await founderApprove(env, target.id);
    const file = await put(path.join(env.inbox, "IMG_9999.mov"), "unmatched-bytes");
    await reconcileAll(env.dir);
    const [it] = await inboxFiles();
    return { target, file, it };
  }
  it("下拉包括还在写作 / 剪辑中的稿，不含已发布的", async () => {
    const writing = await videoContent(env, "还在写的稿", "drafting");
    const editing = await videoContent(env, "剪辑中的稿", "editing");
    await setup();
    const published = await setContent(env, (await videoContent(env, "发了的稿", "approved")).id, { status: "published" });
    const [it] = await inboxFiles();
    const ids = (it.detail.choices as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([writing.id, editing.id]));
    expect(ids).not.toContain(published.id);
  });
  it("「不是原片，忽略」挪进「已用过/」，条目消失；文件换过就拒", async () => {
    const { file, it } = await setup();
    const ignore = it.actions.find((a) => a.action === "ignore_inbox_file")!;
    await put(file, "changed-bytes");
    expect(await decideItem({ item_id: it.item_id, gen: it.gen, action: ignore.action, ...ignore.params }, env.dir)).toMatchObject({ ok: false });
    await put(file, "unmatched-bytes");
    const [fresh] = await inboxFiles();
    expect(await decideItem({ item_id: fresh.item_id, gen: fresh.gen, action: "ignore_inbox_file" }, env.dir)).toMatchObject({ ok: true });
    expect(await exists(file)).toBe(false);
    expect(await exists(path.join(env.inbox, USED_DIR, "IMG_9999.mov"))).toBe(true);
    expect(await inboxFiles()).toEqual([]);
  });
  it("预览只给报告里列着的文件", async () => {
    const { it } = await setup();
    expect(await openInboxFileMedia(it.item_id, env.dir)).toMatchObject({ ok: true, type: "video/quicktime" });
    expect(await openInboxFileMedia("inbox_file:0000000000000000", env.dir)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("封面字预填与稿子不进列表", () => {
  it("组里没字 → 用交接时确认过的封面字；定稿改了就不用", async () => {
    const c = await videoContent(env, "封面字稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "封面字稿-原片.mov"), "raw"), request_id: "a" });
    await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.chatcut, "a.png"), png(900, 1200, "a")), await put(path.join(env.chatcut, "b.png"), png(1200, 900, "b"))], request_id: "g" });
    const content = (await getContent(c.id, env.dir))!;
    const file = contentFile(c.id, env.dir, "decisions.json");
    const write = (hash: string) => put(file, JSON.stringify({ draft_hash: hash, title: c.title, cover_text: "交接确认的字", platform: content.platform, target_seconds: 60, confirmed_at: new Date().toISOString(), source: "founder-workbench" }));
    await write(draftHash(content));
    const cover = () => readInbox(env.dir, { contentId: c.id }).then((v) => v.items.find((i) => i.type === "cover_pick")!);
    expect((await cover()).actions[0].params).toMatchObject({ cover_text: "交接确认的字" });
    expect((await cover()).detail.groups).toEqual([expect.objectContaining({ text: "交接确认的字" })]);
    await write("别的定稿");
    expect((await cover()).actions[0].params).toMatchObject({ cover_text: "" });
  });
  it("「稿子写好了」不进列表；认稿决定照样按代次走", async () => {
    const c = await videoContent(env, "等认的稿");
    expect((await readInbox(env.dir)).items.some((i) => i.type === "draft")).toBe(false);
    const d = (await readInbox(env.dir, { withDrafts: true })).items.find((i) => i.type === "draft" && i.content_id === c.id)!;
    expect(await decideItem({ item_id: d.item_id, gen: d.gen, action: "approve_script", content_id: c.id }, env.dir)).toMatchObject({ ok: true });
  });
});
