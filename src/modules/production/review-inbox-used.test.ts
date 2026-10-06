/** 等你拍板：封面字预填、稿子不进列表（收件箱视频条目随自动找原片删掉了） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { draftHash } from "../../storage/draft-hash.js";
import { contentFile } from "../../storage/content-project.js";
import { getContent } from "../../storage/local-store.js";
import { decideItem } from "./inbox-decide.js";
import { readInbox } from "./inbox-read.js";
import { founderApprove, makeEnv, png, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

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
