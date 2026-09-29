/**
 * 验收修复（2026-09-29 verifier）里发布闸门那几条：P2-8 / P2-9 / #12 / #19 / #20，与创始人定的严格把关（决定 2）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { cardPanel } from "../../production/panel.js";
import { reconcileAll } from "../../production/reconcile.js";
import { makeEnv, put, type Env } from "../../production/testkit.js";
import { executePublishCheck } from "./check.js";
import { setCoverRatios, proposePreference } from "./preferences.js";
import { fakeJev, planEntry, planOf, registeredVideo, type Reg } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const PLAN = "06-publish/publish-plan.json";
const writePlan = (r: Reg, platforms: unknown[], extra: Record<string, unknown> = {}) => put(path.join(r.root, PLAN), JSON.stringify({ ...planOf(r, platforms), ...extra }));
type Out = { next_action: string; platforms: Array<{ platform: string; check_id: string; verdict: string; items: Array<{ check: string; result: string; rule?: string; basis: string }> }> };
const run = async (r: Reg, extra: Record<string, unknown> = {}, jev = fakeJev()) =>
  ({ out: await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: PLAN, ...extra }, { jev: jev.caller }) as Out, jev });
const ungated = async (id: string) => ((await cardPanel(id, env.dir)).alerts as string[]).some((a) => a.includes("发布前未把关"));

describe("P2-8 点名平台的指令只问被点名的平台", () => {
  it("「小红书的标题不要带问号」不问抖音；抖音那边记一条「不适用」", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [planEntry(r, "douyin", ["3:4", "4:3"]), planEntry(r, "xiaohongshu", ["3:4"])]);
    const { out, jev } = await run(r, { founder_quotes: ["小红书的标题不要带问号"] });
    const asked = jev.calls.filter((c) => JSON.stringify(c.questions).includes("小红书的标题不要带问号")).map((c) => (c.state as { entry?: { platform: string } }).entry?.platform);
    expect(asked).toEqual(["小红书"]);
    const dy = out.platforms.find((p) => p.platform === "douyin")!;
    expect(dy.items.some((i) => i.result === "info" && i.basis.includes("不适用抖音"))).toBe(true);
  });
});

describe("P2-9 / #20 例外与重复项", () => {
  it("一句原话例外盖住整条封面上传槽规则（缺槽 + 规则外比例）；next_action 指名还拦着的规则", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [planEntry(r, "xiaohongshu", ["4:3"])]);
    const blocked = (await run(r)).out;
    expect(blocked.next_action).toMatch(/小红书：.*cover_ratio/);
    const q = "小红书这次就用横版，我认";
    const { out } = await run(r, { founder_quotes: [q], overrides: [{ platform: "xiaohongshu", rule: "cover_ratio", founder_quote: q }] });
    expect(out.platforms[0].verdict).toBe("override");
  });

  it("结果里同一条拦截不重复", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [planEntry(r, "douyin", ["3:4", "4:3"]), planEntry(r, "douyin", ["3:4", "4:3"])]);
    const { out } = await run(r);
    for (const p of out.platforms) {
      const keys = p.items.map((i) => JSON.stringify([i.check, i.rule, i.basis, i.result]));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("#12 顶层 selected_covers", () => {
  it("封面写在计划顶层：指明要写进每个平台的 covers[]", async () => {
    const r = await registeredVideo(env);
    const bare = { ...planEntry(r, "douyin", ["3:4", "4:3"]) } as Record<string, unknown>;
    delete bare.covers;
    await writePlan(r, [bare], { selected_covers: [{ ratio: "3:4", path: r.c34 }] });
    const { out } = await run(r);
    expect(out.platforms[0].items.some((i) => i.basis.includes("covers: [{usage, ratio, path}]") && i.basis.includes("selected_covers"))).toBe(true);
  });
});

describe("#19 设置里的封面比例", () => {
  it("小红书设 16:9 被拒；提议也拒", async () => {
    expect(await setCoverRatios("xiaohongshu", ["16:9"], env.dir)).toMatchObject({ ok: false });
    expect(await proposePreference({ kind: "cover_ratio", platform: "小红书", value: ["16:9"], founder_quote: "小红书用 16:9" }, "claude-code", env.dir)).toMatchObject({ ok: false, code: "bad_value" });
    expect(await setCoverRatios("xiaohongshu", ["4:3"], env.dir)).toMatchObject({ ok: true });
  });
});

describe("决定 2：严格的发布前把关", () => {
  it("只有定时时间（没有实际提交时间）→ 未把关，哪怕检查早于定时", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [planEntry(r, "douyin", ["3:4", "4:3"])]);
    const { out } = await run(r);
    await writePlan(r, [{ ...planEntry(r, "douyin", ["3:4", "4:3"]), check_id: out.platforms[0].check_id, publication: { status: "scheduled", scheduled_at: "2030-01-01T10:00:00+08:00" } }]);
    await reconcileAll(env.dir);
    expect(await ungated(r.id)).toBe(true);
  });

  it("检查的那份和实际提交的那份不同（检查后改了标题）→ 未把关", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [planEntry(r, "douyin", ["3:4", "4:3"])]);
    const { out } = await run(r);
    await writePlan(r, [{ ...planEntry(r, "douyin", ["3:4", "4:3"], { title: "检查之后改的标题" }), check_id: out.platforms[0].check_id,
      publication: { status: "submitted", submitted_at: new Date(Date.now() + 1000).toISOString() } }]);
    await reconcileAll(env.dir);
    expect(await ungated(r.id)).toBe(true);
  });
});
