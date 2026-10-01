/**
 * 整分支审 10：「就用这版」的拦不拦按那一版自己算；「用这组」的封面字只来自这次交的或所选那一组。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { decideItem } from "./inbox-decide.js";
import { readInbox } from "./inbox-read.js";
import { founderApprove, makeEnv, png, put, record, videoContent, waiveSliverCheck, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });
const doc = async (id: string) => (await readProductionDoc(id, env.dir))!;
const item = async (id: string, type: string) => (await readInbox(env.dir, { contentId: id })).items.find((i) => i.type === type)!;

async function editing(title: string) {
  const c = await videoContent(env, title);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${title}-原片.mov`), `raw-${title}`), request_id: "a" });
  return c;
}

describe("P2 拦不拦按所选那一版", () => {
  it("最新一版被拦、上一版放行过 → 版本清单里上一版不带 blocked_reason，批上一版成功", async () => {
    const c = await editing("按版本拦");
    const v1 = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "v1.mp4"), "cut-1"), request_id: "c1", review: true }, "claude-code");
    const sha1 = (await doc(c.id)).facts.find((f) => f.id === v1.fact_id)!.sha256!;
    await waiveSliverCheck(env, c.id, sha1);
    await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "v2.mp4"), "cut-2"), request_id: "c2", review: true }, "claude-code");
    const it0 = await item(c.id, "cut_review");
    const versions = it0.detail.versions as Array<{ fact_id: string; blocked_reason?: string }>;
    expect(versions[0].blocked_reason).toBeTruthy();
    expect(versions.find((v) => v.fact_id === v1.fact_id)!.blocked_reason).toBeUndefined();
    const r = await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "approve_cut", fact_id: v1.fact_id, content_id: c.id }, env.dir);
    expect(r.ok).toBe(true);
  });
});

describe("P2 封面字不从别的组借", () => {
  it("最新组有字、旧组没字：选旧组不带字 → cover_text_required；带了字 → 记的就是那句", async () => {
    const c = await editing("封面字按组");
    await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.chatcut, "o1.png"), png(900, 1200, "o1")), await put(path.join(env.chatcut, "o2.png"), png(1200, 900, "o2"))], request_id: "old", version: 1 });
    await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.chatcut, "n1.png"), png(900, 1200, "n1")), await put(path.join(env.chatcut, "n2.png"), png(1200, 900, "n2"))], cover_text: "新组的字", request_id: "new", version: 2 });
    const it0 = await item(c.id, "cover_pick");
    const groups = it0.detail.groups as Array<{ group_id: string; text: string }>;
    const old = groups.find((g) => !g.text)!;
    expect(old).toBeTruthy();
    expect(await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "pick_cover", group_id: old.group_id, content_id: c.id }, env.dir)).toMatchObject({ ok: false, code: "cover_text_required" });
    expect(await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "pick_cover", group_id: old.group_id, cover_text: "", content_id: c.id }, env.dir)).toMatchObject({ ok: false, code: "cover_text_required" });
    const it1 = await item(c.id, "cover_pick");
    expect(await decideItem({ item_id: it1.item_id, gen: it1.gen, action: "pick_cover", group_id: old.group_id, cover_text: "旧组新写的字", content_id: c.id }, env.dir)).toMatchObject({ ok: true });
    expect((await doc(c.id)).decisions.find((d) => d.type === "cover_approval")).toMatchObject({ cover_text: "旧组新写的字", group_id: old.group_id });
  });
});
