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
