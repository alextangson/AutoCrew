/**
 * spec 2026-09-28 §3 B：审稿台的系列比对。服务端只校验结构（快照、覆盖、引用），
 * 审稿落地前核对快照是否过时——有新稿进入范围就要求补审，不直接追认通过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as seriesMemory from "../modules/writing/series-memory.js";
import * as writerReview from "./writer-review.js";
import * as localStore from "../storage/local-store.js";
import { createEvidenceLedger } from "../modules/research/evidence-ledger.js";
import { saveContent, getContent, updateContent, transitionStatus } from "../storage/local-store.js";
import { writePack, readPack, type ReadyPack } from "./writer-pack.js";
import { runSubmit } from "./writer-submit.js";
import { executeReviewDesk } from "./host-review.js";
import { loadSeriesSnapshot, type Outline } from "../modules/writing/series-memory.js";
import { techniqueCatalog } from "../modules/writing/technique-store.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

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
  const c = await saveContent({ _provenance: HUMAN_WRITE, title, body: "阳台种菜，先看光照。\n\n每天至少六小时直射。", platform: "wechat_mp", status: "drafting", tags: [] }, dir);
  await updateContent(c.id, { _provenance: HUMAN_WRITE, outline: OTHER_OUTLINE }, dir);
  await transitionStatus(c.id, "draft_ready", { force: true }, dir);
  return c;
}

async function seedNewContractPack() {
  const content = await saveContent({ _provenance: HUMAN_WRITE, title: "菜园的清晨", body: "等待写稿", platform: "wechat_mp", status: "drafting", tags: [] }, dir);
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
  await updateContent(content.id, { _provenance: HUMAN_WRITE, pack: { packId: pack.packId, issuedAt: pack.issuedAt, host: "claude" } }, dir);
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
    expect(done, JSON.stringify(done).slice(0, 300)).toMatchObject({ ok: true, status: "accepted" });
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
      await updateContent(content.id, { _provenance: HUMAN_WRITE, body: "审稿期间编辑器改过的正文。" }, dir);
      return real(...args);
    });
    const res = await desk({ action: "submit", content_id: content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [], series_review: coverAll(review.series_snapshot) });
    expect(res).toMatchObject({ ok: false, status: "stale_review" });
    const after = (await getContent(content.id, dir))!;
    expect(after.seriesReview).toBeUndefined();
    expect(after.status).toBe("drafting");
  });
});

describe("re-review snapshot stays submittable (Codex P1)", () => {
  it("a full frozen snapshot (10) plus a newcomer re-trims to the newest 10 and the re-review can be submitted", async () => {
    for (let i = 0; i < 10; i++) await publishedNeighbour(`邻居${i}`);
    const { content, review } = await seedNewContractPack();
    expect(review.series_snapshot.items).toHaveLength(10);
    const newcomer = await publishedNeighbour("审稿期间进来的第 11 条");
    const base = { action: "submit", content_id: content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [] };
    const stale = await desk({ ...base, series_review: coverAll(review.series_snapshot) }) as { status: string; series_snapshot: { id: string; items: Array<{ content_id: string; insufficient: boolean }> } };
    expect(stale.status).toBe("series_snapshot_stale");
    expect(stale.series_snapshot.items).toHaveLength(10);
    expect(stale.series_snapshot.items[0].content_id).toBe(newcomer.id);
    expect(await desk({ ...base, series_review: coverAll(stale.series_snapshot) })).toMatchObject({ ok: true, status: "accepted" });
  });
});

describe("pinned-but-not-landed review recovers through a re-review (Codex P2)", () => {
  it("process dies after pinning, a draft enters scope, the original retry is sent to re-review and the re-review is accepted", async () => {
    const { content, review } = await seedNewContractPack();
    const base = { action: "submit", content_id: content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [] };
    const first = { ...base, series_review: coverAll(review.series_snapshot) };
    vi.spyOn(writerReview, "settleReview").mockRejectedValueOnce(new Error("进程在落地中途退出"));
    const crashed = await desk(first) as { ok: boolean; claim_token?: string };
    expect(crashed.ok).toBe(false);
    expect(crashed.claim_token).toBeTruthy();
    expect((await readPack(content.id, dir))?.attempts["1"].hostReview?.submission?.state).toBe("pending");
    Object.assign(base, { claim_token: crashed.claim_token });
    Object.assign(first, { claim_token: crashed.claim_token });

    await publishedNeighbour("恢复前进入范围的稿");
    const stale = await desk(first) as { status: string; series_snapshot: { id: string; items: Array<{ content_id: string; insufficient: boolean }> } };
    expect(stale.status).toBe("series_snapshot_stale");
    const done = await desk({ ...base, series_review: coverAll(stale.series_snapshot) });
    expect(done, JSON.stringify(done).slice(0, 300)).toMatchObject({ ok: true, status: "accepted" });
    expect(await desk({ ...base, series_review: coverAll(stale.series_snapshot) })).toMatchObject({ ok: true, replayed: true });
  });

  it("a pinned submission whose verdict already landed just finishes on retry (no snapshot re-check)", async () => {
    const { content, review } = await seedNewContractPack();
    const first = { action: "submit", content_id: content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [], series_review: coverAll(review.series_snapshot) };
    const beforeLanding = (await readPack(content.id, dir)) as ReadyPack;
    expect(await desk(first)).toMatchObject({ ok: true, status: "accepted" });
    // 模拟「结论已登记到稿件、但审稿单还停在钉住未完成」（落地后、写回执前进程退出）
    const pack = (await readPack(content.id, dir)) as ReadyPack;
    pack.attempts["1"] = { ...beforeLanding.attempts["1"], hostReview: { ...pack.attempts["1"].hostReview!, submission: { ...pack.attempts["1"].hostReview!.submission!, state: "pending", result: undefined } } };
    await writePack(content.id, pack, dir);
    await publishedNeighbour("之后进来的稿");
    const retried = await desk(first);
    expect(retried.status).not.toBe("series_snapshot_stale");
    expect(retried, JSON.stringify(retried).slice(0, 300)).toMatchObject({ ok: true });
  });
});

describe("recovery only skips the snapshot check after the draft really entered scope (Codex round 2 P1)", () => {
  it("review written but status never advanced: a newcomer must still be re-reviewed before accepting", async () => {
    const { content, review } = await seedNewContractPack();
    const first = { action: "submit", content_id: content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [], series_review: coverAll(review.series_snapshot) };
    // 进程在审稿元数据写完之后、推进到 draft_ready 之前退出
    vi.spyOn(localStore, "transitionStatus").mockRejectedValueOnce(new Error("进程退出"));
    const crashed = await desk(first) as { ok: boolean; claim_token?: string };
    expect(crashed.ok).toBe(false);
    const mid = (await getContent(content.id, dir))!;
    expect(mid.status).toBe("drafting");
    expect(mid.review?.source).toBeTruthy();
    Object.assign(first, { claim_token: crashed.claim_token });

    const newcomer = await publishedNeighbour("恢复前完成审稿的邻居");
    const retried = await desk(first) as { status?: string; additions?: string[]; series_snapshot?: { id: string; items: Array<{ content_id: string; insufficient: boolean }> } };
    expect(retried.status).toBe("series_snapshot_stale");
    expect(retried.additions).toEqual([newcomer.id]);
    const done = await desk({ ...first, series_review: coverAll(retried.series_snapshot!) });
    expect(done).toMatchObject({ ok: true, status: "accepted" });
  });
});

describe("re-review membership follows the live range (Codex round 2 P2)", () => {
  it("a newer draft leaving a full snapshot pulls in the old #11, and the re-review converges instead of staying stale", async () => {
    const neighbours = [];
    for (let i = 0; i < 11; i++) neighbours.push(await publishedNeighbour(`邻居${i}`));
    const { content, review } = await seedNewContractPack();
    expect(review.series_snapshot.items.map((i: { content_id: string }) => i.content_id)).not.toContain(neighbours[0].id);
    // 最新那条退回修改，离开范围；第 11 条旧稿因此回到前 10
    await transitionStatus(neighbours[10].id, "revision", { force: true }, dir);
    const base = { action: "submit", content_id: content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [] };
    const stale = await desk({ ...base, series_review: coverAll(review.series_snapshot) }) as { status: string; additions: string[]; series_snapshot: { id: string; items: Array<{ content_id: string; insufficient: boolean }> } };
    expect(stale.status).toBe("series_snapshot_stale");
    expect(stale.additions).toEqual([neighbours[0].id]);
    const ids = stale.series_snapshot.items.map((i) => i.content_id);
    expect(ids).toContain(neighbours[0].id);
    expect(ids).not.toContain(neighbours[10].id);
    expect(ids).toHaveLength(10);
    expect(await desk({ ...base, series_review: coverAll(stale.series_snapshot) })).toMatchObject({ ok: true, status: "accepted" });
  });
});
