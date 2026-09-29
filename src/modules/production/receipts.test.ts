/**
 * 发布槽模型（每条稿、每轮、每个平台一个槽；创始人 2026-09-29 拍板）。
 * seg2–seg5 评审里的回执场景：靠「认同一件作品」的那些在这个模型里不存在了；仍然适用的都在这里。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { emptyProductionDoc, type Fact, type ProductionDoc } from "../../storage/production-types.js";
import { readProductionDoc, writeProductionDoc } from "../../storage/production-store.js";
import { deriveStage } from "./derive.js";
import { founderDecision } from "./decisions.js";
import { cardPanel } from "./panel.js";
import { reconcileAll } from "./reconcile.js";
import { importObservations, observationFact, receiptsOfRound, slotId, slotOf, type Observation } from "./receipts.js";
import { founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

const plan = (o: Partial<Observation> = {}): Observation => ({ source: "plan", platform: "douyin", pub_state: "public", evidence: "发布计划里的记录", ...o });
const claim = (o: Partial<Observation> = {}): Observation => ({ source: "claim", platform: "douyin", pub_state: "reviewing", evidence: "codex 说已发布", by: { host: "codex" }, ...o });
const T = "2026-09-29T00:00:00Z";

function round2(): ProductionDoc {
  const doc = emptyProductionDoc();
  doc.decisions.push({ id: "reopen-1", type: "reopen", round: 1, at: "2026-09-20T00:00:00Z", source: "founder" });
  doc.round = 2;
  return doc;
}
const stateOf = (doc: ProductionDoc, p = "douyin") => slotOf(doc, doc.round, p);
const dec = (doc: ProductionDoc, d: Partial<ProductionDoc["decisions"][number]> & { type: ProductionDoc["decisions"][number]["type"] }) =>
  doc.decisions.push({ id: `d${doc.decisions.length}`, round: doc.round, at: new Date(Date.now() - 1000 + doc.decisions.length).toISOString(), source: "founder", ...d });

describe("发布槽：状态", () => {
  it("[seg4 P1] AI 先报、可信回执确认、平台驳回：槽是驳回，不命中 D1", () => {
    const doc = emptyProductionDoc();
    importObservations(doc, [claim({ url: "https://a" }), plan({ published_at: T }), plan({ pub_state: "rejected", published_at: T })]);
    expect(stateOf(doc)).toMatchObject({ pub_state: "rejected", by: "trusted" });
    expect(deriveStage(doc, "", { verified: false }).rule).not.toBe("D1");
  });

  it("[seg5 P1] 没有链接 / id 的计划条目：审核中变驳回，同一个槽里最新的算", () => {
    const doc = emptyProductionDoc();
    importObservations(doc, [plan({ pub_state: "reviewing", published_at: T })]);
    importObservations(doc, [plan({ pub_state: "rejected", published_at: T })]);
    expect(receiptsOfRound(doc)).toMatchObject({ live: [], rejected: [{ platform: "douyin" }] });
  });

  it("[seg5 P2] 公开 → 驳回 → 申诉恢复公开：最后的状态算，重新出现的状态不被当成重复跳过", () => {
    const doc = emptyProductionDoc();
    for (const s of ["public", "rejected", "public"] as const) importObservations(doc, [plan({ pub_state: s, published_at: T })]);
    expect(doc.facts).toHaveLength(3);
    expect(stateOf(doc)!.pub_state).toBe("public");
  });

  it("重复读同一份记录：不追加（对账收敛）；删了重发 → 最新的算，早的留在历史", () => {
    const doc = emptyProductionDoc();
    importObservations(doc, [plan({ url: "https://old", published_at: T })]);
    expect(importObservations(doc, [plan({ url: "https://old", published_at: T })])).toBe(0);
    importObservations(doc, [plan({ url: "https://new", published_at: "2026-09-29T02:00:00Z" })]);
    const s = stateOf(doc)!;
    expect(s.url).toBe("https://new");
    expect(s.history).toHaveLength(1);
  });

  it("AI 的说法不靠身份核实：同平台同轮来了可信观察就被顶掉；只有 AI 说法时是待核", () => {
    const doc = emptyProductionDoc();
    importObservations(doc, [claim({ url: "https://a" })]);
    expect(receiptsOfRound(doc).pending).toHaveLength(1);
    importObservations(doc, [plan({ item_id: "999", published_at: T })]);
    expect(stateOf(doc)).toMatchObject({ by: "trusted", item_id: "999" });
  });

  it("[seg5 P2] 创始人确认 AI 说法：保留说法里的提交状态（审核中），不变成已公开", () => {
    const doc = emptyProductionDoc();
    importObservations(doc, [claim({ url: "https://a" })]);
    dec(doc, { type: "publish_confirm", fact_id: doc.facts[0].id });
    expect(stateOf(doc)).toMatchObject({ by: "founder", pub_state: "reviewing", verified: true });
  });
});

describe("发布槽：轮次", () => {
  it("[seg2 P2 / 09-30 保守规则] 重开后：发布时间早于重开 → 上一轮；没有实际提交时间 → 也留上一轮；提交时间晚于重开 → 本轮", () => {
    const doc = round2();
    importObservations(doc, [plan({ published_at: "2026-09-10T00:00:00Z" })]);
    expect(receiptsOfRound(doc).live).toEqual([]);
    importObservations(doc, [plan({ platform: "bilibili" })]);
    expect(receiptsOfRound(doc).live).toEqual([]);
    importObservations(doc, [plan({ platform: "xiaohongshu", submitted_at: "2026-09-21T00:00:00Z" })]);
    expect(receiptsOfRound(doc).live.map((s) => s.platform)).toEqual(["xiaohongshu"]);
  });

  it("[seg3 P1] 本轮 AI 已说发了，同平台可信回执发布时间早于重开 → 回执算上一轮，本轮的 AI 说法仍待核", () => {
    const doc = round2();
    importObservations(doc, [claim({ url: "https://b" }), plan({ url: "https://b", published_at: "2026-09-10T00:00:00Z" })]);
    expect(receiptsOfRound(doc)).toMatchObject({ live: [], pending: [{ platform: "douyin" }] });
  });

  it("[seg5 P1] 第一轮见过的作品，重开后数据回流才按 id 绑上：沿用第一轮，不算本轮发布", () => {
    const doc = emptyProductionDoc();
    importObservations(doc, [plan({ item_id: "55", published_at: "2026-09-10T00:00:00Z" })]);
    doc.decisions.push({ id: "reopen-1", type: "reopen", round: 1, at: "2026-09-20T00:00:00Z", source: "founder" });
    doc.round = 2;
    importObservations(doc, [{ source: "metrics_id", platform: "douyin", item_id: "55", pub_state: "public", evidence: "数据回流按作品 id 对上了这条" }]);
    expect(receiptsOfRound(doc).live).toEqual([]);
  });

  it("[seg5 P2] 轮次不明的待核不会跨轮卡住：重开后新一轮看不到上一轮的待核，也就没有点不动的确认", () => {
    const doc = round2();
    importObservations(doc, [claim({ url: "https://x" })]);
    doc.decisions.push({ id: "reopen-2", type: "reopen", round: 2, at: new Date().toISOString(), source: "founder" });
    doc.round = 3;
    expect(receiptsOfRound(doc).pending).toEqual([]);
  });
});

describe("发布槽：纠正", () => {
  it("纠正指向槽：之前的一切作废；之后新来的照算", () => {
    const doc = emptyProductionDoc();
    importObservations(doc, [plan({ published_at: T })]);
    doc.facts[0].seen_at = "2026-09-01T00:00:00.000Z";
    dec(doc, { type: "publish_correction", target_id: slotId(1, "douyin") });
    expect(receiptsOfRound(doc).live).toEqual([]);
    importObservations(doc, [plan({ url: "https://again", published_at: T })]);
    expect(receiptsOfRound(doc).live).toHaveLength(1);
  });

  it("[seg4 P2] 旧版本按事实 id 纠正过的无身份回执：再读同一条计划不复活", () => {
    const doc = emptyProductionDoc();
    const legacy: Fact = { id: "legacy-1", kind: "publish", round: 1, state: "accepted", availability: "present", source: "reconcile", at: "2026-09-29T08:00:00Z",
      platform: "douyin", pub_state: "scheduled", verified: true, evidence: "AutoCrew 发布器的发布记录", receipt_key: "douyin|AutoCrew 发布器的发布记录@" };
    doc.facts.push(legacy);
    doc.decisions.push({ id: "c1", type: "publish_correction", round: 1, at: "2026-09-29T09:00:00Z", source: "founder", target_id: "legacy-1" });
    // 同一条计划再读到：和流里最后一条（旧事实）一样，不追加，旧纠正仍然有效
    expect(importObservations(doc, [plan({ pub_state: "scheduled" })])).toBe(0);
    expect(receiptsOfRound(doc).live).toEqual([]);
  });
});

describe("发布槽进面板与决定", () => {
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
  const obsFact = (o: Partial<Observation> & { published_at: string }) => observationFact(emptyProductionDoc(), plan(o), 1);

  it("[seg4 P2] 面板一个平台一行，按真实时间排（时区混排）；纠正一行，别的平台不受影响", async () => {
    const c = await published([obsFact({ platform: "douyin", published_at: "2026-09-29T20:00:00+08:00" }), obsFact({ platform: "bilibili", published_at: "2026-09-29T13:00:00Z" })]);
    const rows = (await cardPanel(c.id, env.dir)).published as Array<{ id: string; platform: string }>;
    expect(rows.map((r) => r.platform)).toEqual(["bilibili", "douyin"]);
    await founderDecision(c.id, "correct_publish", { target_id: rows[0].id }, env.dir);
    expect(((await cardPanel(c.id, env.dir)).published as Array<{ platform: string }>).map((r) => r.platform)).toEqual(["douyin"]);
  });

  it("纠正过的「我发了」之后再点：落新决定，重新算已发布", async () => {
    const c = await published([]);
    await founderDecision(c.id, "i_published", { platform: "douyin" }, env.dir);
    await founderDecision(c.id, "correct_publish", { target_id: slotId(1, "douyin") }, env.dir);
    expect(await founderDecision(c.id, "i_published", { platform: "douyin" }, env.dir)).toMatchObject({ ok: true, stage: "已发布" });
  });

  it("克隆里那种重复旧回执：对账两次事实数不变，面板一个平台一行", async () => {
    const base = { kind: "publish" as const, round: 1, state: "accepted" as const, availability: "present" as const, source: "reconcile" as const, at: "2026-10-06T18:00:00+08:00", platform: "douyin", pub_state: "scheduled" as const, verified: true };
    const c = await published([
      { ...base, id: "old-a", evidence: "AutoCrew 发布器的发布记录", receipt_key: "douyin|AutoCrew 发布器的发布记录@2026-10-06T18:00:00+08:00" },
      { ...base, id: "old-b", evidence: "发布计划里的记录", receipt_key: "douyin|@2026-10-06T18:00:00+08:00" },
    ]);
    await put(path.join(projectRoot(env, c.id), "06-publish/publish-plan.json"), JSON.stringify({ platforms: [{ platform: "douyin", publication: { status: "scheduled", scheduled_at: "2026-10-06T18:00:00+08:00" } }] }));
    await reconcileAll(env.dir);
    const once = (await readProductionDoc(c.id, env.dir))!.facts.length;
    await reconcileAll(env.dir);
    expect((await readProductionDoc(c.id, env.dir))!.facts.length).toBe(once);
    expect((await cardPanel(c.id, env.dir)).published).toHaveLength(1);
  });
});
