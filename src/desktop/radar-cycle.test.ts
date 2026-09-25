import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRadarCycle, RADAR_CYCLE_INTERVAL_MS } from "./radar-cycle.js";
import { listTopics } from "../storage/local-store.js";
import { saveProfile } from "../modules/profile/creator-profile.js";
import type { CreatorProfile } from "../modules/profile/creator-profile.js";

type Deps = Parameters<typeof createRadarCycle>[0];

/** 一套默认全绿的注入,单个用例只覆盖它关心的那一项 */
function deps(over: Partial<NonNullable<Deps>> = {}): NonNullable<Deps> {
  return {
    refresh: vi.fn(async () => ({ ok: true, itemCount: 40, failedSources: [], skippedFresh: false })),
    intake: vi.fn(async () => ({ saved: [], skippedDuplicates: 0, qualified: 0, filter: "llm" as const })),
    engineReady: vi.fn(async () => true),
    freezePool: vi.fn(async () => "pool-1790000000000-abc123"),
    expire: vi.fn(async () => ({ expiredByWorkspace: {}, total: 0, protectedByLineage: 0 })),
    emit: vi.fn(async (e) => ({ ts: "", ...e })),
    log: vi.fn(),
    warn: vi.fn(),
    ...over,
  } as NonNullable<Deps>;
}

describe("createRadarCycle", () => {
  it("缓存新鲜(skippedFresh) → 不 intake、不清理:重评同一批候选是白烧 LLM", async () => {
    const d = deps({
      refresh: vi.fn(async () => ({ ok: true, itemCount: 40, failedSources: [], skippedFresh: true })),
    });
    const result = await createRadarCycle(d)();

    expect(result.skipped).toBe("fresh");
    expect(d.intake).not.toHaveBeenCalled();
    expect(d.expire).not.toHaveBeenCalled();
  });

  it("真刷新 → 入库 + 过期清理,入库有产出才发事件", async () => {
    const d = deps({
      intake: vi.fn(async () => ({
        saved: [{ title: "AI 新灵感" }], skippedDuplicates: 0, qualified: 1, filter: "llm" as const,
      })),
      expire: vi.fn(async () => ({ expiredByWorkspace: { ws: 2 }, total: 2, protectedByLineage: 1 })),
    });
    const result = await createRadarCycle(d)();

    expect(result).toMatchObject({ skipped: null, intakeCount: 1, expiredCount: 2 });
    expect(d.emit).toHaveBeenCalledTimes(1);
    expect((d.emit as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ role: "scout", kind: "work" });
    expect(d.log).toHaveBeenCalled(); // 有清理产出才 log
  });

  it("没配引擎 → 只建池冻结,不打分、不报错、不发事件;清理照常", async () => {
    const d = deps({ engineReady: vi.fn(async () => false) });
    const result = await createRadarCycle(d)();

    expect(result).toMatchObject({ skipped: null, intakeCount: 0, poolId: "pool-1790000000000-abc123" });
    expect(d.freezePool).toHaveBeenCalledTimes(1);
    expect(d.intake).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.warn).not.toHaveBeenCalled();
    expect(d.expire).toHaveBeenCalledTimes(1);
  });

  it("配了引擎 → 照旧两段打分入库,不另建池", async () => {
    const d = deps();
    const result = await createRadarCycle(d)();
    expect(d.intake).toHaveBeenCalledTimes(1);
    expect(d.freezePool).not.toHaveBeenCalled();
    expect(result.poolId).toBeNull();
  });

  it("零入库零清理 → 不发事件也不 log(tick 每半小时一次,静默才是常态)", async () => {
    const d = deps();
    const result = await createRadarCycle(d)();
    expect(result.intakeCount).toBe(0);
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  it("失败源上报到 warn,不吞", async () => {
    const d = deps({
      refresh: vi.fn(async () => ({ ok: true, itemCount: 3, failedSources: ["36氪"], skippedFresh: false })),
    });
    const result = await createRadarCycle(d)();
    expect(result.failedSources).toEqual(["36氪"]);
    expect(String((d.warn as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("36氪");
  });

  it("in-flight guard:上一轮没跑完,本 tick 跳过而不是叠罗汉", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = deps({
      refresh: vi.fn(async () => {
        await gate;
        return { ok: true, itemCount: 1, failedSources: [], skippedFresh: false };
      }),
    });
    const run = createRadarCycle(d);

    const first = run();
    const second = await run(); // 第一轮还卡在 refresh 里
    expect(second.skipped).toBe("in_flight");
    expect(d.refresh).toHaveBeenCalledTimes(1);

    release();
    await first;
    // 上一轮收尾后闸门重新打开,下一 tick 照常跑
    expect((await run()).skipped).toBeNull();
    expect(d.refresh).toHaveBeenCalledTimes(2);
  });

  it("周期远密于 6h TTL,又不至于每分钟骚扰一次", () => {
    expect(RADAR_CYCLE_INTERVAL_MS).toBeGreaterThanOrEqual(10 * 60_000);
    expect(RADAR_CYCLE_INTERVAL_MS).toBeLessThan(6 * 3600_000);
  });
});

describe("createRadarCycle 无引擎(真实的「没配」判定)", () => {
  const saved = { dataDir: process.env.AUTOCREW_DATA_DIR, key: process.env.DEEPSEEK_API_KEY };
  let dir = "";

  afterEach(async () => {
    for (const [k, v] of [["AUTOCREW_DATA_DIR", saved.dataDir], ["DEEPSEEK_API_KEY", saved.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("engine.json 不存在 → 冻结候选池,不入库、不 warn", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-cycle-noengine-"));
    process.env.AUTOCREW_DATA_DIR = dir;
    delete process.env.DEEPSEEK_API_KEY;
    const now = new Date().toISOString();
    await saveProfile({
      industry: "AI 工具", platforms: [], audiencePersona: null, writingRules: [],
      styleBoundaries: { never: [], always: [] }, competitorAccounts: [], performanceHistory: [],
      styleCalibrated: true, createdAt: now, updatedAt: now,
    } as CreatorProfile, dir);
    await fs.writeFile(path.join(dir, "topic-radar.json"), JSON.stringify({
      fetchedAt: now,
      items: [{ title: "AI 编程新品", link: "https://a.example/1", source: "36氪", publishedAt: now }],
    }));
    const d = deps();
    const result = await createRadarCycle({
      refresh: d.refresh, expire: d.expire, emit: d.emit, log: d.log, warn: d.warn,
    })();

    expect(result.poolId).toMatch(/^pool-\d{13}-[a-z0-9]{6}$/);
    expect(result.intakeCount).toBe(0);
    expect(await fs.readdir(path.join(dir, "radar", "pools"))).toEqual([`${result.poolId}.json`]);
    expect(await listTopics(dir)).toHaveLength(0);
    expect(d.warn).not.toHaveBeenCalled();
  });
});
