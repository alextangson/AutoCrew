import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RESEARCH_LEASE_MS,
  createResearchRunner,
  getResearchRunner,
  resetResearchRunner,
  type JobOutcome,
  type ResearchRunner,
  type ResearchRunnerDeps,
  type TriggerResult,
} from "./research-runner.js";
import {
  PERSPECTIVE_NAMES,
  getJob,
  listJobs,
  noteJobOrigin,
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type PerspectiveState,
  type ResearchJob,
} from "./research-job-store.js";
import { getTopic, saveTopic, softDeleteTopic, updateTopic, type Topic } from "../../storage/local-store.js";

let dataDir: string;
let runners: ResearchRunner[] = [];

const AT = Date.parse("2026-07-26T08:00:00.000Z");

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-research-runner-"));
});

afterEach(async () => {
  for (const r of runners) r.stop();
  runners = [];
  resetResearchRunner();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const allOk = (): PerspectiveState[] =>
  PERSPECTIVE_NAMES.map((name) => ({ name, status: "succeeded" as const }));

const twoDown = (): PerspectiveState[] =>
  PERSPECTIVE_NAMES.map((name, i) =>
    i < 2 ? { name, status: "succeeded" as const } : { name, status: "failed" as const, errorCode: "deadline" },
  );

function makeRunner(over: Partial<ResearchRunnerDeps> = {}): ResearchRunner {
  const r = createResearchRunner({
    dataDir,
    runJob: async () => ({ status: "succeeded", perspectives: allOk(), briefRevision: 1 }),
    onError: () => {},
    ...over,
  });
  runners.push(r);
  return r;
}

const newTopic = (over: Partial<Topic> = {}): Promise<Topic> =>
  saveTopic({ title: "AI 编程助手横评", description: "对比 5 个主流工具", tags: [], ...over }, dataDir);

/** trigger 的成功分支解包；被拒时直接炸出原因，省得测试里到处 if */
function acceptedJob(res: TriggerResult): ResearchJob {
  if (!res.accepted) throw new Error(`trigger 被拒：${res.reason}`);
  return res.job;
}

describe("五态迁移", () => {
  for (const status of ["succeeded", "partial", "failed"] as const) {
    it(`queued → running → ${status}：中途台账可读为 running，落定释放 lease`, async () => {
      const seen: string[] = [];
      const runner = makeRunner({
        now: () => AT,
        runJob: async (job) => {
          seen.push(job.status);
          expect(job.claimedAt).toBe(new Date(AT).toISOString());
          const onDisk = await getJob(job.topicId, dataDir);
          expect(onDisk).toMatchObject({ status: "running" });
          expect(onDisk?.settledAt).toBeUndefined(); // 处理中不是落定
          return {
            status,
            perspectives: status === "partial" ? twoDown() : allOk(),
            ...(status === "failed" ? { errorCode: "too_few_perspectives" } : { briefRevision: 3 }),
          };
        },
      });

      const topic = await newTopic();
      const queued = acceptedJob(await runner.trigger(topic.id));
      expect(queued).toMatchObject({ status: "queued", perspectives: pendingPerspectives() });
      expect(queued.claimedAt).toBeUndefined();

      await runner.idle();

      const settled = await getJob(topic.id, dataDir);
      expect(seen).toEqual(["running"]);
      expect(settled).toMatchObject({ status, settledAt: new Date(AT).toISOString() });
      expect(settled?.claimedAt).toBeUndefined();
      expect(settled?.briefRevision).toBe(status === "failed" ? undefined : 3);
    });
  }

  it("partial 逐视角失败原因落进台账（选题卡点名用）", async () => {
    const runner = makeRunner({ runJob: async () => ({ status: "partial", perspectives: twoDown(), briefRevision: 1 }) });
    const topic = await newTopic();
    await runner.trigger(topic.id);
    await runner.idle();

    expect((await getJob(topic.id, dataDir))?.perspectives).toEqual([
      { name: "audience", status: "succeeded" },
      { name: "evidence", status: "succeeded" },
      { name: "counter", status: "failed", errorCode: "deadline" },
      { name: "benchmark", status: "failed", errorCode: "deadline" },
    ]);
  });

  it("runJob 抛错 → failed + 错误原文可见，不静默降级", async () => {
    const runner = makeRunner({
      runJob: async () => {
        throw new Error("broker 配额炸了");
      },
    });
    const topic = await newTopic();
    await runner.trigger(topic.id);
    await runner.idle();

    const settled = await getJob(topic.id, dataDir);
    expect(settled).toMatchObject({
      status: "failed",
      errorCode: "run_threw",
      failReason: "broker 配额炸了",
    });
    expect(settled?.perspectives).toEqual(pendingPerspectives()); // 一个视角都没跑起来
  });
});

describe("触发与合并", () => {
  it("选题不存在 → 拒绝且不落 job", async () => {
    const runner = makeRunner();
    const res = await runner.trigger("topic-ghost");

    expect(res).toEqual({ accepted: false, reason: "选题不存在：topic-ghost" });
    expect(await listJobs(dataDir)).toEqual([]);
  });

  it("选题在回收站 → 拒绝并指路恢复", async () => {
    const topic = await newTopic();
    await softDeleteTopic(topic.id, dataDir);
    const res = await makeRunner().trigger(topic.id);

    expect(res.accepted).toBe(false);
    expect(!res.accepted && res.reason).toContain("回收站");
  });

  it("非终态重复触发：返回同一个 job，不重排也不重跑", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const runner = makeRunner({
      runJob: async () => {
        calls++;
        await gate;
        return { status: "succeeded", perspectives: allOk(), briefRevision: 1 };
      },
    });

    const topic = await newTopic();
    const first = acceptedJob(await runner.trigger(topic.id));
    const second = await runner.trigger(topic.id);
    const third = await runner.trigger(topic.id);

    expect(second.accepted && second.deduped).toBe(true);
    expect(third.accepted && third.deduped).toBe(true);
    expect(acceptedJob(second).startedAt).toBe(first.startedAt);
    release();
    await runner.idle();
    expect(calls).toBe(1);
  });

  it("终态后再触发：开新一轮（startedAt 刷新、视角重置、hash 现算）", async () => {
    let clock = AT;
    const runner = makeRunner({ now: () => clock });
    const topic = await newTopic();

    await runner.trigger(topic.id);
    await runner.idle();

    clock = AT + 3600_000;
    await updateTopic(topic.id, { title: "AI 编程助手横评（2026 版）" }, dataDir);
    const rerun = acceptedJob(await runner.trigger(topic.id));

    expect(rerun).toMatchObject({
      status: "queued",
      startedAt: new Date(AT + 3600_000).toISOString(),
      perspectives: pendingPerspectives(),
      topicHash: topicHashOf("AI 编程助手横评（2026 版）", "对比 5 个主流工具"),
    });
    expect(rerun.topicHash).not.toBe(topicHashOf(topic.title, topic.description));
    await runner.idle();
  });

  it("topicHash 取触发那一刻的选题正文", async () => {
    const topic = await newTopic();
    const job = acceptedJob(await makeRunner().trigger(topic.id));
    expect(job.topicHash).toBe(topicHashOf(topic.title, topic.description));
  });
});

describe("briefRevision 指针（只进不退）", () => {
  it("重跑失败不回退：旧简报继续有效", async () => {
    const outcomes: JobOutcome[] = [
      { status: "succeeded", perspectives: allOk(), briefRevision: 1 },
      { status: "failed", perspectives: twoDown(), briefRevision: 2, errorCode: "too_few_perspectives" },
    ];
    const runner = makeRunner({ runJob: async () => outcomes.shift()! });
    const topic = await newTopic();

    await runner.trigger(topic.id);
    await runner.idle();
    expect((await getJob(topic.id, dataDir))?.briefRevision).toBe(1);

    // 重跑：queued 阶段就得带着 v1 指针（进行中也不该让旧简报失效）
    expect(acceptedJob(await runner.trigger(topic.id)).briefRevision).toBe(1);
    await runner.idle();

    const failed = await getJob(topic.id, dataDir);
    expect(failed).toMatchObject({ status: "failed", briefRevision: 1, errorCode: "too_few_perspectives" });
  });

  it("succeeded/partial 才推进指针；没出简报的成功轮保留旧值", async () => {
    const outcomes: JobOutcome[] = [
      { status: "succeeded", perspectives: allOk(), briefRevision: 1 },
      { status: "partial", perspectives: twoDown(), briefRevision: 2 },
      { status: "succeeded", perspectives: allOk() },
    ];
    const runner = makeRunner({ runJob: async () => outcomes.shift()! });
    const topic = await newTopic();

    for (const expected of [1, 2, 2]) {
      await runner.trigger(topic.id);
      await runner.idle();
      expect((await getJob(topic.id, dataDir))?.briefRevision).toBe(expected);
    }
  });
});

describe("落定写回不抹掉别人打的标", () => {
  /**
   * 真实时序（调研回流轮）：聊天那轮几秒就结束并回填 originConversationId，
   * 四视角还要跑几分钟。落定若用 claim 那一刻的快照写回，这个标会被悄悄抹掉，
   * 简报出来后就永远没人回话——而且没有任何报错。
   */
  it("runJob 期间回填的来源会话，落定后还在", async () => {
    const topic = await newTopic();
    const runner = makeRunner({
      runJob: async (job) => {
        await noteJobOrigin(job.topicId, "conv-1-abc", dataDir);
        return { status: "succeeded", perspectives: allOk(), briefRevision: 1 };
      },
    });

    await runner.trigger(topic.id);
    await runner.idle();

    expect(await getJob(topic.id, dataDir)).toMatchObject({
      status: "succeeded",
      briefRevision: 1,
      originConversationId: "conv-1-abc",
    });
  });
});

describe("lease 与启动回收", () => {
  const staleJob = (topicId: string): ResearchJob => ({
    topicId,
    status: "running",
    startedAt: new Date(AT - RESEARCH_LEASE_MS * 2).toISOString(),
    claimedAt: new Date(AT - RESEARCH_LEASE_MS - 1_000).toISOString(),
    perspectives: pendingPerspectives(),
    topicHash: "deadbeefdeadbeef",
  });

  it("过期 running → queued（原因可见）并被重新排队跑完", async () => {
    const topic = await newTopic();
    await upsertJob(staleJob(topic.id), dataDir);
    const states: string[] = [];
    const runner = makeRunner({ now: () => AT, onJobChanged: (j) => states.push(j.status) });

    const reclaimed = await runner.reclaimStaleJobs();

    expect(reclaimed.map((j) => j.topicId)).toEqual([topic.id]);
    expect(reclaimed[0]).toMatchObject({ status: "queued" });
    expect(reclaimed[0].claimedAt).toBeUndefined();
    expect(reclaimed[0].failReason).toContain("处理中断已回收");

    await runner.idle();
    expect(await getJob(topic.id, dataDir)).toMatchObject({ status: "succeeded", briefRevision: 1 });
    expect(states).toEqual(["queued", "running", "succeeded"]);
  });

  it("租约未过期的 running 不被回收也不被抢跑", async () => {
    const topic = await newTopic();
    await upsertJob({ ...staleJob(topic.id), claimedAt: new Date(AT - 60_000).toISOString() }, dataDir);
    let calls = 0;
    const runner = makeRunner({
      now: () => AT,
      runJob: async () => {
        calls++;
        return { status: "succeeded", perspectives: allOk() };
      },
    });

    expect(await runner.reclaimStaleJobs()).toEqual([]);
    await runner.idle();
    expect(calls).toBe(0);
    expect((await getJob(topic.id, dataDir))?.status).toBe("running");
  });

  it("崩在 queued 的 job 被启动补扫捡回来（没有 lease 可回收，但必须重排）", async () => {
    const topic = await newTopic();
    await upsertJob({ ...staleJob(topic.id), status: "queued", claimedAt: undefined }, dataDir);
    const runner = makeRunner({ now: () => AT });

    expect(await runner.reclaimStaleJobs()).toEqual([]); // 状态没被改，不算「回收」
    await runner.idle();
    expect((await getJob(topic.id, dataDir))?.status).toBe("succeeded");
  });

  it("终态 job 不被启动补扫重跑", async () => {
    const topic = await newTopic();
    await upsertJob({ ...staleJob(topic.id), status: "failed", claimedAt: undefined }, dataDir);
    let calls = 0;
    const runner = makeRunner({
      now: () => AT,
      runJob: async () => {
        calls++;
        return { status: "succeeded", perspectives: allOk() };
      },
    });

    await runner.reclaimStaleJobs();
    await runner.idle();
    expect(calls).toBe(0);
    expect((await getJob(topic.id, dataDir))?.status).toBe("failed");
  });
});

describe("选题续期（任务启动即续一次）", () => {
  it("投递时调一次续期；被拒的触发不续期", async () => {
    const renewed: string[] = [];
    const runner = makeRunner({ renewTopic: async (id) => void renewed.push(id) });
    const topic = await newTopic();

    await runner.trigger(topic.id);
    await runner.trigger("topic-ghost");
    await runner.trigger(topic.id); // 合并触发：没开新任务，不再续期
    await runner.idle();

    expect(renewed).toEqual([topic.id]);
  });

  it("默认实现把 renewedAt 摸到选题上（过期回收以它为锚）", async () => {
    const runner = makeRunner();
    const topic = await newTopic();
    expect(topic.renewedAt).toBeUndefined();

    await runner.trigger(topic.id);
    await runner.idle();

    const after = await getTopic(topic.id, dataDir);
    expect(Date.parse(after!.renewedAt!)).toBeGreaterThan(0);
    expect(after?.createdAt).toBe(topic.createdAt); // 续期不动出生时间
  });

  it("续期失败不拖垮投递：任务照跑，故障从 onError 冒出来", async () => {
    const phases: string[] = [];
    const runner = makeRunner({
      renewTopic: async () => {
        throw new Error("选题文件写不进去");
      },
      onError: (_e, ctx) => phases.push(ctx.phase),
    });
    const topic = await newTopic();

    await runner.trigger(topic.id);
    await runner.idle();

    expect(phases).toEqual(["renew_topic"]);
    expect((await getJob(topic.id, dataDir))?.status).toBe("succeeded");
  });
});

describe("onJobChanged（SSE 写账后通知）", () => {
  it("queued/running/落定各通知一次，末事件即台账终态", async () => {
    const events: ResearchJob[] = [];
    const runner = makeRunner({ onJobChanged: (j) => void events.push(j) });
    const topic = await newTopic();

    await runner.trigger(topic.id);
    await runner.idle();

    expect(events.map((e) => e.status)).toEqual(["queued", "running", "succeeded"]);
    expect(events[events.length - 1]).toEqual(await getJob(topic.id, dataDir));
  });

  it("每次通知时重读台账都是落定态，不是中间态", async () => {
    const readBack: string[] = [];
    const runner = makeRunner({
      onJobChanged: (j) => {
        void getJob(j.topicId, dataDir).then((onDisk) => readBack.push(`${j.status}:${onDisk?.status}`));
      },
    });
    const topic = await newTopic();

    await runner.trigger(topic.id);
    await runner.idle();
    await new Promise((r) => setTimeout(r, 10));

    expect(readBack).toEqual(["queued:queued", "running:running", "succeeded:succeeded"]);
  });

  it("监听者每次都抛错也不影响执行", async () => {
    const phases: string[] = [];
    const runner = makeRunner({
      onJobChanged: () => {
        throw new Error("listener boom");
      },
      onError: (_e, ctx) => phases.push(ctx.phase),
    });
    const topic = await newTopic();

    await runner.trigger(topic.id);
    await runner.idle();

    expect(phases).toEqual(["on_job_changed", "on_job_changed", "on_job_changed"]);
    expect((await getJob(topic.id, dataDir))?.status).toBe("succeeded");
  });
});

describe("串行与生命周期", () => {
  it("两个选题并发投递不交错", async () => {
    const trace: string[] = [];
    const runner = makeRunner({
      runJob: async (job) => {
        trace.push(`enter:${job.topicId}`);
        await new Promise((r) => setTimeout(r, 5));
        trace.push(`exit:${job.topicId}`);
        return { status: "succeeded", perspectives: allOk(), briefRevision: 1 };
      },
    });
    const a = await newTopic({ title: "选题 A" });
    const b = await newTopic({ title: "选题 B" });

    await runner.trigger(a.id); // 投递即返回：此刻 A 还在跑
    await runner.trigger(b.id);
    await runner.idle();

    expect(trace).toEqual([`enter:${a.id}`, `exit:${a.id}`, `enter:${b.id}`, `exit:${b.id}`]);
  });

  it("idle 在空队列时立刻 resolve；stop 后不再投递", async () => {
    let calls = 0;
    const runner = makeRunner({
      runJob: async () => {
        calls++;
        return { status: "succeeded", perspectives: allOk() };
      },
    });
    await expect(runner.idle()).resolves.toBeUndefined();

    runner.stop();
    const topic = await newTopic();
    await runner.trigger(topic.id);
    await runner.idle();

    expect(calls).toBe(0);
    expect((await getJob(topic.id, dataDir))?.status).toBe("queued"); // 台账已落，等下次启动补扫
  });

  it("getResearchRunner 是进程内单例，reset 后重建", () => {
    const deps: ResearchRunnerDeps = {
      dataDir,
      runJob: async () => ({ status: "succeeded", perspectives: allOk() }),
    };
    const first = getResearchRunner(deps);
    expect(getResearchRunner(deps)).toBe(first);
    resetResearchRunner();
    expect(getResearchRunner(deps)).not.toBe(first);
  });
});
