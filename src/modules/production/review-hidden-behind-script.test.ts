/**
 * 认稿前交上来的成片 / 封面（2026-10-03 事故）：「等你拍板」只出稿件条目，审阅要等认稿。
 * agent 的回执要明说创始人现在看不到；稿件条目要说明后面有东西在等；认稿后审阅照常出现。认稿只归创始人。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { executeContentSave } from "../../tools/content-save.js";
import { getContent } from "../../storage/local-store.js";
import { readInbox } from "./inbox-read.js";
import { scriptApprovalFor } from "../../storage/production-store.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { founderApprove, makeEnv, png, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const TITLE = "认稿前的成片";
const agent = (p: Record<string, unknown>) => executeContentSave({ _dataDir: env.dir, _host: "claude-code", ...p }) as Promise<Record<string, unknown>>;
const items = async (id: string) => (await readInbox(env.dir, { contentId: id })).items;
const types = async (id: string) => (await items(id)).map((i) => i.type).sort();
const cover = (name: string, w: number, h: number) => put(path.join(env.chatcut, name), png(w, h, name));

async function cutAndCoverBeforeApproval() {
  const c = await videoContent(env, TITLE);
  const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, `${TITLE}.mp4`), "cut-1"), request_id: "c1" });
  const ready = await agent({ action: "mark_ready", content_id: c.id, fact_id: cut.fact_id });
  const pair = await record(env, { content_id: c.id, kind: "cover", paths: [await cover("a.png", 900, 1200), await cover("b.png", 1200, 900)], cover_text: "字", request_id: "pp" });
  return { c, cut, ready, pair };
}

describe("认稿前标「可以审了」/ 记封面", () => {
  it("回执明说创始人现在看不到，要先认稿；不替创始人认稿", async () => {
    const { c, cut, ready, pair } = await cutAndCoverBeforeApproval();
    expect(cut).toMatchObject({ ok: true, state: "accepted", inbox_hidden: "script_not_approved" });
    // 没标「可以审了」的成片：认稿后也不会自己出现，不许承诺
    expect(cut.next_action).not.toContain("自动出现");
    expect(cut.next_action).toContain("mark_ready");
    expect(ready.next_action).toContain("认稿后它会自动出现");
    expect(pair.next_action).toContain("认稿后它会自动出现");
    for (const r of [ready, pair]) {
      expect(r).toMatchObject({ ok: true, inbox_hidden: "script_not_approved" });
      expect(r.next_action).toContain("稿子没问题");
      expect(r.next_action).not.toContain("创始人会在「等你拍板」里看到");
    }
    expect(pair.group_id).toBeTruthy();
    const content = (await getContent(c.id, env.dir))!;
    expect(content.status).toBe("draft_ready");
    expect(scriptApprovalFor(await readProductionDocOrEmpty(c.id, env.dir), content.body ?? "")).toBeFalsy();
  });

  it("稿件状态还没交审：回执说先交审，不叫创始人去点不存在的条目", async () => {
    const c = await videoContent(env, TITLE, "drafting");
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, `${TITLE}.mp4`), "cut-1"), request_id: "c1" });
    const ready = await agent({ action: "mark_ready", content_id: c.id, fact_id: cut.fact_id });
    expect(ready).toMatchObject({ ok: true, inbox_hidden: "script_not_approved" });
    expect(ready.next_action).toContain("还没交给创始人认稿");
    expect(await types(c.id)).toEqual([]);
  });

  it("「等你拍板」只有稿件条目，它说明成片和封面在等认稿，并排到挡住推进那一档", async () => {
    const { c } = await cutAndCoverBeforeApproval();
    const list = await items(c.id);
    expect(list.map((i) => i.type)).toEqual(["draft"]);
    expect(list[0]).toMatchObject({ summary: "稿子写好了，过一眼（成片和封面都做好了，认稿后才能审）", rank: 1, detail: { waiting_behind: ["cut_review", "cover_pick"] } });
  });

  it("只有成片标了 / 只有半组封面：说明只提成片；什么都没有就是原来的稿件条目", async () => {
    const plain = await videoContent(env, "什么都没有");
    expect((await items(plain.id))[0]).toMatchObject({ summary: "稿子写好了，过一眼", rank: 3 });
    expect((await items(plain.id))[0].detail.waiting_behind).toBeUndefined();

    const c = await videoContent(env, TITLE);
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, `${TITLE}.mp4`), "cut-1"), request_id: "c1", review: true });
    expect(cut).toMatchObject({ inbox_hidden: "script_not_approved" });
    const single = await record(env, { content_id: c.id, kind: "cover", path: await cover("a.png", 900, 1200), request_id: "p1" });
    expect(single).toMatchObject({ inbox_hidden: "script_not_approved" });
    expect(single.next_action).not.toContain("自动出现");
    expect((await items(c.id)).find((i) => i.type === "draft")).toMatchObject({ summary: "稿子写好了，过一眼（成片剪好了，认稿后才能审）", detail: { waiting_behind: ["cut_review"] } });
  });

  it("创始人认稿后：成片审阅和挑封面出现，稿件条目消失；之后再标不带警告", async () => {
    const { c, cut } = await cutAndCoverBeforeApproval();
    const before = (await items(c.id)).find((i) => i.type === "draft")!;
    await founderApprove(env, c.id);
    expect(await types(c.id)).toEqual(expect.arrayContaining(["cover_pick", "cut_review"]));
    expect(await types(c.id)).not.toContain("draft");
    expect((await items(c.id)).some((i) => i.item_id === before.item_id)).toBe(false);
    const again = await agent({ action: "mark_ready", content_id: c.id, fact_id: cut.fact_id });
    expect(again).toMatchObject({ ok: true });
    expect(again.inbox_hidden).toBeUndefined();
    expect(again.next_action).toContain("创始人会在「等你拍板」里看到它");
  });
});
