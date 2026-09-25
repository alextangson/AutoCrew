import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTopicCreate } from "./topic-create.js";
import { listTopics } from "../storage/local-store.js";
import { loadRejects } from "../modules/radar/intake-gate.js";
import { saveProfile, loadProfile } from "../modules/profile/creator-profile.js";
import type { CreatorProfile } from "../modules/profile/creator-profile.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-topic-tool-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function profile(industry: string): CreatorProfile {
  const now = new Date().toISOString();
  return {
    industry,
    platforms: ["wechat_mp"],
    audiencePersona: null,
    writingRules: [],
    styleBoundaries: { never: [], always: [] },
    competitorAccounts: [],
    performanceHistory: [],
    styleCalibrated: true,
    createdAt: now,
    updatedAt: now,
  };
}

async function seedCache(n: number, offset = 0): Promise<void> {
  const items = Array.from({ length: n }, (_, i) => ({
    title: `AI 候选 ${i + offset}`,
    link: `https://a.example/${i + offset}`,
    source: "36氪",
    publishedAt: new Date().toISOString(),
    description: `候选 ${i + offset} 的源摘要`,
  }));
  await fs.writeFile(path.join(dir, "topic-radar.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), items }));
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (params: Record<string, unknown>) => executeTopicCreate({ ...params, _dataDir: dir }) as Promise<Json>;
const radarPool = () => call({ action: "radar_pool" });
const radarScore = (pool_id: unknown, results: unknown) => call({ action: "radar_score", pool_id, results });

/** 前 4 条过线(带齐第二段产物),第 5 条低分,其余不打分 */
function scores(ids: string[]): Json[] {
  const passing = [95, 88, 80, 75].map((score, i) => ({
    candidate_id: ids[i],
    score,
    title: `中文选题 ${i}`,
    summary: `摘要 ${i}`,
    angle: `角度 ${i}`,
  }));
  return [...passing, { candidate_id: ids[4], score: 40 }];
}

async function readyPool(n = 7): Promise<{ poolId: string; ids: string[] }> {
  await saveProfile(profile("AI 工具"), dir);
  await seedCache(n);
  const pool = await radarPool();
  return { poolId: pool.pool_id, ids: pool.candidates.map((c: Json) => c.candidate_id) };
}

async function patchPool(poolId: string, patch: Record<string, unknown>): Promise<void> {
  const file = path.join(dir, "radar", "pools", `${poolId}.json`);
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, "utf-8")), ...patch }));
}

describe("autocrew_topic radar_pool", () => {
  it("冻结池并返回候选、打分口径与创作者定位;没有新候选时返回同一个 pool_id", async () => {
    await saveProfile(profile("AI 工具"), dir);
    await seedCache(3);
    const first = await radarPool();
    expect(first).toMatchObject({ ok: true, reused: false, creator: { positioning: "AI 工具" } });
    expect(first.pool_id).toMatch(/^pool-\d{13}-[a-z0-9]{6}$/);
    expect(first.candidates[0]).toEqual(expect.objectContaining({
      candidate_id: expect.stringMatching(/^cand-/),
      title: expect.any(String),
      url: expect.stringMatching(/^https:/),
      source: "36氪",
      summary: expect.any(String),
      published_at: expect.any(String),
      score_hint: expect.any(Number),
    }));
    expect(first.rubric).toContain("受众/定位契合 0-30");
    expect(first.rubric).toContain("radar_score");

    const again = await radarPool();
    expect(again).toMatchObject({ pool_id: first.pool_id, reused: true });
    await seedCache(4); // 来了第 4 条
    expect((await radarPool()).pool_id).not.toBe(first.pool_id);
  });

  it("没定位 → no_profile;没缓存 → pool_id=null 且说明原因", async () => {
    expect(await radarPool()).toMatchObject({ ok: false, code: "no_profile" });
    await saveProfile(profile("AI 工具"), dir);
    const empty = await radarPool();
    expect(empty).toMatchObject({ ok: true, pool_id: null, candidates: [] });
    expect(empty.message).toBeTruthy();
  });
});

describe("autocrew_topic radar_score", () => {
  it("≥70 取前 3 入库;超额进 not_top3;低分记落选;没打分的不入库也不记落选", async () => {
    const { poolId, ids } = await readyPool();
    const res = await radarScore(poolId, scores(ids));

    expect(res).toMatchObject({ ok: true, replayed: false, not_top3: [ids[3]], rejected: [ids[4]], duplicates: [] });
    expect(res.saved.map((s: Json) => s.title)).toEqual(["中文选题 0", "中文选题 1", "中文选题 2"]);
    expect(res.unscored.sort()).toEqual([ids[5], ids[6]].sort());
    expect(res.receipt_id).toMatch(/^rcpt-/);

    const topics = await listTopics(dir);
    expect(topics).toHaveLength(3);
    const top = topics.find((t) => t.title === "中文选题 0")!;
    expect(top).toMatchObject({ source: "radar:36氪", score: 95, angles: ["角度 0"], description: "摘要 0" });
    const rejected = (await loadRejects(dir)).map((r) => r.title);
    expect(rejected).toHaveLength(1);
    const receipt = JSON.parse(await fs.readFile(path.join(dir, "radar", "receipts", `${poolId}.json`), "utf-8"));
    expect(receipt).toMatchObject({ status: "done", receipt_id: res.receipt_id, submission_digest: expect.any(String) });
  });

  it("radar-score-replay:同一份结果(换顺序)重交 → 同一收据、不再入库;换内容 → pool_consumed", async () => {
    const { poolId, ids } = await readyPool();
    const first = await radarScore(poolId, scores(ids));
    const replay = await radarScore(poolId, [...scores(ids)].reverse());
    expect(replay).toMatchObject({ ok: true, replayed: true, receipt_id: first.receipt_id, saved: first.saved });
    expect(await listTopics(dir)).toHaveLength(3);

    const changed = scores(ids).map((r) => ({ ...r, score: r.score === 40 ? 41 : r.score }));
    expect(await radarScore(poolId, changed)).toMatchObject({
      ok: false,
      code: "pool_consumed",
      receipt_id: first.receipt_id,
      next_action: { tool: "autocrew_topic", params: { action: "radar_pool" } },
    });
  });

  it("收据先于 stale:池过期后重放仍拿回原收据", async () => {
    const { poolId, ids } = await readyPool();
    const first = await radarScore(poolId, scores(ids));
    await patchPool(poolId, { expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await radarScore(poolId, scores(ids))).toMatchObject({ ok: true, replayed: true, receipt_id: first.receipt_id });
  });

  it("radar-score-concurrent-cap:并发两次同样提交只入库一次,拿同一收据", async () => {
    const { poolId, ids } = await readyPool();
    const [a, b] = await Promise.all([radarScore(poolId, scores(ids)), radarScore(poolId, scores(ids))]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.receipt_id).toBe(b.receipt_id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await listTopics(dir)).toHaveLength(3);
  });

  it("并发两份不同提交:一份入库,另一份 pool_consumed,总数仍 ≤3", async () => {
    const { poolId, ids } = await readyPool();
    const other = scores(ids).map((r) => ({ ...r, title: r.title ? `${r.title}·另一版` : undefined }));
    const outcomes = await Promise.all([radarScore(poolId, scores(ids)), radarScore(poolId, other)]);
    expect(outcomes.map((o) => o.ok ? "ok" : o.code).sort()).toEqual(["ok", "pool_consumed"]);
    expect(await listTopics(dir)).toHaveLength(3);
  });

  it("stale_pool:过期、画像变了、池不存在", async () => {
    const { poolId, ids } = await readyPool();
    await patchPool(poolId, { expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await radarScore(poolId, scores(ids))).toMatchObject({
      ok: false,
      code: "stale_pool",
      reason: "expired",
      next_action: { tool: "autocrew_topic", params: { action: "radar_pool" } },
    });

    const fresh = await radarPool();
    await saveProfile({ ...(await loadProfile(dir))!, industry: "职场成长" }, dir);
    expect(await radarScore(fresh.pool_id, scores(ids))).toMatchObject({ code: "stale_pool", reason: "profile_changed" });
    expect(await radarScore("pool-1790000000000-zzzzzz", scores(ids))).toMatchObject({ code: "stale_pool", reason: "missing" });
    expect(await listTopics(dir)).toHaveLength(0);
  });

  it("incomplete_result:过线条目缺第二段产物 → 列出缺什么,不占池,补齐后能正常入库", async () => {
    const { poolId, ids } = await readyPool();
    const res = await radarScore(poolId, [{ candidate_id: ids[0], score: 80, title: "只有标题" }]);
    expect(res).toMatchObject({ ok: false, code: "incomplete_result", missing: [{ candidate_id: ids[0], fields: ["summary", "angle"] }] });
    const ok = await radarScore(poolId, [{ candidate_id: ids[0], score: 80, title: "标题", summary: "摘要", angle: "角度" }]);
    expect(ok).toMatchObject({ ok: true, replayed: false });
    expect(ok.saved).toHaveLength(1);
  });

  it("invalid_result:不在池内、分数越界、重复、空结果;pool_id 非法", async () => {
    const { poolId, ids } = await readyPool();
    const bad = await radarScore(poolId, [
      { candidate_id: "cand-not-in-pool", score: 50 },
      { candidate_id: ids[0], score: 120 },
      { candidate_id: ids[1], score: 10 },
      { candidate_id: ids[1], score: 10 },
    ]);
    expect(bad).toMatchObject({ ok: false, code: "invalid_result" });
    expect(bad.errors).toHaveLength(3);
    expect(await radarScore(poolId, [])).toMatchObject({ code: "invalid_result" });
    expect(await radarScore(poolId, "not json")).toMatchObject({ code: "invalid_result" });
    expect(await radarScore("../../etc/passwd", scores(ids))).toMatchObject({ code: "invalid_pool_id" });
    expect(await listTopics(dir)).toHaveLength(0);
  });

  it("中转把数组参数变成 JSON 字符串时照样解析", async () => {
    const { poolId, ids } = await readyPool();
    const res = await radarScore(poolId, JSON.stringify(scores(ids)));
    expect(res).toMatchObject({ ok: true });
    expect(res.saved).toHaveLength(3);
  });

  it("占位后进程中断(pending 超过 5 分钟)→ intake_interrupted,池作废且 radar_pool 换新池", async () => {
    const { poolId, ids } = await readyPool();
    const receipts = path.join(dir, "radar", "receipts");
    await fs.mkdir(receipts, { recursive: true });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    await fs.writeFile(path.join(receipts, `${poolId}.json`), JSON.stringify({ version: 1, status: "pending", pool_id: poolId, receipt_id: "r", submission_digest: "d", at }));
    expect(await radarScore(poolId, scores(ids))).toMatchObject({ ok: false, code: "intake_interrupted" });
    expect((await radarPool()).pool_id).not.toBe(poolId);
  });
});
