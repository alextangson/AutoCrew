import { describe, it, expect, vi } from "vitest";
import { createRadarCycle, RADAR_CYCLE_INTERVAL_MS } from "./radar-cycle.js";

type Deps = Parameters<typeof createRadarCycle>[0];

/** 一套默认全绿的注入,单个用例只覆盖它关心的那一项 */
function deps(over: Partial<NonNullable<Deps>> = {}): NonNullable<Deps> {
  return {
    refresh: vi.fn(async () => ({ ok: true, itemCount: 40, failedSources: [], skippedFresh: false })),
    intake: vi.fn(async () => ({ saved: [], skippedDuplicates: 0, qualified: 0, filter: "llm" as const })),
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
