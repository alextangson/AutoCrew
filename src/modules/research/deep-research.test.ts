/**
 * deep-research.test.ts — runJob 全链（深调研 §5）：四视角并行 → 综合 → 不可变简报。
 *
 * 端到端但零 LLM：假 runLoop 按视角分发脚本，真去调工具；broker 是真 broker（假出网）；
 * 简报真落盘。断言集中在确定性层：job 回执、简报文件、进度时序、失败错误码。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDeepResearchRunJob } from "./deep-research.js";
import { briefPath, briefsDir, loadBrief, loadLatestBrief } from "./brief-store.js";
import { PERSPECTIVE_TASK_BOOKS } from "./research-perspectives.js";
import {
  PERSPECTIVE_NAMES,
  pendingPerspectives,
  topicHashOf,
  type PerspectiveName,
  type PerspectiveState,
  type ResearchJob,
} from "./research-job-store.js";
import { createResearchRunner } from "./research-runner.js";
import { saveTopic, softDeleteTopic, type Topic } from "../../storage/local-store.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult, runLoop } from "../../engine/loop.js";

const CONFIG: EngineConfig = {
  apiKey: "sk-test",
  baseUrl: "https://main.test",
  strongModel: "m-strong",
  fastModel: "m-fast",
  routes: { scout: { baseUrl: "https://scout.test", model: "m-scout" } },
};

const PAGE_URL = "https://example.com/survey";
const PAGE_TEXT = "2026 年开发者调查：62% 的人每天使用 AI 编程助手，但维护成本上升了三成。";
const REAL_QUOTE = "62% 的人每天使用 AI 编程助手";
const IMAGE_URL = "https://example.com/chart.png";

const BROKER_DEPS = {
  searchImpl: async () => [{ title: "2026 开发者调查", url: PAGE_URL, snippet: "每天使用比例过半" }],
  fetchImpl: async (url: string) => ({
    finalUrl: url,
    text: PAGE_TEXT,
    title: "2026 开发者调查",
    imageCandidates: [{ url: IMAGE_URL, sourceAttr: "img" as const }],
  }),
};

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-deep-research-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const newTopic = (over: Partial<Topic> = {}): Promise<Topic> =>
  saveTopic(
    { title: "AI 编程助手横评", description: "对比主流工具的真实收益与维护成本", tags: [], ...over },
    dataDir,
  );

function jobFor(topic: Topic): ResearchJob {
  return {
    topicId: topic.id,
    status: "running",
    startedAt: "2026-07-26T08:00:00.000Z",
    claimedAt: "2026-07-26T08:00:00.000Z",
    perspectives: pendingPerspectives(),
    topicHash: topicHashOf(topic.title, topic.description),
  };
}

// ─── 假引擎：按视角分发脚本 ─────────────────────────────────────────────────

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

/** 每路都搜同一个词、读同一页：broker 缓存共享，四路拿到的 id 完全确定（s1/p1/a1） */
const PERSPECTIVE_OK: Call[] = [
  { tool: "search", args: { query: "AI 编程助手 使用率" } },
  { tool: "read_page", args: { url: PAGE_URL } },
  {
    tool: "submit_perspective",
    args: {
      insights: [
        { text: "每天使用的人已过半", source_ids: ["p1"] },
        { text: "维护成本才是真账单", source_ids: ["s1", "p1"] },
      ],
      evidence: [{ claim: "使用率过半", source_id: "p1", quote: REAL_QUOTE }],
      asset_picks: [{ asset_id: "a1", caption: "使用率图" }],
      gaps: ["没找到分语言细分数据"],
    },
  },
];

const BRIEF_OK: Record<string, unknown> = {
  summary: "四路指向一致：工具已普及，分歧在维护成本。",
  tensions: [],
  angle_suggestions: ["算一笔维护账", "从翻车案例倒推"],
  evidence: [{ claim: "使用率过半", source_id: "p1", quote: REAL_QUOTE }],
  asset_picks: [{ asset_id: "a1", caption: "使用率图" }],
};

interface Plan {
  /** 缺省用 PERSPECTIVE_OK；给 [] 表示这一路什么都不提交（no_submit） */
  perspectives?: Partial<Record<PerspectiveName, Call[]>>;
  /** 缺省用 BRIEF_OK；给 [] 表示综合没提交 */
  synthesis?: Array<Record<string, unknown>>;
  /** 每次子运行开始前的副作用钩子（模拟「调研途中选题被删」） */
  hook?: (key: string) => Promise<void>;
}

function perspectiveOf(systemPrompt: string): PerspectiveName | null {
  return (
    PERSPECTIVE_NAMES.find((n) => systemPrompt.includes(`**${PERSPECTIVE_TASK_BOOKS[n].label}**`)) ?? null
  );
}

function planLoop(plan: Plan = {}): typeof runLoop {
  return (async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    const isSynthesis = (opts.tools ?? []).some((t) => t.name === "submit_brief");
    const name = perspectiveOf(opts.systemPrompt);
    await plan.hook?.(isSynthesis ? "synthesis" : (name ?? "?"));

    const calls: Call[] = isSynthesis
      ? (plan.synthesis ?? [BRIEF_OK]).map((args) => ({ tool: "submit_brief", args }))
      : (plan.perspectives?.[name!] ?? PERSPECTIVE_OK);

    for (const call of calls) {
      const tool = (opts.tools ?? []).find((t) => t.name === call.tool);
      if (!tool) throw new Error(`工具未挂载：${call.tool}`);
      await tool.execute(call.args);
    }
    return {
      finalMessage: "",
      turns: calls.length + 1,
      totalTokens: 500,
      toolCallCount: calls.length,
      stopReason: "no_tool_calls",
    };
  }) as unknown as typeof runLoop;
}

function makeRunJob(plan: Plan = {}, warns: string[] = []) {
  return createDeepResearchRunJob({
    dataDir,
    engineConfig: CONFIG,
    brokerDeps: BROKER_DEPS,
    runLoopImpl: planLoop(plan),
    onWarn: (m) => warns.push(m),
  });
}

const codeOf = (perspectives: PerspectiveState[], name: PerspectiveName) =>
  perspectives.find((p) => p.name === name);

// ─── 四路全成 ────────────────────────────────────────────────────────────────

describe("四路全成", () => {
  it("succeeded + 简报 v1 落盘，字段齐全（tensions 显式为空也是合法产出）", async () => {
    const topic = await newTopic();
    const outcome = await makeRunJob()(jobFor(topic));

    expect(outcome.status).toBe("succeeded");
    expect(outcome.briefRevision).toBe(1);
    expect(outcome.perspectives.every((p) => p.status === "succeeded")).toBe(true);

    const brief = await loadBrief(topic.id, 1, dataDir);
    expect(brief).not.toBeNull();
    expect(brief!.schemaVersion).toBe(1);
    expect(brief!.tensions).toEqual([]);
    expect(brief!.missingPerspectives).toEqual([]);
    expect(brief!.perspectives.map((p) => p.name).sort()).toEqual([...PERSPECTIVE_NAMES].sort());
    expect(brief!.evidence).toEqual([{ claim: "使用率过半", quote: REAL_QUOTE, sourceUrl: PAGE_URL }]);
    expect(brief!.assetPicks).toEqual([
      { url: IMAGE_URL, sourcePageUrl: PAGE_URL, caption: "使用率图" },
    ]);
    expect(brief!.gaps).toContain("没找到分语言细分数据");
    expect(brief!.topicHash).toBe(topicHashOf(topic.title, topic.description));
    expect(Number.isNaN(Date.parse(brief!.generatedAt))).toBe(false);
  });

  it("四路撞同一页只出一次网（共用 broker 的全部意义）", async () => {
    const topic = await newTopic();
    let fetches = 0;
    const runJob = createDeepResearchRunJob({
      dataDir,
      engineConfig: CONFIG,
      brokerDeps: {
        ...BROKER_DEPS,
        fetchImpl: async (url: string) => {
          fetches++;
          return BROKER_DEPS.fetchImpl(url);
        },
      },
      runLoopImpl: planLoop(),
      onWarn: () => {},
    });
    await runJob(jobFor(topic));
    expect(fetches).toBe(1);
  });

  it("重跑落 v2，v1 逐字不变（不可变版本 + 原子发布）", async () => {
    const topic = await newTopic();
    const runJob = makeRunJob();
    await runJob(jobFor(topic));
    const v1Raw = await fs.readFile(briefPath(topic.id, 1, dataDir), "utf-8");

    const second = await runJob(jobFor(topic));
    expect(second.briefRevision).toBe(2);
    expect(await fs.readFile(briefPath(topic.id, 1, dataDir), "utf-8")).toBe(v1Raw);
    expect((await loadLatestBrief(topic.id, dataDir))?.revision).toBe(2);
  });
});

// ─── 部分成功 / 失败 ────────────────────────────────────────────────────────

describe("视角缺席", () => {
  it("两路失败 → partial，简报点名缺失视角，失败原因逐条落在 job 上", async () => {
    const topic = await newTopic();
    const warns: string[] = [];
    const outcome = await makeRunJob({ perspectives: { counter: [], benchmark: [] } }, warns)(jobFor(topic));

    expect(outcome.status).toBe("partial");
    expect(outcome.briefRevision).toBe(1);
    expect(codeOf(outcome.perspectives, "counter")).toEqual({
      name: "counter",
      status: "failed",
      errorCode: "no_submit",
    });
    expect(codeOf(outcome.perspectives, "audience")?.status).toBe("succeeded");
    expect(warns.join("\n")).toContain("counter");

    const brief = await loadLatestBrief(topic.id, dataDir);
    expect(brief!.missingPerspectives.sort()).toEqual(["benchmark", "counter"]);
    expect(brief!.perspectives).toHaveLength(2);
  });

  it("三路失败 → failed(too_few_perspectives)，一份简报都不产", async () => {
    const topic = await newTopic();
    const outcome = await makeRunJob({
      perspectives: { evidence: [], counter: [], benchmark: [] },
    })(jobFor(topic));

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("too_few_perspectives");
    expect(outcome.failReason).toContain("counter");
    expect(outcome.briefRevision).toBeUndefined();
    await expect(fs.readdir(briefsDir(dataDir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("某一路卡死 → deadline 判它出局，其余三路照常出简报", async () => {
    const topic = await newTopic();
    const normal = planLoop();
    const outcome = await createDeepResearchRunJob({
      dataDir,
      engineConfig: CONFIG,
      brokerDeps: BROKER_DEPS,
      perspectiveDeadlineMs: 30,
      runLoopImpl: ((cfg: EngineConfig, opts: LoopOptions) =>
        perspectiveOf(opts.systemPrompt) === "counter"
          ? new Promise<LoopResult>(() => {}) // 永不返回：runLoop 不可中断，只能丢弃
          : normal(cfg, opts)) as unknown as typeof runLoop,
      onWarn: () => {},
    })(jobFor(topic));

    expect(outcome.status).toBe("partial");
    expect(codeOf(outcome.perspectives, "counter")).toEqual({
      name: "counter",
      status: "failed",
      errorCode: "deadline",
    });
    expect((await loadLatestBrief(topic.id, dataDir))!.missingPerspectives).toEqual(["counter"]);
  });
});

// ─── 选题生命周期 ───────────────────────────────────────────────────────────

describe("选题生命周期", () => {
  it("选题不存在 → failed(topic_missing)，不跑任何子运行", async () => {
    let loops = 0;
    const runJob = createDeepResearchRunJob({
      dataDir,
      engineConfig: CONFIG,
      brokerDeps: BROKER_DEPS,
      runLoopImpl: ((cfg: EngineConfig, opts: LoopOptions) => {
        loops++;
        return planLoop()(cfg, opts);
      }) as unknown as typeof runLoop,
      onWarn: () => {},
    });

    const outcome = await runJob({
      topicId: "topic-gone",
      status: "running",
      startedAt: "2026-07-26T08:00:00.000Z",
      perspectives: pendingPerspectives(),
      topicHash: "x",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("topic_missing");
    expect(loops).toBe(0);
  });

  it("选题在回收站 → failed(topic_missing)", async () => {
    const topic = await newTopic();
    await softDeleteTopic(topic.id, dataDir);
    const outcome = await makeRunJob()(jobFor(topic));
    expect(outcome.errorCode).toBe("topic_missing");
  });

  it("调研途中选题被删 → 停在综合前，failed 且不产简报", async () => {
    const topic = await newTopic();
    let synthesisRuns = 0;
    const outcome = await makeRunJob({
      hook: async (key) => {
        if (key === "synthesis") synthesisRuns++;
        if (key === "counter") await softDeleteTopic(topic.id, dataDir);
      },
    })(jobFor(topic));

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("topic_missing");
    expect(synthesisRuns).toBe(0);
    expect(outcome.perspectives.every((p) => p.status === "succeeded")).toBe(true); // 视角成绩保留
    await expect(fs.readdir(briefsDir(dataDir))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ─── 综合与写盘的失败 ───────────────────────────────────────────────────────

describe("综合 / 写盘失败", () => {
  it("综合没提交 → failed(synthesis_failed)，视角的成功记录保留", async () => {
    const topic = await newTopic();
    const outcome = await makeRunJob({ synthesis: [] })(jobFor(topic));

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("synthesis_failed");
    expect(outcome.failReason).toContain("no_submit");
    expect(outcome.perspectives.every((p) => p.status === "succeeded")).toBe(true);
    await expect(fs.readdir(briefsDir(dataDir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("写盘失败 → failed(brief_write_failed)，原因可见", async () => {
    const topic = await newTopic();
    await fs.mkdir(path.join(dataDir, "research"), { recursive: true });
    await fs.writeFile(briefsDir(dataDir), "我是个文件，不是目录", "utf-8"); // 让 mkdir 撞车

    const outcome = await makeRunJob()(jobFor(topic));
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("brief_write_failed");
    expect(outcome.failReason).toContain("简报写盘失败");
  });
});

// ─── 进度时序（装进真 runner，看 SSE 侧看到的序列） ─────────────────────────

describe("视角进度实时可见", () => {
  it("每路启动/落定都写台账，状态只进不退，最后一条是落定的 job", async () => {
    const topic = await newTopic();
    const seen: Array<{ status: string; perspectives: PerspectiveState[] }> = [];
    const record = (job: ResearchJob) => seen.push({ status: job.status, perspectives: job.perspectives });
    const runJob = createDeepResearchRunJob({
      dataDir,
      engineConfig: CONFIG,
      brokerDeps: BROKER_DEPS,
      runLoopImpl: planLoop(),
      onWarn: () => {},
      // 装配时这条与 runner 的 onJobChanged 接同一个 SSE 发射器
      onProgress: record,
    });
    const runner = createResearchRunner({
      dataDir,
      runJob,
      onError: () => {},
      onJobChanged: record,
    });

    await runner.trigger(topic.id);
    await runner.idle();
    runner.stop();

    // queued → running → 至少 8 次进度（四路各 2 次）→ 落定
    expect(seen.length).toBeGreaterThanOrEqual(10);
    expect(seen[0].status).toBe("queued");
    expect(seen[0].perspectives.every((p) => p.status === "pending")).toBe(true);
    expect(seen.at(-1)!.status).toBe("succeeded");
    expect(seen.at(-1)!.perspectives.every((p) => p.status === "succeeded")).toBe(true);

    // 中途确实看得见「有的在跑、有的还没开始」，而不是一次性从 pending 跳到全成
    expect(seen.some((s) => s.perspectives.some((p) => p.status === "running"))).toBe(true);

    // 单调：任何一路都不许从 succeeded 退回 running/pending（并发读改写丢更新的典型症状）
    const rank = { pending: 0, running: 1, succeeded: 2, failed: 2 };
    for (const name of PERSPECTIVE_NAMES) {
      const track = seen.map((s) => rank[codeOf(s.perspectives, name)!.status]);
      expect(track).toEqual([...track].sort((a, b) => a - b));
    }
  });
});
