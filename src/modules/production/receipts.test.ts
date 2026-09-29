/**
 * 发布回执重写（不可变观察 + 纯函数求值）：seg2 / seg3 / seg4 三轮评审里 Codex 复现过的回执场景全部在这里。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { emptyProductionDoc, type Fact, type ProductionDoc } from "../../storage/production-types.js";
import { readProductionDoc, writeProductionDoc } from "../../storage/production-store.js";
import { deriveStage } from "./derive.js";
import { founderDecision } from "./decisions.js";
import { cardPanel } from "./panel.js";
import { reconcileAll } from "./reconcile.js";
import { importObservations, observationFact, receiptsOfRound, worksOf, type Observation } from "./receipts.js";
import { founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

const plan = (o: Partial<Observation> = {}): Observation => ({ source: "plan", platform: "douyin", pub_state: "public", evidence: "发布计划里的记录", ...o });
const claim = (o: Partial<Observation> = {}): Observation => ({ source: "claim", platform: "douyin", pub_state: "reviewing", evidence: "codex 说已发布", by: { host: "codex" }, ...o });

/** 第二轮的 doc：9 月 20 日重开过 */
function round2(): ProductionDoc {
  const doc = emptyProductionDoc();
  doc.decisions.push({ id: "reopen-1", type: "reopen", round: 1, at: "2026-09-20T00:00:00Z", source: "founder" });
  doc.round = 2;
  return doc;
}
const pushClaim = (doc: ProductionDoc, o: Partial<Observation> = {}) => { const f = observationFact(doc, claim(o), { round: doc.round, round_unsure: undefined }); doc.facts.push(f); return f; };
const live = (doc: ProductionDoc) => receiptsOfRound(doc).live;

describe("回执求值（纯函数）", () => {
  it("[seg2 P1] 模型声明与不同作品的可信回执不互相核实；同作品的可信回执被驳回 → 整件作品是驳回，不命中 D1", () => {
    const doc = emptyProductionDoc();
    pushClaim(doc, { url: "https://a" });
    importObservations(doc, [plan({ item_id: "999", published_at: "2026-09-29T00:00:00Z" })]);
    expect(receiptsOfRound(doc).pending.map((w) => w.url)).toEqual(["https://a"]);
    importObservations(doc, [plan({ url: "https://a", pub_state: "rejected", published_at: "2026-09-29T00:00:00Z" })]);
    const r = receiptsOfRound(doc);
    expect(r.rejected.map((w) => w.url)).toEqual(["https://a"]);
    expect(r.live.map((w) => w.item_id)).toEqual(["999"]);
  });

  it("[seg4 P1] 模型先报、可信回执确认、之后平台驳回：不留下独立有效的旧声明", () => {
    const doc = emptyProductionDoc();
    pushClaim(doc, { url: "https://a" });
    importObservations(doc, [plan({ url: "https://a", pub_state: "public", published_at: "2026-09-29T00:00:00Z" })]);
    expect(live(doc)).toHaveLength(1);
    importObservations(doc, [plan({ url: "https://a", pub_state: "rejected", published_at: "2026-09-29T00:00:00Z" })]);
    expect(live(doc)).toEqual([]);
    expect(deriveStage(doc, "", { verified: false }).rule).not.toBe("D1");
  });

  it("[seg2 P1] 先有链接后补作品 id、审核中变驳回：同一件作品、状态以最后的可信观察为准；观察只追加不改", () => {
    const doc = emptyProductionDoc();
    importObservations(doc, [plan({ url: "https://a", pub_state: "reviewing", published_at: "2026-09-29T00:00:00Z" })]);
    const first = { ...doc.facts[0] };
    importObservations(doc, [plan({ url: "https://a", item_id: "777", pub_state: "rejected", published_at: "2026-09-29T00:00:00Z" })]);
    expect(doc.facts[0]).toEqual(first);
    const ws = worksOf(doc);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ item_id: "777", pub_state: "rejected" });
  });

  it("[seg2 P2] 首次导入按发布时间归轮：重开前发的不算本轮；没有时间又不在第一轮 → 待你确认，不自动核实", () => {
    const doc = round2();
    importObservations(doc, [plan({ item_id: "1", published_at: "2026-09-10T00:00:00Z" })]);
    importObservations(doc, [plan({ platform: "bilibili", item_id: "2" })]);
    const r = receiptsOfRound(doc);
    expect(r.live).toEqual([]);
    expect(r.pending.map((w) => [w.platform, w.round])).toEqual([["bilibili", null]]);
  });

  it("[seg3 P1] 时间不明的回执反复对账：不重复写、也永远不自动核实", () => {
    const doc = round2();
    importObservations(doc, [plan({ item_id: "1" })]);
    expect(importObservations(doc, [plan({ item_id: "1" })])).toBe(0);
    expect(doc.facts).toHaveLength(1);
    expect(receiptsOfRound(doc)).toMatchObject({ live: [], pending: [{ item_id: "1", round: null }] });
  });

  it("[seg3 P1] 本轮已有模型声明，同作品的可信回执发布时间早于重开 → 作品属于上一轮，不核实本轮声明", () => {
    const doc = round2();
    pushClaim(doc, { url: "https://b", platform: "bilibili" });
    importObservations(doc, [plan({ platform: "bilibili", url: "https://b", published_at: "2026-09-10T00:00:00Z" })]);
    const r = receiptsOfRound(doc);
    expect(r.live).toEqual([]);
    expect(r.pending).toEqual([]);
  });

  it("[seg4 P1] 重开后按标题绑上的待核观察 + 同作品、发布时间早于重开的可信回执 → 不当本轮发布", () => {
    const doc = round2();
    importObservations(doc, [{ source: "metrics_title", platform: "douyin", item_id: "55", pub_state: "public", published_at: "2026-09-25T00:00:00Z", evidence: "数据回流按标题猜是这条" }]);
    expect(receiptsOfRound(doc).pending).toHaveLength(1);
    importObservations(doc, [plan({ item_id: "55", published_at: "2026-09-10T00:00:00Z" })]);
    expect(receiptsOfRound(doc)).toMatchObject({ live: [], pending: [] });
  });

  it("[seg4 P2] 旧版本没有链接 / id / 时间的回执被创始人纠正过：升级后再读同一条计划不复活", () => {
    const doc = emptyProductionDoc();
    const legacy: Fact = { id: "legacy-1", kind: "publish", round: 1, state: "accepted", availability: "present", source: "reconcile", at: "2026-09-29T08:00:00Z",
      platform: "douyin", pub_state: "scheduled", verified: true, evidence: "AutoCrew 发布器的发布记录", receipt_key: "douyin|AutoCrew 发布器的发布记录@" };
    doc.facts.push(legacy);
    doc.decisions.push({ id: "c1", type: "publish_correction", round: 1, at: "2026-09-29T09:00:00Z", source: "founder", target_id: "legacy-1" });
    expect(importObservations(doc, [plan({ pub_state: "scheduled" })])).toBe(0);
    expect(live(doc)).toEqual([]);
  });

  it("旧版本因改说法重导出的重复回执：再对账收敛，不累积；显示只有一件作品", () => {
    const doc = emptyProductionDoc();
    const base = { kind: "publish" as const, round: 1, state: "accepted" as const, availability: "present" as const, source: "reconcile" as const, at: "2026-10-06T18:00:00+08:00", platform: "douyin", pub_state: "scheduled" as const, verified: true };
    doc.facts.push({ ...base, id: "old-a", evidence: "AutoCrew 发布器的发布记录", receipt_key: "douyin|AutoCrew 发布器的发布记录@2026-10-06T18:00:00+08:00" });
    doc.facts.push({ ...base, id: "old-b", evidence: "发布计划里的记录", receipt_key: "douyin|@2026-10-06T18:00:00+08:00" });
    expect(importObservations(doc, [plan({ pub_state: "scheduled", published_at: "2026-10-06T18:00:00+08:00" })])).toBe(0);
    expect(worksOf(doc)).toHaveLength(1);
  });
});

describe("回执进面板与决定", () => {
  let env: Env;
  beforeEach(async () => { env = await makeEnv({ enabled: true }); });
  afterEach(async () => { await env.cleanup(); });

  async function published(facts: Fact[]) {
    const c = await videoContent(env, "客户问你们用AI吗");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "客户问你们用AI吗-原片.mov"), "raw"), request_id: "a" });
    const doc = (await readProductionDoc(c.id, env.dir))!;
    doc.facts.push(...facts.map((f) => ({ ...f, round: doc.round })));
    await writeProductionDoc(c.id, env.dir, doc, doc.revision);
    return c;
  }
  const obsFact = (id: string, o: Partial<Observation> & { published_at: string }) => ({ ...observationFact(emptyProductionDoc(), plan(o)), id });

  it("[seg4 P2] 两件作品作品 id 不同、没有链接、时间来源相同：面板两行；纠正一行，另一行照样在", async () => {
    const c = await published([obsFact("w1", { item_id: "111", published_at: "2026-09-29T12:00:00Z" }), obsFact("w2", { item_id: "222", published_at: "2026-09-29T12:00:00Z" })]);
    const p = await cardPanel(c.id, env.dir);
    const rows = p.published as Array<{ id: string; work: string }>;
    expect(rows.map((r) => r.work).sort()).toEqual(["111", "222"]);
    await founderDecision(c.id, "correct_publish", { target_id: rows[0].id }, env.dir);
    const after = (await cardPanel(c.id, env.dir)).published as Array<{ work: string }>;
    expect(after.map((r) => r.work)).toEqual([rows[1].work]);
  });

  it("[seg4 P2] 最近发布记录按真实时间排，时区混排也对", async () => {
    // 20:00+08:00 = 12:00Z，比 13:00Z 早；字典序会排反
    const c = await published([obsFact("east", { platform: "douyin", item_id: "1", published_at: "2026-09-29T20:00:00+08:00" }),
      obsFact("utc", { platform: "bilibili", item_id: "2", published_at: "2026-09-29T13:00:00Z" })]);
    const p = await cardPanel(c.id, env.dir);
    expect((p.published as Array<{ platform: string }>).map((x) => x.platform)).toEqual(["bilibili", "douyin"]);
  });

  it("克隆里那种重复回执：对账收敛，面板一件作品一行", async () => {
    const base = { kind: "publish" as const, round: 1, state: "accepted" as const, availability: "present" as const, source: "reconcile" as const, at: "2026-10-06T18:00:00+08:00", platform: "douyin", pub_state: "scheduled" as const, verified: true };
    const c = await published([
      { ...base, id: "old-a", evidence: "AutoCrew 发布器的发布记录", receipt_key: "douyin|AutoCrew 发布器的发布记录@2026-10-06T18:00:00+08:00" },
      { ...base, id: "old-b", evidence: "发布计划里的记录", receipt_key: "douyin|@2026-10-06T18:00:00+08:00" },
    ]);
    await put(path.join(projectRoot(env, c.id), "06-publish/publish-plan.json"), JSON.stringify({ platforms: [{ platform: "douyin", publication: { status: "scheduled", scheduled_at: "2026-10-06T18:00:00+08:00" } }] }));
    const before = (await readProductionDoc(c.id, env.dir))!.facts.length;
    await reconcileAll(env.dir);
    await reconcileAll(env.dir);
    expect((await readProductionDoc(c.id, env.dir))!.facts.length).toBe(before);
    expect((await cardPanel(c.id, env.dir)).published).toHaveLength(1);
  });
});
