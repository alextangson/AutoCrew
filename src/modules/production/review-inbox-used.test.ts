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

/** 在测试的 ChatCut 工程目录里放一个按绝对路径引用 file 的素材；broken = 写一半的 JSON */
async function chatcutRef(file: string, broken = false) {
  const dir = path.join(path.dirname(env.dir), "chatcut-projects", "p1", "project.chatcutproject");
  await put(path.join(dir, "project.json"), JSON.stringify({ name: "第二点 v003" }));
  await put(path.join(dir, "assets", "video", "a.json"), broken ? "{\"path\": " : JSON.stringify({ path: file }));
}

describe("收件箱原片被别处按路径用着：不挪", () => {
  it("ChatCut 工程引用收件箱这份（另有拷贝归了稿）：不挪、不列", async () => {
    const c = await videoContent(env, "工程在用的稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "工程在用的稿-原片.mov"), "cc-bytes"), request_id: "a" });
    const copy = await put(path.join(env.inbox, "ED7AF053.MOV"), "cc-bytes");
    await chatcutRef(copy);
    await reconcileAll(env.dir);
    expect(await exists(copy)).toBe(true);
    expect(await exists(path.join(env.inbox, USED_DIR))).toBe(false);
    expect(await inboxFiles()).toEqual([]);
  });
  it("引用核不了（素材 JSON 写了一半）：不挪，列出来写明原因", async () => {
    const c = await videoContent(env, "坏工程原片的稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "坏工程原片的稿-原片.mov"), "uv-bytes"), request_id: "a" });
    const copy = await put(path.join(env.inbox, "UV.MOV"), "uv-bytes");
    await chatcutRef(copy, true);
    await reconcileAll(env.dir);
    expect(await exists(copy)).toBe(true);
    const [it] = await inboxFiles();
    expect(String(it.detail.reason)).toContain("没读到 ChatCut 工程信息");
  });
  it("原地收的（accepted 原片的路径就是收件箱这份）：不挪、不列", async () => {
    const c = await videoContent(env, "就地原片的稿");
    await founderApprove(env, c.id);
    const file = await put(path.join(env.inbox, "就地原片的稿-原片.mov"), "ip-bytes");
    await chatcutRef(file);
    const r = await record(env, { content_id: c.id, kind: "aroll", path: file, request_id: "a" });
    expect(r).toMatchObject({ ok: true, state: "accepted" });
    await fs.rm(path.join(path.dirname(env.dir), "chatcut-projects"), { recursive: true });
    await reconcileAll(env.dir);
    expect(await exists(file)).toBe(true);
    expect(await inboxFiles()).toEqual([]);
  });
  it("「忽略」：ChatCut 工程在用就不挪，说原因", async () => {
    await videoContent(env, "等原片的稿");
    const file = await put(path.join(env.inbox, "IMG_5555.mov"), "ref-bytes");
    await reconcileAll(env.dir);
    const [it] = await inboxFiles();
    await chatcutRef(file);
    expect(await decideItem({ item_id: it.item_id, gen: it.gen, action: "ignore_inbox_file" }, env.dir)).toMatchObject({ ok: false, code: "in_use" });
    expect(await exists(file)).toBe(true);
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
  it("对账之后文件变了：不给报告里的证据和「是这条」，标出变过，只留下拉", async () => {
    const { file, it } = await setup();
    expect(it.detail.changed).toBe(false);
    expect(it.detail.duration_ms).toBe(12_000);
    await put(file, "different-bytes");
    const [now] = await inboxFiles();
    expect(now.detail).toMatchObject({ changed: true, duration_ms: null, transcript_head: null, guesses: [], guess: [] });
    expect(now.actions.filter((a) => a.action === "assign").map((a) => a.params?.to)).toEqual([undefined]);
    expect((now.detail.choices as unknown[]).length).toBeGreaterThan(0);
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
