/**
 * 数据回流按标题猜的回执自动对上（创始人 2026-10-25）：平台 + 时间窗 + 唯一候选全对上才替他点「对，发了」，
 * 记法和他点的一样（publish_confirm），来源 auto 带证据；卡上写「自动对上：…，不对就纠正」，纠正照旧。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { planEntry, planOf, registeredVideo, type Reg } from "../publish/review-gate/testkit.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { getContent } from "../../storage/local-store.js";
import { appendOutcomes } from "../flywheel/outcome-store.js";
import { commitBindings } from "../flywheel/platform-items.js";
import { judgeAutoMatch, type AutoMatchFacts } from "./auto-match.js";
import { reconcileContent } from "./reconcile.js";
import { explainContent } from "./read.js";
import { founderDecision } from "./decisions.js";
import { readInbox } from "./inbox-read.js";
import { makeEnv, setContent, videoContent, type Env } from "./testkit.js";

const H = 3600_000;
const T0 = "2026-10-02T10:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * H).toISOString();

describe("judgeAutoMatch（纯判定）", () => {
  const base: AutoMatchFacts = { platform: "douyin", item_id: "7001", work_published_at: at(1), work_title: "t", plan_at: T0, content_published_at: null,
    candidates: [{ id: "c1", score: 1 }], content_id: "c1" };
  it("计划时间 ±2 小时内、唯一候选：对上，证据齐", () => {
    expect(judgeAutoMatch(base)).toEqual({ ok: true, evidence: { platform: "douyin", item_id: "7001", work_published_at: at(1), expected_at: T0, expected_kind: "plan_slot", title_score: 1 } });
    expect(judgeAutoMatch({ ...base, work_published_at: at(-2) }).ok).toBe(true);
  });
  it("超出 2 小时 / 两个候选 / 唯一候选是别的稿 / 作品没时间：不对上", () => {
    expect(judgeAutoMatch({ ...base, work_published_at: at(2.1) })).toMatchObject({ ok: false });
    expect(judgeAutoMatch({ ...base, candidates: [{ id: "c1", score: 1 }, { id: "c2", score: 0.7 }] })).toMatchObject({ ok: false, reason: "够像的候选稿有 2 篇" });
    expect(judgeAutoMatch({ ...base, candidates: [{ id: "c2", score: 1 }] }).ok).toBe(false);
    expect(judgeAutoMatch({ ...base, work_published_at: null }).ok).toBe(false);
  });
  it("计划没时间：稿件发布后 24 小时内才对上；之前、超过都不对上；两样都没有 = 只有标题", () => {
    const noPlan = { ...base, plan_at: null, content_published_at: T0 };
    expect(judgeAutoMatch({ ...noPlan, work_published_at: at(23) })).toMatchObject({ ok: true, evidence: { expected_kind: "content_published" } });
    expect(judgeAutoMatch({ ...noPlan, work_published_at: at(25) }).ok).toBe(false);
    expect(judgeAutoMatch({ ...noPlan, work_published_at: at(-1) }).ok).toBe(false);
    expect(judgeAutoMatch({ ...noPlan, content_published_at: null })).toMatchObject({ ok: false, reason: "发布计划没写时间、稿件也没记发布时间（只有标题）" });
  });
});

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

/** 计划里写了抖音定时但没投出（不是可信观察）；回流按标题绑上了作品 7001 */
async function scenario(r: Reg, workAt: string, planAt = T0) {
  await fs.mkdir(path.join(r.root, "06-publish"), { recursive: true });
  await fs.writeFile(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify(planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"], { scheduled_at: planAt })])));
  const c = (await getContent(r.id, env.dir))!;
  await appendOutcomes([{ contentId: r.id, platform: "douyin", platformTitle: c.title, publishedAt: workAt, metricDate: workAt.slice(0, 10), platformItemId: "7001",
    metrics: { views: 10 }, source: "auto", recordedAt: new Date().toISOString(), needsReview: false, reviewReasons: [] }], env.dir);
  await commitBindings([{ platform: "douyin", itemId: "7001", contentId: r.id, via: "title" }], env.dir);
  await reconcileContent(r.id, env.dir);
}
const confirms = async (id: string) => (await readProductionDoc(id, env.dir))!.decisions.filter((d) => d.type === "publish_confirm");
const claims = async (id: string) => (await readInbox(env.dir, { contentId: id, withDrafts: true })).items.filter((i) => i.type === "publish_claim");

describe("对账里自动对上", () => {
  it("全对上：记 publish_confirm（来源 auto + 证据），已发布，卡上有「自动对上」，不进收件箱；重复对账不重写", async () => {
    const r = await registeredVideo(env);
    await scenario(r, at(1));
    const ds = await confirms(r.id);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ source: "auto", platform: "douyin", auto_match: { platform: "douyin", item_id: "7001", work_published_at: at(1), expected_at: T0, expected_kind: "plan_slot", title_score: 1 } });
    const exp = await explainContent((await getContent(r.id, env.dir))!, env.dir);
    expect(exp.stage).toBe("已发布");
    expect(exp.badges).toContain("自动对上：抖音 10-02 19:00，不对就纠正");
    expect(await claims(r.id)).toEqual([]);
    await reconcileContent(r.id, env.dir);
    expect(await confirms(r.id)).toHaveLength(1);
  });

  it("纠正照旧：点「没发」后槽清空，再对账也不再自动对上", async () => {
    const r = await registeredVideo(env);
    await scenario(r, at(1));
    const doc = (await readProductionDoc(r.id, env.dir))!;
    expect(await founderDecision(r.id, "correct_publish", { target_id: `slot:${doc.round}:douyin` }, env.dir)).toMatchObject({ ok: true });
    await reconcileContent(r.id, env.dir);
    expect(await confirms(r.id)).toHaveLength(1);
    expect((await explainContent((await getContent(r.id, env.dir))!, env.dir)).stage).not.toBe("已发布");
  });

  it("时间窗外：留给创始人（收件箱里是「数据回流说已经发了」）", async () => {
    const r = await registeredVideo(env);
    await scenario(r, at(5));
    expect(await confirms(r.id)).toEqual([]);
    expect((await claims(r.id)).map((i) => i.detail.reporter)).toEqual(["数据回流"]);
  });

  it("还有一篇同名稿登记了抖音：两个候选，留给创始人", async () => {
    const r = await registeredVideo(env);
    const twin = await videoContent(env, "AI 又忘了怎么办");
    await setContent(env, twin.id, { platform: "douyin" });
    await scenario(r, at(1));
    expect(await confirms(r.id)).toEqual([]);
    expect(await claims(r.id)).toHaveLength(1);
  });
});
