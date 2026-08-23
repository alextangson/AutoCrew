/**
 * write-research-gate 测试 —— 全注入、零 IO、零真睡。
 *
 * 盯的是闸口三纪律：有旧简报不重跑、降级带人话理由、**任何情况下都不抛**
 * （写作是执行层，调研只是垫底材料；闸口出事只准降级，不准把写稿弄死）。
 */
import { describe, it, expect } from "vitest";
import { makeEnsureBrief } from "./write-research-gate.js";
import { pendingPerspectives, type ResearchJob } from "../modules/research/research-job-store.js";
import type { EngineEvent } from "./event-hub.js";
import type { TriggerResult } from "../modules/research/research-runner.js";

const DATA_DIR = "/tmp/autocrew-write-gate-test"; // 全 impl 注入，路径不落地
const TOPIC = "topic-1";

function job(over: Partial<ResearchJob> = {}): ResearchJob {
  return {
    topicId: TOPIC,
    status: "running",
    startedAt: "2026-08-23T00:00:00.000Z",
    perspectives: pendingPerspectives(),
    topicHash: "hash-1",
    ...over,
  };
}

const ACCEPTED: TriggerResult = { accepted: true, deduped: false, job: job({ status: "queued" }) };

/** 假时钟：sleep 只推钟不真睡——轮询逻辑照跑，测试瞬间返回 */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    opts: {
      nowImpl: () => t,
      sleepImpl: async (ms: number): Promise<void> => {
        slept.push(ms);
        t += ms;
      },
    },
  };
}

/** 收事件的假发射器（返回值形状对齐 emitEngineEvent） */
function emitSpy(sink: Omit<EngineEvent, "ts">[]) {
  return async (e: Omit<EngineEvent, "ts">): Promise<EngineEvent> => {
    sink.push(e);
    return { ts: "2026-08-23T00:00:00.000Z", ...e };
  };
}

const never = async (): Promise<never> => {
  throw new Error("不该走到这一步");
};

describe("makeEnsureBrief", () => {
  it("已有简报指针 → already：不投递、不轮询（有旧简报直接用，不重跑）", async () => {
    const clock = fakeClock();
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => job({ status: "succeeded", briefRevision: 3 }),
      triggerImpl: never,
      emitImpl: never,
      ...clock.opts,
    });

    expect(await ensure(TOPIC)).toEqual({ state: "already" });
    expect(clock.slept).toEqual([]);
  });

  it("投递被拒 → unavailable，投递口的人话理由原样带回去留痕", async () => {
    const reason = "深调研要联网取证：先去设置页配好搜索 key";
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => null,
      triggerImpl: async () => ({ accepted: false, reason }),
      emitImpl: never,
      ...fakeClock().opts,
    });

    expect(await ensure(TOPIC)).toEqual({ state: "unavailable", note: reason });
  });

  it("轮到终态且有指针 → ready", async () => {
    const clock = fakeClock();
    const seq: ResearchJob[] = [job(), job(), job({ status: "succeeded", briefRevision: 1 })];
    let i = 0;
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => seq[Math.min(i++, seq.length - 1)],
      triggerImpl: async () => ACCEPTED,
      emitImpl: emitSpy([]),
      pollMs: 1000,
      deadlineMs: 60000,
      ...clock.opts,
    });

    expect(await ensure(TOPIC)).toEqual({ state: "ready" });
    expect(clock.slept).toEqual([1000, 1000]); // 首查 + 两轮轮询
  });

  it("partial（部分视角挂了但出了简报）也算 ready——有料就能写", async () => {
    const seq: ResearchJob[] = [job(), job({ status: "partial", briefRevision: 5 })];
    let i = 0;
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => seq[Math.min(i++, seq.length - 1)],
      triggerImpl: async () => ACCEPTED,
      emitImpl: emitSpy([]),
      pollMs: 1000,
      deadlineMs: 60000,
      ...fakeClock().opts,
    });

    expect(await ensure(TOPIC)).toEqual({ state: "ready" });
  });

  it("终态 failed 且无简报 → failed，带 failReason", async () => {
    const seq: ResearchJob[] = [
      job(),
      job({ status: "failed", errorCode: "too_few_perspectives", failReason: "四个视角挂了三个" }),
    ];
    let i = 0;
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => seq[Math.min(i++, seq.length - 1)],
      triggerImpl: async () => ACCEPTED,
      emitImpl: emitSpy([]),
      pollMs: 1000,
      deadlineMs: 60000,
      ...fakeClock().opts,
    });

    expect(await ensure(TOPIC)).toEqual({ state: "failed", note: "四个视角挂了三个" });
  });

  it("failed 没写 failReason → 退到 errorCode，不给一个空理由", async () => {
    const seq: ResearchJob[] = [job(), job({ status: "failed", errorCode: "deadline" })];
    let i = 0;
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => seq[Math.min(i++, seq.length - 1)],
      triggerImpl: async () => ACCEPTED,
      emitImpl: emitSpy([]),
      pollMs: 1000,
      deadlineMs: 60000,
      ...fakeClock().opts,
    });

    expect(await ensure(TOPIC)).toEqual({ state: "failed", note: "deadline" });
  });

  it("等到点了还在跑 → timeout（不再等，放行去写）", async () => {
    const clock = fakeClock();
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => job({ status: "running" }),
      triggerImpl: async () => ACCEPTED,
      emitImpl: emitSpy([]),
      pollMs: 1000,
      deadlineMs: 3000,
      ...clock.opts,
    });

    expect(await ensure(TOPIC)).toEqual({ state: "timeout" });
    expect(clock.slept).toEqual([1000, 1000, 1000]);
  });

  it("台账读崩 → unavailable，绝不抛（闸口故障不许弄死写作）", async () => {
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => {
        throw new Error("jobs.jsonl 读不动");
      },
      triggerImpl: never,
      emitImpl: never,
      ...fakeClock().opts,
    });

    expect(await ensure(TOPIC)).toEqual({ state: "unavailable", note: "jobs.jsonl 读不动" });
  });

  it("投递成功报一条 scout 事件——排队等简报得让人看见，不能只剩一个不动的「生成中」", async () => {
    const events: Omit<EngineEvent, "ts">[] = [];
    const seq: ResearchJob[] = [job(), job({ status: "succeeded", briefRevision: 1 })];
    let i = 0;
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => seq[Math.min(i++, seq.length - 1)],
      triggerImpl: async () => ACCEPTED,
      emitImpl: emitSpy(events),
      pollMs: 1000,
      deadlineMs: 60000,
      ...fakeClock().opts,
    });

    expect(await ensure(TOPIC)).toEqual({ state: "ready" });
    expect(events).toHaveLength(1);
    expect(events[0].role).toBe("scout");
    expect(events[0].label).toContain("简报");
  });

  it("真要等时先叫一声 onWaiting——写作侧据此把占位稿标题改成「调研中」", async () => {
    const order: string[] = [];
    const clock = fakeClock();
    const seq: ResearchJob[] = [job(), job({ status: "succeeded", briefRevision: 1 })];
    let i = 0;
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => {
        order.push("poll");
        return seq[Math.min(i++, seq.length - 1)];
      },
      triggerImpl: async () => {
        order.push("trigger");
        return ACCEPTED;
      },
      emitImpl: emitSpy([]),
      pollMs: 1000,
      deadlineMs: 60000,
      ...clock.opts,
    });

    expect(await ensure(TOPIC, async () => void order.push("waiting"))).toEqual({ state: "ready" });
    // 首查 → 投递 → onWaiting → 才开始轮询
    expect(order).toEqual(["poll", "trigger", "waiting", "poll"]);
  });

  it("已有简报（already）不叫 onWaiting——秒回的路上没有「调研中」这回事", async () => {
    const calls: string[] = [];
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => job({ status: "succeeded", briefRevision: 3 }),
      triggerImpl: never,
      emitImpl: never,
      ...fakeClock().opts,
    });

    expect(await ensure(TOPIC, async () => void calls.push("waiting"))).toEqual({ state: "already" });
    expect(calls).toEqual([]);
  });

  it("投递被拒（unavailable）不叫 onWaiting——压根没排上队，标题不许撒谎", async () => {
    const calls: string[] = [];
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => null,
      triggerImpl: async () => ({ accepted: false, reason: "搜索来源还没配 key" }),
      emitImpl: never,
      ...fakeClock().opts,
    });

    expect(await ensure(TOPIC, async () => void calls.push("waiting"))).toEqual({
      state: "unavailable",
      note: "搜索来源还没配 key",
    });
    expect(calls).toEqual([]);
  });

  it("onWaiting 抛错不改变 outcome（标题是观感，不是正确性）", async () => {
    const seq: ResearchJob[] = [job(), job({ status: "succeeded", briefRevision: 1 })];
    let i = 0;
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => seq[Math.min(i++, seq.length - 1)],
      triggerImpl: async () => ACCEPTED,
      emitImpl: emitSpy([]),
      pollMs: 1000,
      deadlineMs: 60000,
      ...fakeClock().opts,
    });

    const outcome = await ensure(TOPIC, async () => {
      throw new Error("占位稿写不动");
    });
    expect(outcome).toEqual({ state: "ready" });
  });

  it("事件发不出去不影响结果（观测层不得破坏执行层）", async () => {
    const seq: ResearchJob[] = [job(), job({ status: "succeeded", briefRevision: 1 })];
    let i = 0;
    const ensure = makeEnsureBrief(DATA_DIR, {
      getJobImpl: async () => seq[Math.min(i++, seq.length - 1)],
      triggerImpl: async () => ACCEPTED,
      emitImpl: never,
      pollMs: 1000,
      deadlineMs: 60000,
      ...fakeClock().opts,
    });

    expect(await ensure(TOPIC)).toEqual({ state: "ready" });
  });
});
