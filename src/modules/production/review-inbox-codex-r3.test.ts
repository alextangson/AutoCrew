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
import { validCoverApproval } from "./derive.js";
import { founderDecision } from "./decisions.js";
import { decide, decideItem } from "./inbox-decide.js";
import { readInbox } from "./inbox-read.js";
import { scopedId } from "./inbox.js";
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
    const it = (await items(c.id)).find((x) => x.item_id === scopedId(x.content_id ?? "", `ask:${old.ask_id}`))!;
    expect(await decideItem({ content_id: c.id, item_id: it.item_id, gen: it.gen, action: "undo_ask_answer" }, env.dir)).toMatchObject({ ok: true });
    const asks = (await doc(c.id)).asks!;
    expect(asks.find((a) => a.id === old.ask_id)).toMatchObject({ state: "superseded", superseded_by: neu.ask_id, history: [{ via: "agent_reported" }] });
    expect(asks.filter((a) => a.state === "open").map((a) => a.id)).toEqual([neu.ask_id]);
  });
});

describe("Codex 2a-1 第六轮", () => {
  it("R6-1 一次记的一对落成候选：逐张确认后仍是同一组，出「挑一张」", async () => {
    const c = await editing();
    const r = await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.outside, "a.png"), png(900, 1200, "a")), await put(path.join(env.outside, "b.png"), png(1200, 900, "b"))], cover_text: "字", request_id: "g" });
    const facts = r.facts as Array<{ fact_id: string; state: string }>;
    expect(facts.every((f) => f.state === "candidate")).toBe(true);
    const d = await doc(c.id);
    for (const f of facts) expect(await founderDecision(c.id, "confirm_candidate", { fact_id: f.fact_id, sha256: d.facts.find((x) => x.id === f.fact_id)!.sha256 }, env.dir)).toMatchObject({ ok: true });
    const groups = validCoverGroups(await doc(c.id));
    expect(groups).toHaveLength(1);
    expect(groups[0].complete).toBe(true);
    expect((await items(c.id)).some((i) => i.type === "cover_pick")).toBe(true);
  });

  it("R6-1 一对候选确认一张、否掉一张：组不完整、写还差哪个比例、不出错", async () => {
    const c = await editing();
    const r = await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.outside, "a.png"), png(900, 1200, "a")), await put(path.join(env.outside, "b.png"), png(1200, 900, "b"))], request_id: "g" });
    const [f34, f43] = r.facts as Array<{ fact_id: string }>;
    const d = await doc(c.id);
    const sha = (id: string) => d.facts.find((x) => x.id === id)!.sha256;
    expect(await founderDecision(c.id, "confirm_candidate", { fact_id: f34.fact_id, sha256: sha(f34.fact_id) }, env.dir)).toMatchObject({ ok: true });
    expect(await founderDecision(c.id, "reject_candidate", { fact_id: f43.fact_id, sha256: sha(f43.fact_id) }, env.dir)).toMatchObject({ ok: true });
    const groups = validCoverGroups(await doc(c.id));
    expect(groups).toHaveLength(1);
    expect(groups[0].complete).toBe(false);
    const { explainContent } = await import("./read.js");
    const { getContent } = await import("../../storage/local-store.js");
    expect((await explainContent((await getContent(c.id, env.dir))!, env.dir)).missing).toContain("封面(4:3)");
  });

  it("R6-2 同一对图的两个组：选第二组是新批准（绑第二组），作废保护跟着当前批准走", async () => {
    const c = await editing();
    const a = await img("a.png", 900, 1200), b = await img("b.png", 1200, 900);
    const g1 = await record(env, { content_id: c.id, kind: "cover", paths: [a, b], cover_text: "字", request_id: "g1" });
    // 同两张图不带版本号会并进已有那一组（verifier 2a P2）；要另起一组得显式带版本号
    const g2 = await record(env, { content_id: c.id, kind: "cover", paths: [a, b], cover_text: "字", version: 9, request_id: "g2" });
    expect(g2.group_id).not.toBe(g1.group_id);
    const p1 = await founderDecision(c.id, "pick_cover", { group_id: g1.group_id }, env.dir);
    const p2 = await founderDecision(c.id, "pick_cover", { group_id: g2.group_id }, env.dir);
    expect((p2.decision as { id: string; group_id: string }).group_id).toBe(g2.group_id);
    expect((p2.decision as { id: string }).id).not.toBe((p1.decision as { id: string }).id);
    expect(await founderDecision(c.id, "retire_cover_group", { group_id: g2.group_id }, env.dir)).toMatchObject({ ok: false, code: "cover_group_approved" });
    expect(await founderDecision(c.id, "retire_cover_group", { group_id: g1.group_id }, env.dir)).toMatchObject({ ok: true });
  });
});

describe("Codex 2a-1 第七轮", () => {
  const agent = (p: Record<string, unknown>) => import("../../tools/content-save.js").then((m) => m.executeContentSave({ _dataDir: env.dir, _host: "codex", ...p }) as Promise<Record<string, unknown>>);
  const via = async (c: string, type: string, action: string, extra: Record<string, unknown> = {}) => {
    const it = (await items(c)).find((i) => i.type === type || i.item_id === scopedId(c, type))!;
    const a = it.actions.find((x) => x.action === action)!;
    return decideItem({ content_id: c, item_id: it.item_id, gen: it.gen, action, ...a.params, ...(a.note ? { note: "改" } : {}), ...extra }, env.dir);
  };
  const CONFLICT = { ok: false, code: "already_decided", error: expect.stringContaining("这件事已经在别处定了，刷新再看") };

  it("R7-1 成片：打回之后旧页面再点通过 → 拒；同样的打回 → 回放；没条目也没记录 → 刚变过", async () => {
    const c = await editing();
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "三轮回归.mp4"), "cut"), request_id: "c", review: true });
    const sha = (await doc(c.id)).facts.find((f) => f.id === cut.fact_id)!.sha256;
    expect(await via(c.id, "cut_review", "reject_cut")).toMatchObject({ ok: true });
    expect(await decide(c.id, "approve_cut", { fact_id: cut.fact_id, sha256: sha }, env.dir)).toMatchObject(CONFLICT);
    expect(await decide(c.id, "reject_cut", { fact_id: cut.fact_id, sha256: sha, note: "改" }, env.dir)).toMatchObject({ ok: true, replayed: true });
    expect((await doc(c.id)).decisions.some((d) => d.type === "cut_approval")).toBe(false);
    const other = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.jianying, "三轮回归-2.mp4"), "cut2"), request_id: "c2" });
    const sha2 = (await doc(c.id)).facts.find((f) => f.id === other.fact_id)!.sha256;
    expect(await decide(c.id, "approve_cut", { fact_id: other.fact_id, sha256: sha2 }, env.dir)).toMatchObject({ ok: false });
  });

  it("R7-1 封面、候选、闪帧、请示、稿子：条目消费后旧入口的相反决定一律拒", async () => {
    const c = await editing();
    const g = await record(env, { content_id: c.id, kind: "cover", paths: [await img("a.png", 900, 1200), await img("b.png", 1200, 900)], cover_text: "字", request_id: "g" });
    expect(await via(c.id, "cover_pick", "reject_cover")).toMatchObject({ ok: true });
    expect(await decide(c.id, "pick_cover", { group_id: g.group_id }, env.dir)).toMatchObject(CONFLICT);
    expect(await decide(c.id, "retire_cover_group", { group_id: g.group_id }, env.dir)).toMatchObject(CONFLICT);
    const cand = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.outside, "x.mp4"), "cand"), request_id: "x" });
    const candSha = (await doc(c.id)).facts.find((f) => f.id === cand.fact_id)!.sha256;
    expect(await via(c.id, `cand:${String(cand.fact_id)}`, "reject_candidate")).toMatchObject({ ok: true });
    expect(await decide(c.id, "confirm_candidate", { fact_id: cand.fact_id, sha256: candSha }, env.dir)).toMatchObject(CONFLICT);
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "三轮回归.mp4"), "cut"), request_id: "c", review: true });
    const cutSha = (await doc(c.id)).facts.find((f) => f.id === cut.fact_id)!.sha256;
    expect(await via(c.id, "sliver", "reject_cut")).toMatchObject({ ok: true });
    expect(await decide(c.id, "waive_sliver_check", { cut_sha: cutSha }, env.dir)).toMatchObject(CONFLICT);
    const q = await agent({ action: "ask", content_id: c.id, request_id: "q", kind: "粗剪", question: "行吗", options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }] });
    const ask = (await items(c.id)).find((i) => i.item_id === scopedId(i.content_id ?? "", `ask:${q.ask_id}`))!;
    await decideItem({ content_id: c.id, item_id: ask.item_id, gen: ask.gen, action: "answer_ask", option_id: "ok" }, env.dir);
    expect(await decide(c.id, "answer_ask", { ask_id: q.ask_id, option_id: "no" }, env.dir)).toMatchObject(CONFLICT);
    const d = await videoContent(env, "稿子三");
    expect(await via(d.id, "draft", "revise_script")).toMatchObject({ ok: true });
    expect(await decide(d.id, "approve_script", {}, env.dir)).toMatchObject(CONFLICT);
  });

  it("R7-1 发布：点了「没发」之后，旧入口再确认 AI 的说法 → 拒", async () => {
    const r = await registeredVideo(env);
    await record(env, { content_id: r.id, kind: "publish", platform: "douyin", url: "https://example.com/v/1", request_id: "pub" }, "claude-code");
    const claim = (await items(r.id)).find((i) => i.type === "publish_claim")!;
    const factId = claim.actions[0].params!.fact_id;
    const target = claim.actions[1].params!.target_id;
    expect(await via(r.id, "publish_claim", "correct_publish")).toMatchObject({ ok: true });
    expect(await decide(r.id, "confirm_receipt", { fact_id: factId }, env.dir)).toMatchObject(CONFLICT);
    void target;
  });

  it("R7-2 同样图片的新一组不算已批：出「新的一组封面」条目", async () => {
    const c = await editing();
    const a = await img("a.png", 900, 1200), b = await img("b.png", 1200, 900);
    const g1 = await record(env, { content_id: c.id, kind: "cover", paths: [a, b], cover_text: "字", request_id: "g1" });
    await founderDecision(c.id, "pick_cover", { group_id: g1.group_id }, env.dir);
    const g2 = await record(env, { content_id: c.id, kind: "cover", paths: [a, b], cover_text: "字", version: 9, request_id: "g2" });
    const it = (await items(c.id)).find((i) => i.type === "cover_pick");
    expect(it).toMatchObject({ summary: "新的一组封面做好了，要不要换" });
    expect(it!.actions[0].params!.group_id).toBe(g2.group_id);
  });
});

describe("B7 agent 没标可以审了，创始人要审", () => {
  it("卡片说有几个导出还没说可以审；「我现在就要审」后条目出现，通过照常走「等你拍板」", async () => {
    const c = await editing();
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "三轮回归.mp4"), "cut"), request_id: "c" }, "claude-code");
    const { cardPanel } = await import("./panel.js");
    expect(await cardPanel(c.id, env.dir)).toMatchObject({ unreviewed: { count: 1, editor_label: "Claude" } });
    expect((await items(c.id)).some((i) => i.type === "cut_review")).toBe(false);
    expect(await decide(c.id, "review_now", {}, env.dir)).toMatchObject({ ok: true, fact_id: cut.fact_id, marked: true });
    const it = (await items(c.id)).find((i) => i.type === "cut_review")!;
    expect(it).toBeDefined();
    expect((await cardPanel(c.id, env.dir)).unreviewed).toBeNull();
    const sha = (await doc(c.id)).facts.find((f) => f.id === cut.fact_id)!.sha256!;
    await (await import("./testkit.js")).waiveSliverCheck(env, c.id, sha);
    const fresh = (await items(c.id)).find((i) => i.type === "cut_review")!;
    expect(await decideItem({ content_id: c.id, item_id: fresh.item_id, gen: fresh.gen, action: "approve_cut", ...fresh.actions[0].params }, env.dir)).toMatchObject({ ok: true });
  });
});

describe("整分支审（2a vs main）", () => {
  const byType = async (id: string, t: string) => (await items(id)).find((i) => i.type === t);

  it("撤回成片批准：条目换新代次回来；拿旧代次重交只回放，不复活已撤的批准", async () => {
    const c = await editing();
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "三轮回归.mp4"), "cut"), request_id: "c", review: true });
    const sha = (await doc(c.id)).facts.find((f) => f.id === cut.fact_id)!.sha256!;
    await (await import("./testkit.js")).waiveSliverCheck(env, c.id, sha);
    const it0 = (await byType(c.id, "cut_review"))!;
    const req = { content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "approve_cut", ...it0.actions[0].params };
    const ok = await decideItem(req, env.dir);
    expect(await decide(c.id, "revoke_approval", { decision_id: (ok.decision as { id: string }).id }, env.dir)).toMatchObject({ ok: true });
    const back = await byType(c.id, "cut_review");
    expect(back).toBeDefined();
    expect(back!.gen).not.toBe(it0.gen);
    expect(await decideItem(req, env.dir)).toMatchObject({ ok: true, replayed: true });
    const { validCutApproval } = await import("./derive.js");
    const { getContent } = await import("../../storage/local-store.js");
    expect(validCutApproval(await doc(c.id), (await getContent(c.id, env.dir))!.body)).toBeNull();
  });

  it("撤回封面批准：条目换新代次回来", async () => {
    const c = await editing();
    await record(env, { content_id: c.id, kind: "cover", paths: [await img("a.png", 900, 1200), await img("b.png", 1200, 900)], cover_text: "字", request_id: "g" });
    const it0 = (await byType(c.id, "cover_pick"))!;
    const ok = await decideItem({ content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "pick_cover", ...it0.actions[0].params }, env.dir);
    await decide(c.id, "revoke_approval", { decision_id: (ok.decision as { id: string }).id }, env.dir);
    const back = await byType(c.id, "cover_pick");
    expect(back).toBeDefined();
    expect(back!.gen).not.toBe(it0.gen);
  });

  it("认稿之后退回：「稿子写好了」换新代次回来", async () => {
    const d = await videoContent(env, "退回的稿");
    const it0 = (await items(d.id)).find((i) => i.type === "draft")!;
    await decideItem({ content_id: d.id, item_id: it0.item_id, gen: it0.gen, action: "approve_script" }, env.dir);
    const { executeContentSave } = await import("../../tools/content-save.js");
    await executeContentSave({ _dataDir: env.dir, action: "transition", id: d.id, target_status: "reviewing", force: true });
    await executeContentSave({ _dataDir: env.dir, action: "transition", id: d.id, target_status: "draft_ready", force: true });
    const back = (await items(d.id)).find((i) => i.type === "draft");
    expect(back).toBeDefined();
    expect(back!.gen).not.toBe(it0.gen);
  });

  it("「已经发出去了」之后纠正：「发了吗」换新代次回来", async () => {
    const r = await registeredVideo(env);
    await put(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify({ final_video: { path: r.video }, platforms: [{ platform: "douyin" }] }));
    const it0 = (await byType(r.id, "published_ask"))!;
    expect(await decideItem({ content_id: r.id, item_id: it0.item_id, gen: it0.gen, action: "i_published", ...it0.actions[0].params }, env.dir)).toMatchObject({ ok: true });
    expect(await decide(r.id, "correct_publish", { target_id: "slot:1:douyin" }, env.dir)).toMatchObject({ ok: true });
    const back = await byType(r.id, "published_ask");
    expect(back).toBeDefined();
    expect(back!.gen).not.toBe(it0.gen);
  });

  it("「指定给…」用服务端给的路径，不从页面取", async () => {
    const target = await videoContent(env, "等原片的稿");
    await founderApprove(env, target.id);
    await put(path.join(env.inbox, "IMG_7777.mov"), "unmatched-video");
    await reconcileAll(env.dir);
    const it = (await readInbox(env.dir)).items.find((i) => i.type === "inbox_file")!;
    expect(it).toBeDefined();
    const out = await decideItem({ item_id: it.item_id, gen: it.gen, action: "assign", to: target.id, path: "/etc/passwd" }, env.dir);
    expect(out).toMatchObject({ ok: true });
    expect((await doc(target.id)).facts.some((f) => f.kind === "aroll" && f.state === "accepted")).toBe(true);
  });
});

describe("item_id 全局唯一（整分支审 2）", () => {
  it("两条稿同一轮都有成片、封面：4 件各自独立，决定落到各自的稿", async () => {
    const mk = async (title: string, seed: string) => {
      const c = await videoContent(env, title);
      await founderApprove(env, c.id);
      await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${title}-原片.mov`), `raw-${seed}`), request_id: "a" });
      await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, `${title}.mp4`), `cut-${seed}`), request_id: "c", review: true });
      await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.chatcut, `${seed}a.png`), png(900, 1200, `${seed}a`)), await put(path.join(env.chatcut, `${seed}b.png`), png(1200, 900, `${seed}b`))], cover_text: "字", request_id: "g" });
      return c;
    };
    const a = await mk("第一条同轮稿", "1"), b = await mk("第二条同轮稿", "2");
    const all = (await readInbox(env.dir)).items.filter((i) => i.type === "cut_review" || i.type === "cover_pick");
    expect(all).toHaveLength(4);
    expect(new Set(all.map((i) => i.item_id)).size).toBe(4);
    const cutB = all.find((i) => i.type === "cut_review" && i.content_id === b.id)!;
    expect(await decideItem({ item_id: cutB.item_id, gen: cutB.gen, action: "reject_cut", note: "改", ...cutB.actions[1].params }, env.dir)).toMatchObject({ ok: true });
    expect((await doc(b.id)).decisions.some((d) => d.type === "cut_reject")).toBe(true);
    expect((await doc(a.id)).decisions.some((d) => d.type === "cut_reject")).toBe(false);
    expect((await readInbox(env.dir)).items.find((i) => i.type === "cut_review" && i.content_id === a.id)).toBeDefined();
  });
});

describe("整分支审 3", () => {
  it("请示附件（视频）支持 Range：206 + Content-Range，越界 416；sandbox / nosniff 照带", async () => {
    const c = await editing();
    const { executeContentSave } = await import("../../tools/content-save.js");
    const vid = await put(path.join(projectRoot(env, c.id), "04-edit/样片.mp4"), "0123456789");
    const q = await executeContentSave({ _dataDir: env.dir, _host: "codex", action: "ask", content_id: c.id, request_id: "q", kind: "样片", question: "看看", options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }], attachments: [vid] }) as Record<string, unknown>;
    const { createBoardHandler } = await import("../../desktop/board-route.js");
    const { PassThrough } = await import("node:stream");
    const get = async (range?: string) => {
      const handler = createBoardHandler({ authorize: () => "session", originAllowed: () => true, resolveDataDir: async () => env.dir, readBody: async () => "" });
      const out = new PassThrough();
      let status = 0; let headers: Record<string, string> = {};
      const chunks: Buffer[] = [];
      out.on("data", (b: Buffer) => chunks.push(b));
      const res = Object.assign(out, { writeHead: (s: number, h: Record<string, string>) => { status = s; headers = h ?? {}; return res; } });
      await handler({ method: "GET", headers: range ? { range } : {} } as never, res as never, new URL(`http://x/api/inbox/attachment?content_id=${c.id}&ask_id=${String(q.ask_id)}&index=0`));
      await new Promise((ok) => setTimeout(ok, 30));
      return { status, headers, body: Buffer.concat(chunks).toString() };
    };
    const part = await get("bytes=2-5");
    expect(part).toMatchObject({ status: 206, body: "2345", headers: { "Content-Range": "bytes 2-5/10", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" } });
    expect((await get("bytes=50-60")).status).toBe(416);
    expect((await get()).status).toBe(200);
  });
});

describe("整分支审 4", () => {
  it("v001、v002 共用同一张 3:4：覆盖 v001 那份 → v002 仍完整、批准仍有效；v001 不完整并写原因", async () => {
    const c = await editing();
    const root = projectRoot(env, c.id);
    const shared = png(900, 1200, "shared");
    await put(path.join(root, "05-cover/v001/a.png"), shared);
    await put(path.join(root, "05-cover/v001/b.png"), png(1200, 900, "b1"));
    await put(path.join(root, "05-cover/v002/a.png"), shared);
    await put(path.join(root, "05-cover/v002/b.png"), png(1200, 900, "b2"));
    await reconcileAll(env.dir);
    const g2 = validCoverGroups(await doc(c.id)).find((g) => g.group.label === "v002")!;
    expect(await founderDecision(c.id, "pick_cover", { group_id: g2.group.id, cover_text: "字" }, env.dir)).toMatchObject({ ok: true });
    await put(path.join(root, "05-cover/v001/a.png"), png(900, 1200, "overwritten"));
    await reconcileAll(env.dir);
    const d = await doc(c.id);
    const groups = validCoverGroups(d);
    expect(groups.find((g) => g.group.label === "v002")).toMatchObject({ complete: true, broken: null });
    expect(groups.find((g) => g.group.label === "v001")).toMatchObject({ complete: false, broken: expect.stringContaining("3:4 文件被换过了") });
    const { getContent } = await import("../../storage/local-store.js");
    expect(validCoverApproval(d, (await getContent(c.id, env.dir))!.body)).not.toBeNull();
  });

  it("三个认稿入口带着载入时那一版：别的会话改过正文 → 「稿子刚改过，重新看一眼」", async () => {
    const { executeContentSave } = await import("../../tools/content-save.js");
    const { cardPanel } = await import("./panel.js");
    const { boardData } = await import("../../desktop/board-data.js");
    const { bodyHash } = await import("../../storage/production-store.js");
    const c = await videoContent(env, "认稿入口");
    const card = await cardPanel(c.id, env.dir) as { draft_item: { item_id: string; gen: string } };
    const boardItem = (await boardData(env.dir)).items.find((i) => i.id === c.id)!;
    const loaded = c.body;
    await executeContentSave({ _dataDir: env.dir, action: "update", id: c.id, body: `${loaded}\n别的会话加了一句。` });
    const fromCard = await decideItem({ content_id: c.id, ...card.draft_item, action: "approve_script" }, env.dir);
    expect(fromCard).toMatchObject({ ok: false, error: "稿子刚改过，重新看一眼" });
    const fromBoard = await decideItem({ content_id: c.id, ...boardItem.draftRef!, action: "approve_script" }, env.dir);
    expect(fromBoard).toMatchObject({ ok: false, error: "稿子刚改过，重新看一眼" });
    const fromEditor = await executeContentSave({ _dataDir: env.dir, action: "transition", id: c.id, target_status: "approved", from_status: "draft_ready", force: true, expected_body_hash: bodyHash(loaded) }) as Record<string, unknown>;
    expect(fromEditor).toMatchObject({ ok: false, error: "稿子刚改过，重新看一眼" });
    const { getContent } = await import("../../storage/local-store.js");
    expect((await getContent(c.id, env.dir))!.status).toBe("draft_ready");
  });
});

describe("整分支审 5", () => {
  it("认稿交来的正文哈希和盘上不同（页面显示的是旧正文）→ 拒", async () => {
    const d = await videoContent(env, "显示的那一版");
    const it = (await items(d.id)).find((i) => i.type === "draft")!;
    const { bodyHash } = await import("../../storage/production-store.js");
    expect(await decideItem({ content_id: d.id, item_id: it.item_id, gen: it.gen, action: "approve_script", expected_body_hash: bodyHash("旧的正文") }, env.dir))
      .toMatchObject({ ok: false, error: "稿子刚改过，重新看一眼" });
    const { getContent } = await import("../../storage/local-store.js");
    expect((await getContent(d.id, env.dir))!.status).toBe("draft_ready");
  });
});

describe("整分支审 12", () => {
  it("「还要改…」也按页面上那份正文核：正文刚改过 → 拒，稿子不退回、意见不记", async () => {
    const d = await videoContent(env, "旧页面打回");
    const it = (await items(d.id)).find((i) => i.type === "draft")!;
    const { bodyHash, readProductionDoc } = await import("../../storage/production-store.js");
    expect(await decideItem({ content_id: d.id, item_id: it.item_id, gen: it.gen, action: "revise_script", note: "再改改", expected_body_hash: bodyHash("旧的正文") }, env.dir))
      .toMatchObject({ ok: false, error: "稿子刚改过，重新看一眼" });
    const { getContent } = await import("../../storage/local-store.js");
    expect((await getContent(d.id, env.dir))!.status).toBe("draft_ready");
    expect(((await readProductionDoc(d.id, env.dir))?.decisions ?? []).filter((x) => x.type === "script_revise")).toEqual([]);
  });
});

describe("整分支审 6", () => {
  async function setup() {
    const target = await videoContent(env, "等原片的稿");
    await founderApprove(env, target.id);
    const file = await put(path.join(env.inbox, "IMG_8888.mov"), "bytes-one");
    await reconcileAll(env.dir);
    const it = (await readInbox(env.dir)).items.find((i) => i.type === "inbox_file")!;
    return { target, file, it };
  }
  it("指定给… 成功后，下一次读列表就没有它了；同样的请求重发 = 回放", async () => {
    const { target, it } = await setup();
    const req = { item_id: it.item_id, gen: it.gen, action: "assign", to: target.id };
    expect(await decideItem(req, env.dir)).toMatchObject({ ok: true });
    expect((await readInbox(env.dir)).items.filter((i) => i.type === "inbox_file")).toEqual([]);
    expect(await decideItem(req, env.dir)).toMatchObject({ ok: true, replayed: true });
  });
  it("对账之间收件箱里的文件被换了（同名同大小）：旧代次指定不了新字节", async () => {
    const { target, file, it } = await setup();
    await put(file, "bytes-two");
    expect(await decideItem({ item_id: it.item_id, gen: it.gen, action: "assign", to: target.id }, env.dir)).toMatchObject({ ok: false, code: "stale" });
    expect((await doc(target.id)).facts.some((f) => f.kind === "aroll" && f.state === "accepted")).toBe(false);
  });
});

describe("整分支审 7", () => {
  it("组里一张被覆盖、补进新图后再选：批准有效（只看这条批准绑的那一对）", async () => {
    const c = await editing();
    const g = await record(env, { content_id: c.id, kind: "cover", paths: [await img("a.png", 900, 1200), await img("b.png", 1200, 900)], cover_text: "字", request_id: "g" });
    const f34 = (g.facts as Array<{ path: string }>)[0];
    await put(path.join(projectRoot(env, c.id), f34.path), png(900, 1200, "overwritten"));
    await reconcileAll(env.dir);
    await record(env, { content_id: c.id, kind: "cover", path: await img("c.png", 900, 1200), version: 1, request_id: "patch" });
    const group = validCoverGroups(await doc(c.id)).find((x) => x.group.id === g.group_id)!;
    expect(group.complete).toBe(true);
    expect(await founderDecision(c.id, "pick_cover", { group_id: g.group_id }, env.dir)).toMatchObject({ ok: true });
    const { getContent } = await import("../../storage/local-store.js");
    expect(validCoverApproval(await doc(c.id), (await getContent(c.id, env.dir))!.body)).not.toBeNull();
  });

  it("一对封面重放：两张后来被确认收进组，重放回现在的状态、路径、组", async () => {
    const c = await editing();
    const args = { content_id: c.id, kind: "cover", paths: [await put(path.join(env.outside, "a.png"), png(900, 1200, "a")), await put(path.join(env.outside, "b.png"), png(1200, 900, "b"))], request_id: "pp" };
    const first = await record(env, args);
    expect(first).toMatchObject({ group_id: null, facts: [{ state: "candidate" }, { state: "candidate" }] });
    const d = await doc(c.id);
    for (const f of first.facts as Array<{ fact_id: string }>) await founderDecision(c.id, "confirm_candidate", { fact_id: f.fact_id, sha256: d.facts.find((x) => x.id === f.fact_id)!.sha256 }, env.dir);
    const again = await record(env, args);
    expect(again).toMatchObject({ replayed: true, facts: [{ state: "accepted" }, { state: "accepted" }] });
    expect(again.group_id).toBeTruthy();
    expect(String((again.facts as Array<{ path: string }>)[0].path)).toMatch(/^05-cover\//);
  });
});

describe("verifier 2a 修复（第二批）", () => {
  it("被拦的发布检查：不给「没问题」主按钮，按钮位置写拦的原因", async () => {
    const r = await registeredVideo(env);
    await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: planOf(r, [planEntry(r, "xiaohongshu", ["4:3"])]) }, { jev: fakeJev().caller });
    const it = (await items(r.id)).find((i) => i.type === "publish_check")!;
    expect(it.detail.verdict).toBe("block");
    expect(it.actions.map((a) => a.action)).not.toContain("publish_check_confirm");
    expect(it.blocked_reason).toMatch(/^被拦了：/);
  });

  it("创始人答请示写的一句话，agent 在 asks[] 里拿到全文（不再截成 10 个字）", async () => {
    const c = await editing();
    const { executeContentSave } = await import("../../tools/content-save.js");
    const q = await executeContentSave({ _dataDir: env.dir, _host: "codex", action: "ask", content_id: c.id, request_id: "q", kind: "粗剪", question: "行吗", options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }] }) as Record<string, unknown>;
    const it = (await items(c.id)).find((i) => i.type === "ask")!;
    const note = "开头那段客户问话留着，后面两段重复的解释删掉一段，结尾那句金句前面停半拍。";
    await decideItem({ content_id: c.id, item_id: it.item_id, gen: it.gen, action: "answer_ask", option_id: "no", note }, env.dir);
    const s = await executeContentSave({ _dataDir: env.dir, _host: "codex", action: "summary", id: c.id }) as Record<string, unknown>;
    expect((s.asks as Array<{ note?: string }>)[0].note).toBe(note);
    void q;
  });
});

describe("verifier 2a 修复（第三批）", () => {
  it("剪映导出目录和资料库重叠 → 拒（与监视文件夹同一规矩）", async () => {
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "jy-")));
    const lib = path.join(tmp, "lib"), machine = path.join(tmp, "machine"), outside = path.join(tmp, "exports");
    for (const d of [path.join(lib, "inner"), machine, outside]) await fsp.mkdir(d, { recursive: true });
    await fsp.writeFile(path.join(machine, "storage.json"), JSON.stringify({ version: 1, id: "lib-abc", root: lib }));
    const old = process.env.AUTOCREW_LOCAL_DIR;
    process.env.AUTOCREW_LOCAL_DIR = machine;
    try {
      const { jianyingDirError } = await import("../../desktop/settings-video.js");
      expect(await jianyingDirError(path.join(lib, "inner"))).toContain("和资料库重叠");
      expect(await jianyingDirError(tmp)).toContain("和资料库重叠");
      expect(await jianyingDirError(outside)).toBeNull();
    } finally {
      if (old === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = old;
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("被「不是」挪回收件箱的原片：列头「收件箱里没对上」里看得见", async () => {
    const c = await videoContent(env, "挪回收件箱测试稿");
    await founderApprove(env, c.id);
    await put(path.join(env.inbox, "挪回收件箱测试稿.mov"), "take-x");
    await reconcileAll(env.dir);
    const f = (await doc(c.id)).facts.find((x) => x.kind === "aroll" && x.state === "accepted")!;
    expect(f).toBeDefined();
    expect(await founderDecision(c.id, "undo_auto_attach", { fact_id: f.id, sha256: f.sha256 }, env.dir)).toMatchObject({ ok: true });
    const report = await reconcileAll(env.dir);
    expect(report.inbox?.unmatched.map((u) => u.name)).toContain("挪回收件箱测试稿.mov");
  });
});
