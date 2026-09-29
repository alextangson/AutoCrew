/**
 * 发布前把关 §11 的三个集成点：按平台出包要有效 check_id；发布槽引用检查（「发布前未把关」不可抹）；例外上卡与时间线。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readTimeline } from "../../../storage/production-store.js";
import { executePublish } from "../../../tools/publish.js";
import { cardPanel } from "../../production/panel.js";
import { reconcileAll } from "../../production/reconcile.js";
import { founderDecision } from "../../production/decisions.js";
import { makeEnv, put, type Env } from "../../production/testkit.js";
import { executePublishCheck } from "./check.js";
import { fakeJev, planEntry, planOf, registeredVideo, type Reg } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const PLAN = "06-publish/publish-plan.json";
async function writePlan(r: Reg, platforms: unknown[]) {
  await put(path.join(r.root, PLAN), JSON.stringify(planOf(r, platforms)));
}
async function check(r: Reg, extra: Record<string, unknown> = {}) {
  const res = await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: PLAN, ...extra }, { jev: fakeJev().caller }) as { platforms: Array<{ platform: string; check_id: string; verdict: string }> };
  return Object.fromEntries(res.platforms.map((p) => [p.platform, p]));
}
const prepare = (r: Reg, ids: unknown) => executePublish({ _dataDir: env.dir, action: "ego_lite_prepare", content_id: r.id, check_ids: ids }) as Promise<Record<string, unknown>>;

describe("§11-1 ego_lite_prepare 按平台出包", () => {
  it("不带 check_id → 指路错误；带有效 check_id → 出包，covers[] 就是检查记录里的；被拦的平台不出包", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [planEntry(r, "douyin", ["3:4", "4:3"]), planEntry(r, "xiaohongshu", ["4:3"])]);
    const c = await check(r);
    expect(c.xiaohongshu.verdict).toBe("block");
    expect(await prepare(r, [])).toMatchObject({ ok: false, code: "check_required" });
    const res = await prepare(r, [c.douyin.check_id, c.xiaohongshu.check_id]) as { ok: boolean; data: { packages: Array<{ platform: string; checkId: string; covers: Array<{ path: string; sha256: string }> }>; refused: Array<{ code: string }> } };
    expect(res.ok).toBe(true);
    expect(res.data.packages.map((p) => p.platform)).toEqual(["douyin"]);
    const record = JSON.parse(await fs.readFile(path.join(r.root, "06-publish/checks", `${c.douyin.check_id}.json`), "utf8"));
    expect(res.data.packages[0].covers).toEqual(record.covers);
    expect(res.data.refused).toEqual([expect.objectContaining({ code: "check_blocked" })]);
  });

  it("检查之后计划改了 → 检查过期，不出包", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [planEntry(r, "douyin", ["3:4", "4:3"])]);
    const c = await check(r);
    await writePlan(r, [planEntry(r, "douyin", ["3:4", "4:3"], { title: "改过的标题" })]);
    expect(await prepare(r, [c.douyin.check_id])).toMatchObject({ ok: false, code: "no_valid_check", refused: [{ code: "check_stale" }] });
  });
});

describe("§11-2 发布槽引用检查 / §11-3 例外上卡", () => {
  it("计划记录带有效 check_id（检查早于提交）→ 没有「发布前未把关」；原话例外上卡与时间线", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [planEntry(r, "xiaohongshu", ["4:3"])]);
    const quote = "这次小红书就用横版，我认";
    const c = await check(r, { founder_quotes: [quote], overrides: [{ platform: "xiaohongshu", rule: "cover_ratio", founder_quote: quote }, { platform: "xiaohongshu", rule: "cover_extra_ratio", founder_quote: quote }] });
    expect(c.xiaohongshu.verdict).toBe("override");
    await writePlan(r, [{ ...planEntry(r, "xiaohongshu", ["4:3"]), check_id: c.xiaohongshu.check_id, publication: { status: "submitted", submitted_at: new Date(Date.now() + 1000).toISOString() } }]);
    await reconcileAll(env.dir);
    const p = await cardPanel(r.id, env.dir);
    expect(p.alerts).not.toContain("小红书发布前未把关");
    expect(p.badges).toContain("小红书发布前例外：『这次小红书就用横版，我认』");
    expect((await readTimeline(r.id, env.dir)).some((e) => e.type === "publish_override")).toBe(true);
  });

  it("没有有效检查就发了 → 「发布前未把关」上卡与时间线；事后补跑的检查抹不掉", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [{ ...planEntry(r, "douyin", ["3:4", "4:3"]), publication: { status: "submitted", submitted_at: "2026-09-01T00:00:00Z" } }]);
    await reconcileAll(env.dir);
    expect((await cardPanel(r.id, env.dir)).alerts).toContain("抖音发布前未把关");
    expect((await readTimeline(r.id, env.dir)).some((e) => e.type === "publish_ungated")).toBe(true);
    await check(r);
    await reconcileAll(env.dir);
    expect((await cardPanel(r.id, env.dir)).alerts).toContain("抖音发布前未把关");
  });

  it("创始人「我发了」前跑过有效检查 → 不标未把关；没跑过 → 标", async () => {
    const r = await registeredVideo(env);
    await founderDecision(r.id, "i_published", { platform: "bilibili" }, env.dir);
    expect((await cardPanel(r.id, env.dir)).alerts).toContain("B站发布前未把关");
    await writePlan(r, [planEntry(r, "douyin", ["3:4", "4:3"])]);
    await check(r);
    await founderDecision(r.id, "i_published", { platform: "douyin" }, env.dir);
    const alerts = (await cardPanel(r.id, env.dir)).alerts as string[];
    expect(alerts).not.toContain("抖音发布前未把关");
  });
});
