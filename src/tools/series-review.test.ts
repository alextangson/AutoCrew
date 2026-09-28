/**
 * spec 2026-09-28 §3 B：审稿台的系列比对。服务端只校验结构（快照、覆盖、引用），
 * 审稿落地前核对快照是否过时——有新稿进入范围就要求补审，不直接追认通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as seriesMemory from "../modules/writing/series-memory.js";
import { createEvidenceLedger } from "../modules/research/evidence-ledger.js";
import { saveContent, getContent, updateContent, transitionStatus } from "../storage/local-store.js";
import { writePack, readPack, type ReadyPack } from "./writer-pack.js";
import { runSubmit } from "./writer-submit.js";
import { executeReviewDesk } from "./host-review.js";
import { loadSeriesSnapshot, type Outline } from "../modules/writing/series-memory.js";
import { techniqueCatalog } from "../modules/writing/technique-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-series-review-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }); });

const body = "清晨我们一起给菜苗浇水。邻居递过水壶，告诉我这一排土还湿着。以前我们只在电梯里点头，现在开始商量谁来照顾菜园。";
const OUTLINE: Outline = {
  thesis: "一起照顾菜园让邻居从点头之交变成会商量的人。",
  points: [{ text: "清晨浇水的场景", kind: "firsthand", seconds: 60 }],
  structure: { opening: "清晨浇水", progression: "从递水壶到商量分工", ending: "开始商量谁来照顾" },
  said: [{ id: "kettle", kind: "example", text: "邻居递水壶提醒土还湿着" }],
};
const OTHER_OUTLINE: Outline = {
  thesis: "阳台种菜先看光照。", points: [{ text: "光照", kind: "cause", seconds: 30 }],
  structure: { opening: "阳台", progression: "光照", ending: "挪盆" },
  said: [{ id: "sun", kind: "concept", text: "每天至少六小时直射" }],
};

/** 已经发过的一条同平台稿（进快照范围），带有效摘要 */
async function publishedNeighbour(title: string) {
  const c = await saveContent({ title, body: "阳台种菜，先看光照。\n\n每天至少六小时直射。", platform: "wechat_mp", status: "drafting", tags: [] }, dir);
  await updateContent(c.id, { outline: OTHER_OUTLINE }, dir);
  await transitionStatus(c.id, "draft_ready", { force: true }, dir);
  return c;
}

async function seedNewContractPack() {
  const content = await saveContent({ title: "菜园的清晨", body: "等待写稿", platform: "wechat_mp", status: "drafting", tags: [] }, dir);
  const pack: ReadyPack = {
    packId: "writing-pack-1", issuedAt: "2026-09-28T00:00:00Z", state: "ready", host: "claude", briefHash: "provided", angleId: "user-direction",
    series: await loadSeriesSnapshot("wechat_mp", { contentId: content.id }, dir),
    techniques: await techniqueCatalog(dir),
    ledger: createEvidenceLedger().snapshot(), ledgerBudget: { max: 3, used: 0 }, repair: { max: 0, used: 0 }, reviewRounds: 0, attempts: {},
    context: {
      req: { topic: "菜园的清晨", platform: "wechat_mp", requirements: "公众号，写给新居民" }, writingContract: "公众号，写给新居民", platform: "wechat_mp", trackPackId: "koubo",
      prompts: { system: "按任务自然写作", user: "写" }, researchSlot: "创作者材料：邻居共同照顾菜园。", voiceSamples: [], canFindEvidence: false,
      rulesApplied: 0, wroteWithoutBrief: false, wroteWithoutAngle: false,
    },
  };
  await writePack(content.id, pack, dir);
  await updateContent(content.id, { pack: { packId: pack.packId, issuedAt: pack.issuedAt, host: "claude" } }, dir);
  const saved = await runSubmit({ contentId: content.id, packId: pack.packId, attempt: 1, title: "菜园的清晨", body, outline: OUTLINE, host: "claude" }, dir);
  expect(saved).toMatchObject({ status: "awaiting_host_review" });
  const review = (saved as { review_pack: Record<string, any> }).review_pack;
  return { content, pack, review };
}
const desk = (args: Record<string, unknown>) => executeReviewDesk({ ...args, _host: "claude", _dataDir: dir });
const coverAll = (snap: { id: string; items: Array<{ content_id: string; insufficient: boolean }> }, findings: unknown[] = []) => ({
  snapshot_id: snap.id, checked: snap.items.map((i) => i.content_id), insufficient: snap.items.filter((i) => i.insufficient).map((i) => i.content_id), findings,
});

describe("series review on the host review desk", () => {
  it("the review pack carries the frozen snapshot, the draft's outline and the series rules", async () => {
    const neighbour = await publishedNeighbour("阳台种菜");
    const { review } = await seedNewContractPack();
    expect(review.series_snapshot.items.map((i: { content_id: string }) => i.content_id)).toEqual([neighbour.id]);
    expect(review.user).toContain("系列比对");
    expect(review.user).toContain("凑数段");
    expect(review.user).toContain("每天至少六小时直射");
    expect(review.outline).toEqual(OUTLINE);
  });

  it("empty issues without series_review is not a finished review; references must exist in the snapshot and the draft", async () => {
    const neighbour = await publishedNeighbour("阳台种菜");
    const { content, review } = await seedNewContractPack();
    const base = { action: "submit", content_id: content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [] };
    expect(await desk(base)).toMatchObject({ ok: false, status: "invalid_series_review" });
    expect(await desk({ ...base, series_review: { ...coverAll(review.series_snapshot), checked: [] } })).toMatchObject({ ok: false, status: "invalid_series_review" });
    expect(await desk({ ...base, series_review: { ...coverAll(review.series_snapshot), snapshot_id: "other" } })).toMatchObject({ ok: false, status: "invalid_series_review" });
    const badItem = coverAll(review.series_snapshot, [{ content_id: neighbour.id, item_id: "said:nope", quote: "清晨我们一起给菜苗浇水", disposition: "allowed", reason: "顺带" }]);
    expect(await desk({ ...base, series_review: badItem })).toMatchObject({ ok: false, status: "invalid_series_review" });
    const blockerWithoutIssue = coverAll(review.series_snapshot, [{ content_id: neighbour.id, item_id: "thesis", quote: "清晨我们一起给菜苗浇水", disposition: "blocker", reason: "主线相同" }]);
    expect(await desk({ ...base, series_review: blockerWithoutIssue })).toMatchObject({ ok: false, status: "invalid_series_review" });
    expect((await getContent(content.id, dir))?.status).toBe("drafting");

    const allowed = coverAll(review.series_snapshot, [{ content_id: neighbour.id, item_id: "said:sun", quote: "清晨我们一起给菜苗浇水", disposition: "allowed", reason: "只是同属园艺，主线不同" }]);
    const ok = await desk({ ...base, series_review: allowed });
    expect(ok).toMatchObject({ ok: true, status: "accepted" });
    const saved = await getContent(content.id, dir);
    expect(saved?.seriesReview).toMatchObject({ snapshot_id: review.series_snapshot.id, findings: [expect.objectContaining({ disposition: "allowed" })] });
    expect(saved?.seriesReview?.reviewContextHash).toBe(saved?.reviewContextHash);
  });

  it("a draft that entered the snapshot range after the pack was frozen forces a re-review before anything is registered", async () => {
    const { content, review } = await seedNewContractPack();
    expect(review.series_snapshot.items).toEqual([]);
    // 并行写的另一条稿在审稿期间进入 draft_ready
    const parallel = await publishedNeighbour("并行写的另一条");
    const base = { action: "submit", content_id: content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [] };
    const stale = await desk({ ...base, series_review: coverAll(review.series_snapshot) });
    expect(stale).toMatchObject({ ok: false, status: "series_snapshot_stale", additions: [parallel.id] });
    expect((await getContent(content.id, dir))?.status).toBe("drafting");
    expect((await getContent(content.id, dir))?.seriesReview).toBeUndefined();

    // 旧快照再交一次仍然不收；按新快照补审后才落地
    expect(await desk({ ...base, series_review: coverAll(review.series_snapshot) })).toMatchObject({ ok: false, status: "invalid_series_review" });
    const fresh = (stale as { series_snapshot: { id: string; items: Array<{ content_id: string; insufficient: boolean }> } }).series_snapshot;
    const done = await desk({ ...base, series_review: coverAll(fresh) });
    expect(done).toMatchObject({ ok: true, status: "accepted" });
    expect((await getContent(content.id, dir))?.seriesReview?.snapshot_id).toBe(fresh.id);
    // 审稿单里存的就是补审后的快照，重放同一载荷原样返回
    expect((await readPack(content.id, dir))?.attempts["1"].hostReview?.seriesSnapshot?.id).toBe(fresh.id);
    expect(await desk({ ...base, series_review: coverAll(fresh) })).toMatchObject({ ok: true, replayed: true });
  });

  it("a legacy pack (no frozen snapshot) keeps the old review contract", async () => {
    const { content, pack } = await seedNewContractPack();
    // 旧包：把冻结字段去掉再走一遍
    const legacy = await readPack(content.id, dir) as ReadyPack;
    delete legacy.series; delete legacy.techniques; legacy.attempts = {};
    await writePack(content.id, legacy, dir);
    const saved = await runSubmit({ contentId: content.id, packId: pack.packId, attempt: 2, title: "菜园的清晨", body, host: "claude" }, dir);
    const review = (saved as { review_pack: Record<string, any> }).review_pack;
    expect(review.series_snapshot).toBeUndefined();
    expect(await desk({ action: "submit", content_id: content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [] })).toMatchObject({ ok: true, status: "accepted" });
  });
});

describe("series review lands only on the reviewed draft version (Codex P1)", () => {
  it("a draft edited after the entry check keeps no series verdict and no accepted status", async () => {
    const { content, review } = await seedNewContractPack();
    const real = seriesMemory.loadSeriesSnapshot;
    // 审稿台已过入口的 draft_hash 核对、正在核对快照时，编辑器改了正文
    vi.spyOn(seriesMemory, "loadSeriesSnapshot").mockImplementationOnce(async (...args) => {
      await updateContent(content.id, { body: "审稿期间编辑器改过的正文。" }, dir);
      return real(...args);
    });
    const res = await desk({ action: "submit", content_id: content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [], series_review: coverAll(review.series_snapshot) });
    expect(res).toMatchObject({ ok: false, status: "stale_review" });
    const after = (await getContent(content.id, dir))!;
    expect(after.seriesReview).toBeUndefined();
    expect(after.status).toBe("drafting");
  });
});
