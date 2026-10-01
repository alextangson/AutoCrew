/**
 * 等你拍板 2a-1 Codex 会审 5 条 P2 的回归（~/.cache/autocrew-yt/review-inbox/codex-review-2a1.txt）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../storage/local-store.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { executeContentSave } from "../../tools/content-save.js";
import { executePublishCheck } from "../publish/review-gate/check.js";
import { fakeJev, planEntry, planOf, registeredVideo } from "../publish/review-gate/testkit.js";
import type { JevCaller } from "../publish/review-gate/jev-client.js";
import { validCoverGroups } from "./cover-groups.js";
import { validCoverApproval } from "./derive.js";
import { founderDecision } from "./decisions.js";
import { decideItem } from "./inbox-decide.js";
import { readInbox } from "./inbox-read.js";
import { reconcileAll } from "./reconcile.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const doc = async (id: string) => (await readProductionDoc(id, env.dir))!;
const items = async (id: string) => (await readInbox(env.dir, { contentId: id })).items;
async function editing() {
  const c = await videoContent(env, "会审回归");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "会审回归-原片.mov"), "raw"), request_id: "a" });
  return c;
}
const img = (n: string, w: number, h: number) => put(path.join(env.chatcut, n), png(w, h, n));

describe("Codex 2a-1 P2", () => {
  it("P2-1 打回新组不连带作废用了同一张图的已批组", async () => {
    const c = await editing();
    const a = await img("a.png", 900, 1200);
    const g1 = await record(env, { content_id: c.id, kind: "cover", paths: [a, await img("b.png", 1200, 900)], cover_text: "字", request_id: "g1" });
    await founderDecision(c.id, "pick_cover", { group_id: g1.group_id }, env.dir);
    await record(env, { content_id: c.id, kind: "cover", paths: [a, await img("c.png", 1200, 900)], cover_text: "字", request_id: "g2" });
    const it = (await items(c.id)).find((i) => i.type === "cover_pick")!;
    expect(await decideItem({ content_id: c.id, item_id: it.item_id, gen: it.gen, action: "reject_cover", note: "这组不好" }, env.dir)).toMatchObject({ ok: true });
    const body = (await getContent(c.id, env.dir))!.body;
    expect(validCoverApproval(await doc(c.id), body)).not.toBeNull();
  });

  it("P2-2 作废的组对账后不复活；同目录新来的图只做候选", async () => {
    const c = await editing();
    const g = await record(env, { content_id: c.id, kind: "cover", paths: [await img("a.png", 900, 1200), await img("b.png", 1200, 900)], request_id: "g" });
    expect(await founderDecision(c.id, "retire_cover_group", { group_id: g.group_id }, env.dir)).toMatchObject({ ok: true });
    await reconcileAll(env.dir);
    expect(validCoverGroups(await doc(c.id))).toEqual([]);
    const dir = path.dirname(path.join(projectRoot(env, c.id), (g.facts as Array<{ path: string }>)[0].path));
    await put(path.join(dir, "new.png"), png(900, 1200, "new"));
    await reconcileAll(env.dir);
    expect(validCoverGroups(await doc(c.id))).toEqual([]);
    expect((await doc(c.id)).facts.find((f) => f.path?.endsWith("new.png"))).toMatchObject({ state: "candidate" });
  });

  it("P2-3 破例重跑期间：同代次的相反决定被拒，同样的请求回放同一结果", async () => {
    const r = await registeredVideo(env);
    await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: planOf(r, [planEntry(r, "xiaohongshu", ["4:3"])]) }, { jev: fakeJev().caller });
    const it = (await items(r.id)).find((i) => i.type === "publish_check")!;
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    const base = fakeJev().caller;
    const slow: JevCaller = async (s, q) => { await gate; return base(s, q); };
    const req = { content_id: r.id, item_id: it.item_id, gen: it.gen, action: "publish_check_override", note: "这次横版就行" };
    const first = decideItem(req, env.dir, { jev: slow });
    await new Promise((ok) => setTimeout(ok, 50));
    expect(await decideItem({ ...req, action: "publish_check_confirm", note: undefined }, env.dir)).toMatchObject({ ok: false, code: "already_decided" });
    const second = decideItem(req, env.dir, { jev: slow });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true, check_id: a.check_id });
  });

  it("P2-3 破例重跑失败：释放占位，看得见原因，之后能再点", async () => {
    const r = await registeredVideo(env);
    const planFile = path.join(r.root, "06-publish/publish-plan.json");
    await put(planFile, JSON.stringify(planOf(r, [planEntry(r, "xiaohongshu", ["4:3"])])));
    await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: "06-publish/publish-plan.json" }, { jev: fakeJev().caller });
    const it = (await items(r.id)).find((i) => i.type === "publish_check")!;
    await fs.rm(planFile);
    const req = { content_id: r.id, item_id: it.item_id, gen: it.gen, action: "publish_check_override", note: "破例" };
    // 计划文件没了：条目代次随计划输入变了（r5 P1），这次直接拒、不占位；锁外失败后释放占位由 r3 的 plan_changed 用例覆盖
    const failed = await decideItem(req, env.dir, { jev: fakeJev().caller });
    expect(failed).toMatchObject({ ok: false });
    expect((await doc(r.id)).inbox_log?.some((e) => e.item_id === it.item_id)).toBeFalsy();
    const fresh = (await items(r.id)).find((i) => i.type === "publish_check")!;
    // 被拦的检查只给「有几处要改…」/ 破例（verifier 2a P2）
    expect(await decideItem({ content_id: r.id, item_id: fresh.item_id, gen: fresh.gen, action: "publish_check_revise", note: "改" }, env.dir)).toMatchObject({ ok: true });
  });

  it("P2-4 打回后对同一版重新 mark_ready → 开新代次，条目回来", async () => {
    const c = await editing();
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "会审回归.mp4"), "cut"), request_id: "c", review: true });
    const it = (await items(c.id)).find((i) => i.type === "cut_review")!;
    await decideItem({ content_id: c.id, item_id: it.item_id, gen: it.gen, action: "reject_cut", note: "再改" }, env.dir);
    expect((await items(c.id)).find((i) => i.type === "cut_review")).toBeUndefined();
    const again = await executeContentSave({ _dataDir: env.dir, _host: "codex", action: "mark_ready", content_id: c.id, fact_id: cut.fact_id }) as Record<string, unknown>;
    expect(again).toMatchObject({ ok: true, marked: true });
    expect(again.note).toBeUndefined();
    expect((await items(c.id)).find((i) => i.type === "cut_review")).toBeDefined();
  });

  it("P2-5 中转端点弄坏的内层引号：options / attachments / paths 都修得回来", async () => {
    const c = await editing();
    const mangled = '[{"id":"keep","label":"保留"AI"标题"},{"id":"drop","label":"不要"}]';
    const q = await executeContentSave({ _dataDir: env.dir, _host: "codex", action: "ask", content_id: c.id, request_id: "q1", kind: "其他", question: "标题？", options: mangled }) as Record<string, unknown>;
    expect(q).toMatchObject({ ok: true });
    expect((await doc(c.id)).asks![0].options[0].label).toBe('保留"AI"标题');
    const f = await put(path.join(projectRoot(env, c.id), '04-edit/a"b".png'), png(10, 10));
    const q2 = await executeContentSave({ _dataDir: env.dir, _host: "codex", action: "ask", content_id: c.id, request_id: "q2", kind: "样片", question: "看看", options: '[{"id":"a","label":"一"},{"id":"b","label":"二"}]', attachments: `[{"path":"${f}"}]` }) as Record<string, unknown>;
    expect(q2).toMatchObject({ ok: true });
    const a = await put(path.join(env.chatcut, 'x"1".png'), png(900, 1200, "x")), b = await img("y.png", 1200, 900);
    expect(await record(env, { content_id: c.id, kind: "cover", paths: `["${a}","${b}"]`, request_id: "gp" })).toMatchObject({ ok: true });
  });
});
