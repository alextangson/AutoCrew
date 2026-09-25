import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  awaitSettledReceipt,
  claimReceipt,
  freezeRadarPool,
  isPoolId,
  loadRadarPool,
  poolExpired,
  radarProfileVersion,
  readReceipt,
  settleReceipt,
  POOL_TTL_MS,
  RADAR_RULES_VERSION,
} from "./pool-store.js";
import type { RadarReceipt } from "./pool-store.js";
import { candidateIdFor } from "./radar-intake.js";
import type { RadarPoolCandidate } from "./radar-intake.js";
import type { CreatorProfile } from "../profile/creator-profile.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pool-store-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function cand(n: number): RadarPoolCandidate {
  const item = { title: `AI 候选 ${n}`, link: `https://a.example/${n}`, source: "36氪", publishedAt: new Date().toISOString() };
  return { candidate_id: candidateIdFor(item), item, rank_score: 3, matched_tokens: ["AI"] };
}

const freeze = (candidates: RadarPoolCandidate[], profileVersion = "pv-1") =>
  freezeRadarPool({ candidates, profileVersion, cacheFetchedAt: "2026-09-25T00:00:00.000Z" }, dir);

async function rewritePool(poolId: string, patch: Record<string, unknown>): Promise<void> {
  const file = path.join(dir, "radar", "pools", `${poolId}.json`);
  const pool = JSON.parse(await fs.readFile(file, "utf-8"));
  await fs.writeFile(file, JSON.stringify({ ...pool, ...patch }));
}

describe("freezeRadarPool", () => {
  it("冻结快照落盘:候选、画像/规则版本、24h 过期", async () => {
    const { pool, reused } = await freeze([cand(1), cand(2)]);
    expect(reused).toBe(false);
    expect(isPoolId(pool.pool_id)).toBe(true);
    expect(pool.rules_version).toBe(RADAR_RULES_VERSION);
    expect(pool.profile_version).toBe("pv-1");
    expect(Date.parse(pool.expires_at) - Date.parse(pool.created_at)).toBe(POOL_TTL_MS);
    const loaded = await loadRadarPool(pool.pool_id, dir);
    expect(loaded?.candidates.map((c) => c.candidate_id)).toEqual([cand(1).candidate_id, cand(2).candidate_id]);
  });

  it("没有新候选 → 复用同一个池;来了新候选 → 冻结新池", async () => {
    const first = await freeze([cand(1), cand(2)]);
    const again = await freeze([cand(2)]); // 候选变少(被别处消化)也算没有新候选
    expect(again).toMatchObject({ reused: true });
    expect(again.pool.pool_id).toBe(first.pool.pool_id);
    const fresh = await freeze([cand(1), cand(3)]);
    expect(fresh.reused).toBe(false);
    expect(fresh.pool.pool_id).not.toBe(first.pool.pool_id);
  });

  it("并发冻结同一批候选 → 同进程内只冻一个池", async () => {
    const [a, b] = await Promise.all([freeze([cand(1)]), freeze([cand(1)])]);
    expect(a.pool.pool_id).toBe(b.pool.pool_id);
    expect(await fs.readdir(path.join(dir, "radar", "pools"))).toHaveLength(1);
  });

  it("已消费(有收据)、已过期、画像变了的池都不复用", async () => {
    const consumed = await freeze([cand(1)]);
    await claimReceipt(consumed.pool.pool_id, "digest", dir);
    const afterConsume = await freeze([cand(1)]);
    expect(afterConsume.pool.pool_id).not.toBe(consumed.pool.pool_id);

    await rewritePool(afterConsume.pool.pool_id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(poolExpired((await loadRadarPool(afterConsume.pool.pool_id, dir))!)).toBe(true);
    const afterExpiry = await freeze([cand(1)]);
    expect(afterExpiry.pool.pool_id).not.toBe(afterConsume.pool.pool_id);

    const otherProfile = await freeze([cand(1)], "pv-2");
    expect(otherProfile.pool.pool_id).not.toBe(afterExpiry.pool.pool_id);
  });

  it("超过 7 天的池与收据在下次冻结时清掉", async () => {
    const oldId = `pool-${Date.now() - 8 * 24 * 3600_000}-abcdef`;
    await fs.mkdir(path.join(dir, "radar", "pools"), { recursive: true });
    await fs.writeFile(path.join(dir, "radar", "pools", `${oldId}.json`), "{}");
    await claimReceipt(oldId, "d", dir);
    await freeze([cand(1)]);
    expect(await loadRadarPool(oldId, dir)).toBeNull();
    expect(await readReceipt(oldId, dir)).toBeNull();
  });
});

describe("receipts", () => {
  const poolId = "pool-1790000000000-abc123";

  it("独占占位:并发 5 次只有 1 次占到", async () => {
    const claims = await Promise.all(Array.from({ length: 5 }, () => claimReceipt(poolId, "d1", dir)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await readReceipt(poolId, dir))?.status).toBe("pending");
  });

  it("落定后等待者拿到同一张收据;半截 JSON 视为 pending 而不是损坏", async () => {
    await claimReceipt(poolId, "d1", dir);
    const pending = (await readReceipt(poolId, dir))!;
    const waiting = awaitSettledReceipt(poolId, dir, { timeoutMs: 2000, intervalMs: 10 });
    const done: RadarReceipt = { ...pending, status: "done", saved: [], rejected: ["x"] };
    await settleReceipt(done, dir);
    expect(await waiting).toMatchObject({ status: "done", receipt_id: pending.receipt_id, rejected: ["x"] });

    await fs.writeFile(path.join(dir, "radar", "receipts", `${poolId}.json`), '{"status":');
    expect((await readReceipt(poolId, dir))?.status).toBe("pending");
    const timedOut = await awaitSettledReceipt(poolId, dir, { timeoutMs: 30, intervalMs: 10 });
    expect(timedOut?.status).toBe("pending");
  });
});

describe("ids & versions", () => {
  it("pool_id 只认产品自己发的格式,挡住路径穿越", () => {
    expect(isPoolId("pool-1790000000000-abc123")).toBe(true);
    expect(isPoolId("../../etc/passwd")).toBe(false);
    expect(isPoolId("pool-1790000000000-abc123/../x")).toBe(false);
    expect(isPoolId(42)).toBe(false);
  });

  it("画像版本只随打分读到的字段变", () => {
    const base = { industry: "AI 工具", platforms: ["wechat_mp"], audiencePersona: null } as unknown as CreatorProfile;
    const v = radarProfileVersion(base);
    expect(radarProfileVersion({ ...base, platforms: ["douyin"] })).toBe(v);
    expect(radarProfileVersion({ ...base, industry: "职场成长" })).not.toBe(v);
    expect(radarProfileVersion({ ...base, focusKeywords: ["Agent"] })).not.toBe(v);
  });

  it("candidate_id 按链接稳定,标题改写不变;无链接退到标题", () => {
    expect(candidateIdFor({ title: "A", link: "https://x/1" })).toBe(candidateIdFor({ title: "B", link: " https://x/1 " }));
    expect(candidateIdFor({ title: "A", link: "" })).not.toBe(candidateIdFor({ title: "B", link: "" }));
  });
});
