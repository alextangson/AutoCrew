/**
 * seg6 Codex 评审（5 P1 + 5 P2）与两条 UI 反馈的回归：每条一个测试。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { productionServiceDir, writeEnabledVersion } from "../../../storage/production-store.js";
import { emptyProductionDoc } from "../../../storage/production-types.js";
import { executePublish } from "../../../tools/publish.js";
import { cardPanel } from "../../production/panel.js";
import { reconcileAll } from "../../production/reconcile.js";
import { founderDecision } from "../../production/decisions.js";
import { importObservations, slotId, slotOf, type Observation } from "../../production/receipts.js";
import { makeEnv, put, type Env } from "../../production/testkit.js";
import { executePublishCheck } from "./check.js";
import { prepareEgoLitePublish } from "../ego-lite.js";
import { fakeJev, planEntry, planOf, registeredVideo, type Reg } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const PLAN = "06-publish/publish-plan.json";
const writePlan = (r: Reg, platforms: unknown[], extra: Record<string, unknown> = {}) => put(path.join(r.root, PLAN), JSON.stringify({ ...planOf(r, platforms), ...extra }));
type CheckOut = { blocked_platforms: string[]; platforms: Array<{ platform: string; check_id: string; verdict: string }> };
async function check(r: Reg, extra: Record<string, unknown> = {}) {
  const res = await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: PLAN, ...extra }, { jev: fakeJev().caller }) as CheckOut;
  return { res, by: Object.fromEntries(res.platforms.map((p) => [p.platform, p])) };
}
type PrepOut = { ok: boolean; code?: string; refused?: Array<{ code: string }>; data?: { packages: Array<{ covers: Array<{ path: string; sha256: string }>; schedule?: string }>; videoPath?: string } };
const prepare = (r: Reg, extra: Record<string, unknown>) => executePublish({ _dataDir: env.dir, action: "ego_lite_prepare", content_id: r.id, ...extra }) as Promise<PrepOut>;
const douyin = (r: Reg, extra: Record<string, unknown> = {}) => planEntry(r, "douyin", ["3:4", "4:3"], extra);

describe("seg6 P1", () => {
  it("[P1 check.ts:186] 检查后改了封面字（指纹不一定变）：按现在的计划重判被拦 → 旧 check_id 不出包", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [douyin(r)]);
    const { by } = await check(r);
    expect(by.douyin.verdict).not.toBe("block");
    await writePlan(r, [douyin(r, { cover_text: "和登记不一样的封面字" })]);
    const out = await prepare(r, { check_ids: [by.douyin.check_id] });
    expect(out).toMatchObject({ ok: false, code: "no_valid_check" });
    expect(["check_blocked", "check_stale"]).toContain(out.refused![0].code);
  });

  it("[P1 receipts.ts:70] 定时帖：提交后、公开前补跑检查，状态变公开也不算把关过（按实际提交时间，继承首次结论）", async () => {
    const r = await registeredVideo(env);
    const submitted = new Date().toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await writePlan(r, [douyin(r, { publication: { status: "scheduled", scheduled_at: future, submitted_at: submitted } })]);
    await reconcileAll(env.dir);
    expect((await cardPanel(r.id, env.dir)).alerts).toContain("1 个平台发布前未把关");
    await check(r);
    await writePlan(r, [douyin(r, { publication: { status: "public", published_at: future, submitted_at: submitted } })]);
    await reconcileAll(env.dir);
    expect((await cardPanel(r.id, env.dir)).alerts).toContain("1 个平台发布前未把关");
  });

  it("[P1 check.ts:190] 计划换成另一目录同字节的封面副本：包里的封面就是这次核过的那份（路径 + sha）", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [douyin(r)]);
    const { by } = await check(r);
    const copy = path.join("07-delivery", "copy", path.basename(r.c34));
    await fs.mkdir(path.join(r.root, "07-delivery", "copy"), { recursive: true });
    await fs.copyFile(path.join(r.root, r.c34), path.join(r.root, copy));
    const moved = douyin(r);
    moved.covers[0].path = copy;
    await writePlan(r, [moved]);
    const out = await prepare(r, { check_ids: [by.douyin.check_id] });
    expect(out.ok).toBe(true);
    expect(out.data!.packages[0].covers[0].path).toBe(copy);
  });

  it("[P1 ego-lite.ts:168] 检查的是另一版成片（原话例外）：发布包拒绝，不静默换回登记成片", async () => {
    const r = await registeredVideo(env);
    await put(path.join(r.root, "07-delivery/other.mp4"), "other-cut");
    const q = "这次发另一版，我认";
    await writePlan(r, [douyin(r)], { final_video: { path: "07-delivery/other.mp4" } });
    const { by } = await check(r, { founder_quotes: [q], overrides: [{ platform: "douyin", rule: "cut_registered", founder_quote: q }] });
    expect(by.douyin.verdict).toBe("override");
    const out = await prepare(r, { check_ids: [by.douyin.check_id] });
    expect(out).toMatchObject({ ok: false, refused: [{ code: "video_not_checked" }] });
  });

  it("[P1 publish.ts:156] 启用前旧调用方照旧单包出；启用后必须带 check_ids", async () => {
    const r = await registeredVideo(env);
    await fs.rm(productionServiceDir(env.dir, "enabled.json"));
    // 启用前走旧的单包出口，结果与直接调旧函数一致（这条旧流程下没过封面评审，旧出口照旧报它自己的错），不要 check_ids
    const legacy = await prepare(r, {});
    const direct = await prepareEgoLitePublish(r.id, env.dir).then((data) => ({ ok: true, data }), (e: Error) => ({ ok: false, error: e.message }));
    expect(legacy).toEqual(direct);
    expect(legacy.code).toBeUndefined();
    await writeEnabledVersion(env.dir);
    expect(await prepare(r, {})).toMatchObject({ ok: false, code: "check_required" });
  });
});

describe("seg6 P2", () => {
  it("[P2 ego-lite.ts:165] prepare 的 schedule 不能覆盖检查过的排期", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [douyin(r)]);
    const { by } = await check(r);
    expect(await prepare(r, { check_ids: [by.douyin.check_id], schedule: "this is not a time" })).toMatchObject({ ok: false, refused: [{ code: "schedule_not_checked" }] });
  });

  it("[P2 check.ts:97] 计划级阻断（空条目）传到出包：平台条目 pass 也不出包", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [douyin(r), null]);
    const { res, by } = await check(r);
    expect(res.blocked_platforms).toContain("plan");
    expect(await prepare(r, { check_ids: [by.douyin.check_id] })).toMatchObject({ ok: false, refused: [{ code: "check_blocked" }] });
  });

  it("[P2 receipts.ts:130] 同轮同平台两条静态绑定：反复对账不增长；纠正后原样再读不复活", () => {
    const doc = emptyProductionDoc();
    const a: Observation = { source: "metrics_id", platform: "douyin", item_id: "A", pub_state: "public", evidence: "数据回流" };
    const b: Observation = { ...a, item_id: "B" };
    for (let i = 0; i < 3; i++) importObservations(doc, [a, b]);
    expect(doc.facts).toHaveLength(1);
    doc.decisions.push({ id: "c1", type: "publish_correction", target_id: slotId(1, "douyin"), round: 1, at: new Date(Date.now() + 1000).toISOString(), source: "founder" });
    expect(importObservations(doc, [a, b])).toBe(0);
    expect(slotOf(doc, 1, "douyin")).toBeNull();
  });

  it("[P2 check.ts:180] inline 计划：留档存快照，出包按快照核（默认计划文件不存在也能出）", async () => {
    const r = await registeredVideo(env);
    const res = await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: planOf(r, [douyin(r)]) }, { jev: fakeJev().caller }) as CheckOut;
    const out = await prepare(r, { check_ids: [res.platforms[0].check_id] });
    expect(out.ok).toBe(true);
  });

  it("[P2 receipts.ts:204] 「我发了」贴的作品链接进槽、上面板", async () => {
    const r = await registeredVideo(env);
    await founderDecision(r.id, "i_published", { platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx" }, env.dir);
    const p = await cardPanel(r.id, env.dir);
    expect((p.published as Array<{ url: string | null }>)[0].url).toBe("https://www.bilibili.com/video/BV1xx");
  });
});

describe("seg6 UI", () => {
  it("[UI-1] 多平台未把关：卡上只汇总一句，平台标在各自回执行上各一次", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, ["douyin", "bilibili"].map((p) => planEntry(r, p, ["3:4", "4:3"], { publication: { status: "submitted", submitted_at: new Date().toISOString() } })));
    await reconcileAll(env.dir);
    const p = await cardPanel(r.id, env.dir);
    expect((p.alerts as string[]).filter((a) => a.includes("发布前未把关"))).toEqual(["2 个平台发布前未把关"]);
    const rows = p.published as Array<{ label: string }>;
    expect(rows.map((x) => x.label.split("发布前未把关").length - 1)).toEqual([1, 1]);
  });

  it("[UI-2] 启用（闸门存在）之前提交的发布不标未把关，只留「未登记就发布」类提示", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [douyin(r, { publication: { status: "submitted", submitted_at: "2026-09-01T00:00:00Z" } })]);
    await reconcileAll(env.dir);
    const p = await cardPanel(r.id, env.dir);
    expect((p.alerts as string[]).some((a) => a.includes("发布前未把关"))).toBe(false);
    expect((p.published as Array<{ ungated: boolean }>)[0].ungated).toBe(false);
  });
});

describe("seg7 发布槽的把关继承与轮次", () => {
  it("[P1 receipts.ts:143] 首次未把关后补检并给计划补 check_id：不翻案；「我发了」的首次结论后来的可信观察也继承", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [douyin(r, { publication: { status: "submitted" } })]);
    await reconcileAll(env.dir);
    const { by } = await check(r);
    await writePlan(r, [douyin(r, { check_id: by.douyin.check_id, publication: { status: "public" } })]);
    await reconcileAll(env.dir);
    expect((await cardPanel(r.id, env.dir)).alerts).toContain("1 个平台发布前未把关");
    await founderDecision(r.id, "i_published", { platform: "bilibili" }, env.dir);
    await check(r);
    await writePlan(r, [douyin(r, { check_id: by.douyin.check_id, publication: { status: "public" } }), planEntry(r, "bilibili", ["3:4", "4:3"], { publication: { status: "public" } })]);
    await reconcileAll(env.dir);
    expect((await cardPanel(r.id, env.dir)).alerts).toContain("2 个平台发布前未把关");
  });

  it("[P1 receipts.ts:132] 重开后同批读到旧计划与它的作品 id 绑定：两条都归上一轮，新一轮不算已发布", () => {
    const doc = emptyProductionDoc();
    doc.decisions.push({ id: "reopen-1", type: "reopen", round: 1, at: "2026-09-20T00:00:00Z", source: "founder" });
    doc.round = 2;
    importObservations(doc, [
      { source: "plan", platform: "douyin", item_id: "OLD", pub_state: "public", published_at: "2026-09-10T00:00:00Z", evidence: "计划" },
      { source: "metrics_id", platform: "douyin", item_id: "OLD", pub_state: "public", evidence: "数据回流" },
    ]);
    expect(doc.facts.map((f) => f.round)).toEqual([1, 1]);
    expect(slotOf(doc, 2, "douyin")).toBeNull();
  });

  it("[P2 receipts.ts:158] 纠正之后的新提交不继承纠正前的结论", () => {
    const doc = emptyProductionDoc();
    const old: Observation = { source: "plan", platform: "douyin", item_id: "A", pub_state: "public", evidence: "计划", gate: { ok: false, overrides: [], applies: false } };
    importObservations(doc, [old]);
    doc.decisions.push({ id: "c1", type: "publish_correction", target_id: slotId(1, "douyin"), round: 1, at: new Date(Date.now() - 2000).toISOString(), source: "founder" });
    doc.facts[0].seen_at = new Date(Date.now() - 5000).toISOString();
    importObservations(doc, [{ ...old, item_id: "B", gate: { ok: false, overrides: [], applies: true } }]);
    expect(slotOf(doc, 1, "douyin")?.gate).toMatchObject({ applies: true });
  });

  it("[P2 receipts.ts:72] 启用后才发现、公开时间早于启用的历史作品：不标未把关", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [douyin(r, { publication: { status: "public", published_at: "2020-01-01T00:00:00Z" } })]);
    await reconcileAll(env.dir);
    expect((await cardPanel(r.id, env.dir)).alerts.some((a: string) => a.includes("发布前未把关"))).toBe(false);
  });
});
