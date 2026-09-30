/**
 * 等你拍板 2a-1 Codex 第三轮会审（1 P1 + 2 P2）的回归（~/.cache/autocrew-yt/review-inbox/codex-review-2a1-r3.txt）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { executePublishCheck } from "../publish/review-gate/check.js";
import { fakeJev, planEntry, planOf, registeredVideo } from "../publish/review-gate/testkit.js";
import type { JevCaller } from "../publish/review-gate/jev-client.js";
import { validCoverGroups } from "./cover-groups.js";
import { founderDecision } from "./decisions.js";
import { decide, decideItem } from "./inbox-decide.js";
import { readInbox } from "./inbox-read.js";
import { reconcileAll } from "./reconcile.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const doc = async (id: string) => (await readProductionDoc(id, env.dir))!;
const items = async (id: string) => (await readInbox(env.dir, { contentId: id })).items;
async function editing() {
  const c = await videoContent(env, "三轮回归");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "三轮回归-原片.mov"), "raw"), request_id: "a" });
  return c;
}
const img = (n: string, w: number, h: number) => put(path.join(env.chatcut, n), png(w, h, n));

describe("Codex 2a-1 第三轮", () => {
  it("R3-P1 旧工作台选封面按 3:4 + 4:3 两张一起认组，不按 3:4 取最新一组", async () => {
    const c = await editing();
    const a = await img("a.png", 900, 1200);
    const g1 = await record(env, { content_id: c.id, kind: "cover", paths: [a, await img("b.png", 1200, 900)], cover_text: "字", request_id: "g1" });
    await record(env, { content_id: c.id, kind: "cover", paths: [a, await img("c.png", 1200, 900)], cover_text: "字", request_id: "g2" });
    const d = await doc(c.id);
    const [f34, f43] = g1.facts as Array<{ fact_id: string }>;
    const sha = (id: string) => d.facts.find((f) => f.id === id)!.sha256;
    const r = await decide(c.id, "pick_cover", { cover_3x4_fact_id: f34.fact_id, cover_3x4_sha: sha(f34.fact_id), cover_4x3_fact_id: f43.fact_id, cover_4x3_sha: sha(f43.fact_id), cover_text: "字" }, env.dir);
    expect(r).toMatchObject({ ok: true, decision: { cover_4x3_sha: sha(f43.fact_id) } });
  });

  it("R3-P2 同一张图同时在 v001、v002：第一次对账两组都记上成员", async () => {
    const c = await editing();
    const root = projectRoot(env, c.id);
    const bytes = png(900, 1200, "shared");
    await put(path.join(root, "05-cover/v001/a.png"), bytes);
    await put(path.join(root, "05-cover/v002/a.png"), bytes);
    await put(path.join(root, "05-cover/v002/b.png"), png(1200, 900, "b"));
    await reconcileAll(env.dir);
    const groups = validCoverGroups(await doc(c.id));
    expect(groups.find((g) => g.group.label === "v002")).toMatchObject({ complete: true });
    expect(groups.find((g) => g.group.label === "v001")?.slots["3:4"]).toHaveLength(1);
  });

  it("R3-P2 先作为候选出现的图，之后在 vNNN/ 里见到同样字节 → 收进那一组", async () => {
    const c = await editing();
    const root = projectRoot(env, c.id);
    const bytes = png(900, 1200, "later");
    await put(path.join(root, "05-cover/exports/a.png"), bytes);
    await reconcileAll(env.dir);
    expect((await doc(c.id)).facts.find((f) => f.kind === "cover")).toMatchObject({ state: "candidate" });
    await put(path.join(root, "05-cover/v003/a.png"), bytes);
    await put(path.join(root, "05-cover/v003/b.png"), png(1200, 900, "b3"));
    await reconcileAll(env.dir);
    expect(validCoverGroups(await doc(c.id)).find((g) => g.group.label === "v003")).toMatchObject({ complete: true });
  });

  it("R3-P2 破例重跑期间来了新计划的检查 → 重跑作废（留档不当前），新检查留在列表，占位释放", async () => {
    const r = await registeredVideo(env);
    await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: planOf(r, [planEntry(r, "xiaohongshu", ["4:3"])]) }, { jev: fakeJev().caller });
    const it = (await items(r.id)).find((i) => i.type === "publish_check")!;
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    const base = fakeJev().caller;
    const slow: JevCaller = async (s, q) => { await gate; return base(s, q); };
    const pending = decideItem({ content_id: r.id, item_id: it.item_id, gen: it.gen, action: "publish_check_override", note: "破例" }, env.dir, { jev: slow });
    await new Promise((ok) => setTimeout(ok, 50));
    const newer = await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: planOf(r, [planEntry(r, "xiaohongshu", ["3:4"])]) }, { jev: fakeJev().caller });
    const newerId = (newer.platforms as Array<{ check_id: string }>)[0].check_id;
    release();
    const out = await pending;
    expect(out).toMatchObject({ ok: false, code: "plan_changed", error: expect.stringContaining("这期间计划变了") });
    const now = (await items(r.id)).find((i) => i.type === "publish_check")!;
    expect(now.detail.check_id).toBe(newerId);
    expect((await doc(r.id)).inbox_log?.some((e) => e.pending)).toBeFalsy();
    const files = await fs.readdir(path.join(r.root, "06-publish/checks"));
    expect(files.filter((f) => f.endsWith(".json")).length).toBeGreaterThanOrEqual(3);
    void founderDecision;
  });
});

describe("Codex 2a-1 第四轮", () => {
  const agent = (p: Record<string, unknown>) => import("../../tools/content-save.js").then((m) => m.executeContentSave({ _dataDir: env.dir, _host: "codex", ...p }) as Promise<Record<string, unknown>>);

  it("R4-1 「去剪辑里改」后重新 mark_ready → 闪帧条目开新代次、重新出现", async () => {
    const c = await editing();
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "三轮回归.mp4"), "cut"), request_id: "c", review: true });
    const sl = (await items(c.id)).find((i) => i.type === "sliver")!;
    expect(sl).toBeDefined();
    expect(await decideItem({ content_id: c.id, item_id: sl.item_id, gen: sl.gen, action: "reject_cut" }, env.dir)).toMatchObject({ ok: true });
    expect((await items(c.id)).find((i) => i.type === "sliver")).toBeUndefined();
    await agent({ action: "mark_ready", content_id: c.id, fact_id: cut.fact_id });
    const again = (await items(c.id)).find((i) => i.type === "sliver");
    expect(again).toBeDefined();
    expect(again!.gen).not.toBe(sl.gen);
  });

  it("R4-2 同一 request_id 换了附件 → request_conflict，不回放", async () => {
    const c = await editing();
    const root = projectRoot(env, c.id);
    const a = await put(path.join(root, "04-edit/a.png"), png(10, 10, "a"));
    const b = await put(path.join(root, "04-edit/b.png"), png(10, 10, "b"));
    const base = { action: "ask", content_id: c.id, request_id: "same", kind: "粗剪", question: "看看", options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }] };
    expect(await agent({ ...base, attachments: [a] })).toMatchObject({ ok: true });
    expect(await agent({ ...base, attachments: [a] })).toMatchObject({ ok: true, replayed: true });
    expect(await agent({ ...base, attachments: [b] })).toMatchObject({ ok: false, code: "request_conflict" });
  });

  it("R4-3 附件变了，agent 转述的回答也拒", async () => {
    const c = await editing();
    const a = await put(path.join(projectRoot(env, c.id), "04-edit/a.png"), png(10, 10, "a"));
    const q = await agent({ action: "ask", content_id: c.id, request_id: "q", kind: "粗剪", question: "看看", options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }], attachments: [a] });
    await put(a, png(10, 10, "changed"));
    expect(await agent({ action: "answer_ask", content_id: c.id, ask_id: q.ask_id, option_id: "ok", founder_quote: "可以" })).toMatchObject({ ok: false, code: "attachments_changed", error: expect.stringContaining("附件变过，请重新发请示") });
  });
});

describe("Codex 2a-1 第五轮", () => {
  const agent = (p: Record<string, unknown>) => import("../../tools/content-save.js").then((m) => m.executeContentSave({ _dataDir: env.dir, _host: "codex", ...p }) as Promise<Record<string, unknown>>);

  it("R5-1 检查之后 agent 改了计划文件：破例拒（不作用在新内容上），条目代次也跟着变", async () => {
    const r = await registeredVideo(env);
    const planFile = path.join(r.root, "06-publish/publish-plan.json");
    await put(planFile, JSON.stringify(planOf(r, [planEntry(r, "xiaohongshu", ["4:3"])])));
    await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: "06-publish/publish-plan.json" }, { jev: fakeJev().caller });
    const it0 = (await items(r.id)).find((i) => i.type === "publish_check")!;
    await put(planFile, JSON.stringify(planOf(r, [planEntry(r, "xiaohongshu", ["4:3"], { title: "偷偷改了标题" })])));
    const it1 = (await items(r.id)).find((i) => i.type === "publish_check")!;
    expect(it1.gen).not.toBe(it0.gen);
    const out = await decideItem({ content_id: r.id, item_id: it1.item_id, gen: it1.gen, action: "publish_check_override", note: "破例" }, env.dir, { jev: fakeJev().caller });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("计划刚改过，按新计划重新检查后再看") });
  });

  it("R5-2 每种条目：把 actions[i].params 原样交回去，不会因为参数本身被拒（stale / bad_request）", async () => {
    const c = await editing();
    await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "三轮回归.mp4"), "cut"), request_id: "c", review: true });
    await record(env, { content_id: c.id, kind: "cover", paths: [await img("a.png", 900, 1200), await img("b.png", 1200, 900)], cover_text: "字", request_id: "g" });
    await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.outside, "x.mp4"), "cand"), request_id: "cand" });
    await agent({ action: "ask", content_id: c.id, request_id: "q", kind: "粗剪", question: "行吗", options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }] });
    await videoContent(env, "另一篇稿");
    const r = await registeredVideo(env);
    await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: planOf(r, [planEntry(r, "douyin", ["3:4"])]) }, { jev: fakeJev().caller });
    const all = (await readInbox(env.dir)).items;
    const types = new Set(all.map((i) => i.type));
    for (const t of ["cut_review", "sliver", "cover_pick", "candidate", "ask", "draft", "publish_check"]) expect(types.has(t as never)).toBe(true);
    for (const it0 of all) {
      for (const [i] of it0.actions.entries()) {
        const cur = (await readInbox(env.dir)).items.find((x) => x.item_id === it0.item_id);
        if (!cur) break;
        const a = cur.actions[i];
        if (!a) continue;
        const res = await decideItem({ content_id: cur.content_id ?? undefined, item_id: cur.item_id, gen: cur.gen, action: a.action, ...a.params, ...(a.note ? { note: "测试" } : {}) }, env.dir, { jev: fakeJev().caller });
        expect([`${cur.type}:${a.action}`, res.code]).not.toEqual([`${cur.type}:${a.action}`, "stale"]);
        expect(res.code, `${cur.type}:${a.action} ${String(res.error)}`).not.toBe("bad_request");
      }
    }
  });

  it("R5-3 撤回转述的回答时，若已有新的同类请示 → 旧的标取代，不重开", async () => {
    const c = await editing();
    const opts = [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }];
    const old = await agent({ action: "ask", content_id: c.id, request_id: "o", kind: "粗剪", question: "行吗", options: opts });
    await agent({ action: "answer_ask", content_id: c.id, ask_id: old.ask_id, option_id: "ok", founder_quote: "可以" });
    const neu = await agent({ action: "ask", content_id: c.id, request_id: "n", kind: "粗剪", question: "新版行吗", options: opts });
    const it = (await items(c.id)).find((x) => x.item_id === `ask:${old.ask_id}`)!;
    expect(await decideItem({ content_id: c.id, item_id: it.item_id, gen: it.gen, action: "undo_ask_answer" }, env.dir)).toMatchObject({ ok: true });
    const asks = (await doc(c.id)).asks!;
    expect(asks.find((a) => a.id === old.ask_id)).toMatchObject({ state: "superseded", superseded_by: neu.ask_id, history: [{ via: "agent_reported" }] });
    expect(asks.filter((a) => a.state === "open").map((a) => a.id)).toEqual([neu.ask_id]);
  });
});
