/**
 * research-runtime 测试 —— 重点是**装配**：
 * job 级（runner.onJobChanged）与视角级（deep-research.onProgress）两条进度
 * 必须落到同一个 onResearchEvent 出口，漏接任一条前端就瞎一半。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SEARCH_NOT_CONFIGURED,
  getResearchRuntimeStatus,
  startResearchRuntime,
  stopResearchRuntime,
  triggerDeepResearch,
  type ChatFollowupEvent,
  type ResearchUpdatedEvent,
} from "./research-runtime.js";
import type { DeepResearchDeps } from "../modules/research/deep-research.js";
import { readRecentEvents } from "./event-hub.js";
import type { JobOutcome } from "../modules/research/research-runner.js";
import {
  PERSPECTIVE_NAMES,
  getJob,
  markJobFollowedUp,
  noteJobOrigin,
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type ResearchJob,
} from "../modules/research/research-job-store.js";
import { saveSearchConfig } from "../modules/research/search-provider.js";
import { saveTopic, type Topic } from "../storage/local-store.js";

let dataDir: string;
let events: ResearchUpdatedEvent[];

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-research-runtime-"));
  events = [];
});

afterEach(async () => {
  stopResearchRuntime();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const newTopic = (): Promise<Topic> =>
  saveTopic({ title: "AI 编程助手横评", description: "对比 5 个主流工具", tags: [] }, dataDir);

const configureSearch = (): Promise<void> => saveSearchConfig({ provider: "bocha", apiKey: "k-test" }, dataDir);

const allOk = (): JobOutcome["perspectives"] =>
  PERSPECTIVE_NAMES.map((name) => ({ name, status: "succeeded" as const }));

/** 假管线：跑起来先经 onProgress 报一路视角完成，再回执 —— 装配对不对全看这里 */
function fakePipeline(over: Partial<JobOutcome> = {}) {
  return (deps: DeepResearchDeps) => async (job: ResearchJob): Promise<JobOutcome> => {
    const current = (await getJob(job.topicId, deps.dataDir)) ?? job;
    const perspectives = current.perspectives.map((p, i) =>
      i === 0 ? { ...p, status: "succeeded" as const } : p,
    );
    await upsertJob({ ...current, perspectives }, deps.dataDir);
    deps.onProgress?.({ ...current, perspectives });
    return { status: "succeeded", perspectives: allOk(), briefRevision: 1, ...over };
  };
}

async function start(over: Parameters<typeof startResearchRuntime>[0] = {}) {
  return startResearchRuntime({
    rootDir: dataDir,
    onResearchEvent: (e) => events.push(e),
    onError: () => {},
    createRunJobImpl: fakePipeline(),
    ...over,
  });
}

describe("startResearchRuntime", () => {
  it("启动即 running，并把 dataDir 报出来", async () => {
    const status = await start();
    expect(status.state).toBe("running");
    expect(status.dataDir).toBe(dataDir);
    expect(getResearchRuntimeStatus()).toMatchObject({ state: "running", dataDir });
  });

  it("启动回收 lease 过期的 running job（→ queued 并重排）", async () => {
    const topic = await newTopic();
    await upsertJob(
      {
        topicId: topic.id,
        status: "running",
        startedAt: "2026-07-26T00:00:00.000Z",
        claimedAt: "2026-07-26T00:00:00.000Z", // 远早于 30 分钟租约
        perspectives: pendingPerspectives(),
        topicHash: topicHashOf(topic.title, topic.description),
      },
      dataDir,
    );
    const status = await start();
    expect(status.reclaimed).toBe(1);
    // 重排后由假管线跑完 → 终态落定
    await waitFor(async () => (await getJob(topic.id, dataDir))?.status === "succeeded");
  });
});

describe("triggerDeepResearch", () => {
  it("运行时没起来 → accepted:false 照实说，不假装排队", async () => {
    const topic = await newTopic();
    await configureSearch();
    const res = await triggerDeepResearch(topic.id, dataDir);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toContain("没在跑");
    expect(await getJob(topic.id, dataDir)).toBeNull(); // 台账干净：没落过 job
  });

  it("搜索 key 未配 → 拒绝并给设置指引，不排注定失败的 job", async () => {
    const topic = await newTopic();
    await start();
    const res = await triggerDeepResearch(topic.id, dataDir);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe(SEARCH_NOT_CONFIGURED);
    expect(await getJob(topic.id, dataDir)).toBeNull();
  });

  it("选题不存在 → 拒绝（runner 的门原样透出来）", async () => {
    await configureSearch();
    await start();
    const res = await triggerDeepResearch("topic-1-nope", dataDir);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toContain("选题不存在");
  });

  it("装配：job 级与视角级进度都落到同一个 onResearchEvent 出口", async () => {
    const topic = await newTopic();
    await configureSearch();
    let sawProgressHook = false;
    await start({
      createRunJobImpl: (deps: DeepResearchDeps) => {
        sawProgressHook = typeof deps.onProgress === "function"; // 装配时必须注入
        return fakePipeline()(deps);
      },
    });
    const res = await triggerDeepResearch(topic.id, dataDir);
    expect(res.accepted).toBe(true);
    // queued + running + 视角进度 + 落定 —— 至少四拍，缺 onProgress 只会有三拍。
    // 不能只等台账 succeeded：落定行 append 后即可读，第四拍在 fsync+close 之后才发射，
    // 负载下轮询会抢进这个窗口。事件数必须一起等到（等不齐 = waitFor 超时报错）。
    await waitFor(async () => {
      if (events.length < 4) return false;
      return (await getJob(topic.id, dataDir))?.status === "succeeded";
    });

    expect(sawProgressHook).toBe(true);
    expect(events.every((e) => e.type === "research:updated" && e.topicId === topic.id)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(4);
  });

  it("装配：检索活动落成 scout 工作日志（视角中文名 + 搜索词/域名）", async () => {
    const topic = await newTopic();
    await configureSearch();
    await start({
      createRunJobImpl: (deps: DeepResearchDeps) => async (job: ResearchJob) => {
        deps.onActivity?.({ perspective: "evidence", action: "search", detail: "新能源车企 2026 销量" });
        deps.onActivity?.({ perspective: "counter", action: "read_page", detail: "zhihu.com" });
        return fakePipeline()(deps)(job);
      },
    });
    await triggerDeepResearch(topic.id, dataDir);
    await waitFor(async () => (await getJob(topic.id, dataDir))?.status === "succeeded");

    // 事件落盘是异步的（emitEngineEvent fire-and-forget），等它写完再读
    await waitFor(async () => (await readRecentEvents(dataDir)).length >= 2);
    const labels = (await readRecentEvents(dataDir)).map((e) => `${e.role}|${e.kind}|${e.label}`);
    expect(labels).toContain("scout|work|调研员·证据与数据视角在搜：新能源车企 2026 销量");
    expect(labels).toContain("scout|work|调研员·反方视角在读：zhihu.com");
  });

  it("同选题重复投递合并成一个 job（deduped）", async () => {
    const topic = await newTopic();
    await configureSearch();
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    await start({
      createRunJobImpl: (deps: DeepResearchDeps) => async (job: ResearchJob) => {
        await gate;
        return fakePipeline()(deps)(job);
      },
    });
    const first = await triggerDeepResearch(topic.id, dataDir);
    const second = await triggerDeepResearch(topic.id, dataDir);
    expect(first).toMatchObject({ accepted: true, deduped: false });
    expect(second).toMatchObject({ accepted: true, deduped: true });
    release();
    await waitFor(async () => (await getJob(topic.id, dataDir))?.status === "succeeded");
  });
});

// 调研回流轮 §2：落定即回报的那道门（真回报体由 chat-followup 自己测）
describe("回流轮接线", () => {
  /** 记下每次被叫到的 job，并把 SSE 出口原样透出来 */
  function spyFollowup(seen: ResearchJob[], deliver = true) {
    return async (job: ResearchJob, deps: { onDelivered?: (e: { conversationId: string; topicId: string }) => void }) => {
      seen.push(job);
      if (deliver && job.originConversationId) {
        deps.onDelivered?.({ conversationId: job.originConversationId, topicId: job.topicId });
      }
      return "delivered" as const;
    };
  }

  /**
   * 卡在调研跑到一半的管线：真实时序就是这样——聊天那轮几秒就结束并回填来源会话，
   * 四视角还要跑好几分钟。落定写回时那个标必须还在（否则永远没人回话）。
   */
  function gatedPipeline(gate: Promise<void>) {
    return (deps: DeepResearchDeps) => async (job: ResearchJob) => {
      await gate;
      return fakePipeline()(deps)(job);
    };
  }

  it("从对话派的任务落定 → 回流轮开跑，落点经 onChatFollowupEvent 出去", async () => {
    const topic = await newTopic();
    await configureSearch();
    const seen: ResearchJob[] = [];
    const followups: ChatFollowupEvent[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    await start({
      createRunJobImpl: gatedPipeline(gate),
      followupImpl: spyFollowup(seen),
      onChatFollowupEvent: (e) => followups.push(e),
    });
    await triggerDeepResearch(topic.id, dataDir);
    // 来源会话由 chat-persist 在本轮对话落盘后回填——此刻调研还在跑
    await waitFor(async () => (await getJob(topic.id, dataDir))?.status === "running");
    await noteJobOrigin(topic.id, "conv-1-abc", dataDir);
    release();

    await waitFor(async () => followups.length > 0);
    expect(seen.map((j) => j.status)).toEqual(["succeeded"]); // 只在终态叫一次
    expect(seen[0].originConversationId).toBe("conv-1-abc"); // 落定写回没把标抹掉
    expect(followups).toEqual([{ type: "chat:followup", conversationId: "conv-1-abc", topicId: topic.id }]);
  });

  it("没有来源会话（面板按钮派的）：回流轮压根不启动", async () => {
    const topic = await newTopic();
    await configureSearch();
    const seen: ResearchJob[] = [];
    await start({ followupImpl: spyFollowup(seen) });
    await triggerDeepResearch(topic.id, dataDir);
    await waitFor(async () => (await getJob(topic.id, dataDir))?.status === "succeeded");
    // 落定后再等几拍，确认确实没有迟到的触发
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
  });

  it("已回报过的任务不再回报（followupAt 是持久防重）", async () => {
    const topic = await newTopic();
    await configureSearch();
    const seen: ResearchJob[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    await start({ createRunJobImpl: gatedPipeline(gate), followupImpl: spyFollowup(seen) });
    await triggerDeepResearch(topic.id, dataDir);
    await waitFor(async () => (await getJob(topic.id, dataDir))?.status === "running");
    await noteJobOrigin(topic.id, "conv-1-abc", dataDir);
    await markJobFollowedUp(topic.id, "2026-08-24T09:00:00.000Z", dataDir);
    release();

    await waitFor(async () => (await getJob(topic.id, dataDir))?.status === "succeeded");
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
  });
});

/** 轮询等条件成立（runner 是异步串行队列，落定时刻不可预测） */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("等待超时");
}
