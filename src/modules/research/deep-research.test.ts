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

import { createDeepResearchRunJob, type DeepResearchDeps } from "./deep-research.js";
import {
  briefPath,
  briefsDir,
  isAngleCardV3,
  loadBrief,
  loadLatestBrief,
  type ResearchBrief,
} from "./brief-store.js";
import {
  FetchImageError,
  type FetchImageErrorCode,
  type FetchedImage,
  type fetchExternalImage,
} from "./fetch-image.js";
import type { BrokerActivity } from "./research-broker.js";
import { listResearchAssets } from "./research-asset-store.js";
import { PERSPECTIVE_TASK_BOOKS } from "./research-perspectives.js";
import {
  PERSPECTIVE_NAMES,
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type PerspectiveName,
  type PerspectiveState,
  type ResearchJob,
} from "./research-job-store.js";
import { createResearchRunner } from "./research-runner.js";
import { saveTopic, softDeleteTopic, updateTopic, type Topic } from "../../storage/local-store.js";
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

const IMAGE_URL_2 = "https://example.com/table.png";

const BROKER_DEPS = {
  searchImpl: async () => [{ title: "2026 开发者调查", url: PAGE_URL, snippet: "每天使用比例过半" }],
  fetchImpl: async (url: string) => ({
    finalUrl: url,
    text: PAGE_TEXT,
    title: "2026 开发者调查",
    imageCandidates: [
      { url: IMAGE_URL, sourceAttr: "img" as const },
      { url: IMAGE_URL_2, sourceAttr: "img" as const },
    ],
  }),
};

// ─── 素材下载桩：管线测试一律零出网 ─────────────────────────────────────────

/** 手搓 PNG 头（只需要「一段确定的、能被 store 收下的字节」） */
function pngBytes(seed: string): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(800, 16);
  head.writeUInt32BE(600, 20);
  return Buffer.concat([head, Buffer.from(seed, "utf-8")]);
}

/** 缺省全成；`fails` 里点名的 URL 抛指定错误码 */
function stubFetchImage(fails: Record<string, FetchImageErrorCode> = {}): typeof fetchExternalImage {
  return (async (url: string): Promise<FetchedImage> => {
    const code = fails[url];
    if (code) throw new FetchImageError(code, `桩：${url} 下载失败`);
    return { bytes: pngBytes(url), format: "png", width: 800, height: 600, finalUrl: url };
  }) as unknown as typeof fetchExternalImage;
}

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

/** 角度卡（角度卡 spec §1.2）：综合这一步必交 2-4 张，两张之间论点与禁区必须真的不同 */
const ANGLE_CARDS_OK: Array<Record<string, unknown>> = [
  {
    angle: "算一笔维护账",
    thesis: "省下的编码时间被维护成本吃回去了，净收益接近于零",
    core_evidence_ids: ["ev-1"],
    anti_scope: "不写工具横评、不写怎么写 prompt",
    audience_pain: "老板拿提效数字压 KPI，自己却在给 AI 擦屁股",
    hold_trigger: "看到自己上周那笔返工账被算了出来",
    hook_draft: "提效 55% 是真的，只是账没算完。",
  },
  {
    angle: "从翻车案例倒推",
    thesis: "翻车集中在重构类任务，说明它擅长的是补全不是设计",
    core_evidence_ids: ["ev-1"],
    anti_scope: "不做成本测算、不谈团队管理",
    audience_pain: "以为是自己不会用，其实是任务类型选错了",
    hold_trigger: "第一个案例就是他昨天踩过的那种坑",
    hook_draft: "同一个工具，写新函数很神，一动老代码就废。",
  },
];

const BRIEF_OK: Record<string, unknown> = {
  summary: "四路指向一致：工具已普及，分歧在维护成本。",
  tensions: [],
  angle_suggestions: ["算一笔维护账", "从翻车案例倒推"],
  angle_cards: ANGLE_CARDS_OK,
  evidence: [{ claim: "使用率过半", source_id: "p1", quote: REAL_QUOTE }],
  asset_picks: [{ asset_id: "a1", caption: "使用率图" }],
};

/** 立意 pass（P1 §4.1）：综合之后的独立一 pass，产角度卡 v3 */
function angleCand(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    primary_persona: "grow",
    angle: "算一笔维护账",
    thesis: "省下的编码时间被维护成本吃回去了，净收益接近于零",
    evidence_level: "grounded",
    core_evidence_ids: ["ev-1"],
    misconception: "以为提效数字等于净收益",
    mechanism: "补全省下的是打字时间，维护花的是理解时间；理解更贵，所以账会反过来",
    payoff: "你会知道该拿哪一段时间去比，今天就把上周的返工时间记一次",
    next_action: "把上周被 AI 改过的代码返工时间记下来",
    counter_response: "有人会说熟练了就好——熟练解决的是打字，不是理解成本",
    persona_gains: { grow: "听懂提效数字怎么骗人", trust: "有可复算的账", convert: "知道验收该验什么" },
    elements: ["新奇点", "爽点"],
    evidence_needs: ["返工时长的公开统计"],
    structure: "myth-busting",
    hook_draft: "提效 55% 是真的，只是账没算完。",
    anti_scope: "不写工具横评、不写怎么写 prompt",
    ...over,
  };
}

const ANGLES_OK: Record<string, unknown> = {
  misconceptions: { grow: ["提效等于净收益"], trust: ["新工具都差不多"], convert: ["买了就等于落地"] },
  candidates: [
    angleCand(),
    angleCand({
      angle: "从翻车案例倒推",
      primary_persona: "trust",
      thesis: "翻车集中在重构类任务，说明它擅长补全而不是设计",
      anti_scope: "不做成本测算、不谈团队管理",
      elements: ["痛点→理想状态", "泪点"],
    }),
    angleCand({
      angle: "验收标准换一个",
      primary_persona: "convert",
      thesis: "该被考核的不是生成速度，而是改完之后谁能读懂",
      anti_scope: "不谈选型、不谈价格",
      elements: ["美点", "爽点"],
    }),
  ],
};

interface Plan {
  /** 缺省用 PERSPECTIVE_OK；给 [] 表示这一路什么都不提交（no_submit） */
  perspectives?: Partial<Record<PerspectiveName, Call[]>>;
  /** 缺省用 BRIEF_OK；给 [] 表示综合没提交 */
  synthesis?: Array<Record<string, unknown>>;
  /** 缺省用 ANGLES_OK；给 [] 表示立意 pass 没提交（no_submit） */
  angles?: Array<Record<string, unknown>>;
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
    const has = (tool: string) => (opts.tools ?? []).some((t) => t.name === tool);
    const isSynthesis = has("submit_brief");
    const isAngle = has("submit_angles");
    const name = perspectiveOf(opts.systemPrompt);
    await plan.hook?.(isSynthesis ? "synthesis" : isAngle ? "angles" : (name ?? "?"));

    const calls: Call[] = isSynthesis
      ? (plan.synthesis ?? [BRIEF_OK]).map((args) => ({ tool: "submit_brief", args }))
      : isAngle
        ? (plan.angles ?? [ANGLES_OK]).map((args) => ({ tool: "submit_angles", args }))
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

function makeRunJob(
  plan: Plan = {},
  warns: string[] = [],
  assetDownloadDeps: DeepResearchDeps["assetDownloadDeps"] = { fetchImageImpl: stubFetchImage() },
) {
  return createDeepResearchRunJob({
    dataDir,
    engineConfig: CONFIG,
    brokerDeps: BROKER_DEPS,
    runLoopImpl: planLoop(plan),
    onWarn: (m) => warns.push(m),
    assetDownloadDeps,
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
    expect(brief!.assetPicks).toHaveLength(1);
    expect(brief!.assetPicks[0]).toMatchObject({
      url: IMAGE_URL,
      sourcePageUrl: PAGE_URL,
      caption: "使用率图",
    });
    expect(brief!.assetPicks[0].assetId).toMatch(/^rasset-/); // 下载成功 → 已入素材库
    expect(brief!.assetPicks[0].downloadError).toBeUndefined();
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
      assetDownloadDeps: { fetchImageImpl: stubFetchImage() },
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

// ─── 素材下载（§7：入库 / 逐张降级 / 预算 / 全败点名） ───────────────────────

describe("素材下载", () => {
  /** 综合挑两张图（a1/a2 由 broker 读页时确定性登记），好看清「一成一败」 */
  const TWO_PICKS: Plan = {
    synthesis: [
      {
        ...BRIEF_OK,
        asset_picks: [
          { asset_id: "a1", caption: "使用率图" },
          { asset_id: "a2", caption: "成本表" },
        ],
      },
    ],
  };

  const picksOf = async (topicId: string) => (await loadLatestBrief(topicId, dataDir))!.assetPicks;

  it("全成：两张都带 assetId 进简报，素材库里各一条 candidate", async () => {
    const topic = await newTopic();
    const outcome = await makeRunJob(TWO_PICKS)(jobFor(topic));
    expect(outcome.status).toBe("succeeded");

    const picks = await picksOf(topic.id);
    expect(picks.map((p) => p.url)).toEqual([IMAGE_URL, IMAGE_URL_2]);
    expect(picks.every((p) => p.assetId && !p.downloadError)).toBe(true);

    const stored = await listResearchAssets(topic.id, dataDir);
    expect(stored).toHaveLength(2);
    expect(stored.every((a) => a.status === "candidate" && a.license === "unknown")).toBe(true);
    expect(stored.map((a) => a.sourcePageUrl)).toEqual([PAGE_URL, PAGE_URL]);
  });

  it("部分失败：失败那张降级为仅链接 + 人话原因，成功那张不受影响", async () => {
    const topic = await newTopic();
    const warns: string[] = [];
    const outcome = await makeRunJob(TWO_PICKS, warns, {
      fetchImageImpl: stubFetchImage({ [IMAGE_URL_2]: "http_403" }),
    })(jobFor(topic));

    // 下载失败不参与 job 终态判定
    expect(outcome.status).toBe("succeeded");

    const picks = await picksOf(topic.id);
    expect(picks[0].assetId).toMatch(/^rasset-/);
    expect(picks[1].assetId).toBeUndefined();
    expect(picks[1].url).toBe(IMAGE_URL_2); // 降级 ≠ 删除：链接还在
    expect(picks[1].downloadError).toContain("防盗链");
    expect(await listResearchAssets(topic.id, dataDir)).toHaveLength(1);
    expect(warns.join("\n")).toContain("1 张降级为仅链接");
  });

  it.each([
    ["张数", { maxCount: 1 }],
    ["字节", { maxTotalBytes: 1 }],
  ])("预算触顶（%s）：超出的直接降级，原因说得出口", async (_label, budget) => {
    const topic = await newTopic();
    await makeRunJob(TWO_PICKS, [], { fetchImageImpl: stubFetchImage(), ...budget })(jobFor(topic));

    const picks = await picksOf(topic.id);
    expect(picks[0].assetId).toMatch(/^rasset-/); // 第一张在预算内
    expect(picks[1].assetId).toBeUndefined();
    expect(picks[1].downloadError).toContain("预算已用尽");
  });

  it("墙钟触顶：deadline 过了就不再下一张", async () => {
    const topic = await newTopic();
    let clock = 0;
    await makeRunJob(TWO_PICKS, [], {
      fetchImageImpl: stubFetchImage(),
      deadlineMs: 100,
      now: () => (clock += 80), // 第二张之前就已越过 deadline
    })(jobFor(topic));

    const picks = await picksOf(topic.id);
    expect(picks[1].downloadError).toContain("预算已用尽");
  });

  it("全军覆没 → 简报 gaps 点名，且 job 仍是 succeeded", async () => {
    const topic = await newTopic();
    const outcome = await makeRunJob(TWO_PICKS, [], {
      fetchImageImpl: stubFetchImage({ [IMAGE_URL]: "timeout", [IMAGE_URL_2]: "ssrf_blocked" }),
    })(jobFor(topic));
    expect(outcome.status).toBe("succeeded");

    const brief = await loadLatestBrief(topic.id, dataDir);
    expect(brief!.assetPicks.every((p) => !p.assetId && p.downloadError)).toBe(true);
    expect(brief!.assetPicks[0].downloadError).toContain("超时");
    expect(brief!.assetPicks[1].downloadError).toContain("内网");
    expect(brief!.gaps.some((g) => g.includes("一张都没能下载"))).toBe(true);
    expect(await listResearchAssets(topic.id, dataDir)).toEqual([]);
  });

  it("入库失败（素材目录被文件占位）也只降级这一张，简报照常落盘", async () => {
    const topic = await newTopic();
    await fs.mkdir(path.join(dataDir, "research"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "research", "assets"), "我是个文件，不是目录", "utf-8");

    const outcome = await makeRunJob(TWO_PICKS)(jobFor(topic));
    expect(outcome.status).toBe("succeeded");
    const picks = await picksOf(topic.id);
    expect(picks.every((p) => p.downloadError === "存入素材库失败，只保留链接")).toBe(true);
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
      assetDownloadDeps: { fetchImageImpl: stubFetchImage() },
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
      assetDownloadDeps: { fetchImageImpl: stubFetchImage() },
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

describe("检索活动可见", () => {
  it("onActivity 一路穿到 broker：真出网各发一条，缓存命中的三路不重复刷屏", async () => {
    const topic = await newTopic();
    const seen: BrokerActivity[] = [];
    const runJob = createDeepResearchRunJob({
      dataDir,
      engineConfig: CONFIG,
      brokerDeps: BROKER_DEPS,
      runLoopImpl: planLoop(),
      onWarn: () => {},
      assetDownloadDeps: { fetchImageImpl: stubFetchImage() },
      onActivity: (a) => seen.push(a),
    });

    const outcome = await runJob(jobFor(topic));
    expect(outcome.status).toBe("succeeded");

    // 四路搜同一个词、读同一页：只有先到的那一路真出网，其余三路吃缓存
    const searches = seen.filter((a) => a.action === "search");
    const reads = seen.filter((a) => a.action === "read_page");
    expect(searches).toHaveLength(1);
    expect(searches[0].detail).toBe("AI 编程助手 使用率");
    expect(reads).toHaveLength(1);
    expect(reads[0].detail).toBe("example.com"); // 只报 host
    for (const a of seen) expect(PERSPECTIVE_NAMES).toContain(a.perspective as PerspectiveName);
  });
});

// ─── 立意 pass（P1 spec §4.1）：独立一 pass，失败不带走整条 job ──────────────

describe("立意 pass", () => {
  it("成功 → 简报里落的是卡 v3（带代码打的分），覆盖综合那批候选", async () => {
    const topic = await newTopic();
    const outcome = await makeRunJob()(jobFor(topic));
    expect(outcome.status).toBe("succeeded");

    const brief = await loadLatestBrief(topic.id, dataDir);
    const cards = brief!.angleCards ?? [];
    expect(cards).toHaveLength(3);
    expect(cards.every((c) => isAngleCardV3(c))).toBe(true);
    expect(cards.map((c) => c.id)).toEqual(["angle-1", "angle-2", "angle-3"]);
    const first = cards[0];
    expect(isAngleCardV3(first) && first.score).toBe(4); // 元素 2 + grounded 1 + 主画像 grow 1
    expect(brief!.gaps.some((g) => g.startsWith("立意未产出"))).toBe(false);
  });

  it("立意没提交 → job 照常 succeeded，原因写进 gaps 并从 warn 冒出来", async () => {
    const topic = await newTopic();
    const warns: string[] = [];
    const outcome = await makeRunJob({ angles: [] }, warns)(jobFor(topic));
    expect(outcome.status).toBe("succeeded"); // 立意失败绝不让整条调研失败

    const brief = await loadLatestBrief(topic.id, dataDir);
    expect(brief!.gaps.some((g) => g.startsWith("立意未产出"))).toBe(true);
    expect(warns.join("")).toContain("立意未产出（no_submit）");
    // 本刀不动综合产地：立意失败时，综合那批 v2 卡还在，写稿不至于一张候选都没有
    expect((brief!.angleCards ?? []).every((c) => !isAngleCardV3(c))).toBe(true);
  });

  it("立意交了不合规的候选（元素只有 1 个）→ invalid_output 进 gaps", async () => {
    const topic = await newTopic();
    const bad = { ...ANGLES_OK, candidates: [angleCand({ elements: ["爽点"] })] };
    const outcome = await makeRunJob({ angles: [bad] })(jobFor(topic));
    expect(outcome.status).toBe("succeeded");

    const brief = await loadLatestBrief(topic.id, dataDir);
    expect(brief!.gaps.join("")).toContain("网感元素需 ≥2");
  });
});


// ─── angles job（P1 spec §3.5）：只重跑立意，事实原样抄 ──────────────────────

describe("angles job", () => {
  /** 先跑一轮 full 把简报 v1 与指针备好——angles job 的输入就是「当前生效简报」 */
  async function seedBrief(topic: Topic): Promise<ResearchBrief> {
    const outcome = await makeRunJob()(jobFor(topic));
    expect(outcome.status).toBe("succeeded");
    await upsertJob(
      {
        ...jobFor(topic),
        status: "succeeded",
        claimedAt: undefined,
        settledAt: "2026-07-26T08:06:00.000Z",
        briefRevision: outcome.briefRevision,
      },
      dataDir,
    );
    return (await loadBrief(topic.id, 1, dataDir))!;
  }

  function anglesJob(topic: Topic): ResearchJob {
    return { ...jobFor(topic), kind: "angles", perspectives: [], briefRevision: 1 };
  }

  it("事实字段逐字照抄 + 新卡 + 新 revision，回执不带视角", async () => {
    const topic = await newTopic();
    const v1 = await seedBrief(topic);

    // 第二轮立意换一批卡：证明新简报里的卡确实是这一轮产的
    const relit = {
      ...ANGLES_OK,
      candidates: [
        angleCand({ angle: "把维护账摊开算", thesis: "省下的编码时间被维护成本吃回去，净收益接近于零" }),
        angleCand({
          angle: "验收标准换一个",
          primary_persona: "convert",
          thesis: "该被考核的不是生成速度，而是改完之后谁能读懂",
          anti_scope: "不谈选型、不谈价格",
          elements: ["美点", "爽点"],
        }),
        angleCand({
          angle: "从翻车案例倒推",
          primary_persona: "trust",
          thesis: "翻车集中在重构类任务，说明它擅长补全而不是设计",
          anti_scope: "不做成本测算、不谈团队管理",
          elements: ["痛点→理想状态", "泪点"],
        }),
      ],
    };
    const outcome = await makeRunJob({ angles: [relit] })(anglesJob(topic));

    expect(outcome).toMatchObject({ status: "succeeded", briefRevision: 2, perspectives: [] });

    const v2 = (await loadBrief(topic.id, 2, dataDir))!;
    expect(v2.summary).toBe(v1.summary);
    expect(v2.evidence).toEqual(v1.evidence);
    expect(v2.assetPicks).toEqual(v1.assetPicks);
    expect(v2.perspectives).toEqual(v1.perspectives);
    expect(v2.tensions).toEqual(v1.tensions);
    expect(v2.missingPerspectives).toEqual(v1.missingPerspectives);
    expect(v2.gaps).toEqual(v1.gaps);
    expect(v2.revision).toBe(2);
    expect(v2.topicHash).toBe(topicHashOf(topic.title, topic.description));
    expect(Date.parse(v2.generatedAt)).toBeGreaterThanOrEqual(Date.parse(v1.generatedAt));

    const cards = v2.angleCards ?? [];
    expect(cards.map((c) => c.angle)).toEqual(["把维护账摊开算", "验收标准换一个", "从翻车案例倒推"]);
    expect(cards.every((c) => isAngleCardV3(c))).toBe(true);
    // v1 逐字不变（不可变版本）
    expect((await loadBrief(topic.id, 1, dataDir))!.angleCards?.[0].angle).toBe("算一笔维护账");
  });

  it("立意失败 → job failed(angle_failed)，一份新简报都不落", async () => {
    const topic = await newTopic();
    await seedBrief(topic);
    const warns: string[] = [];
    const outcome = await makeRunJob({ angles: [] }, warns)(anglesJob(topic));

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("angle_failed");
    expect(String(outcome.failReason)).toContain("no_submit");
    expect(outcome.perspectives).toEqual([]);
    // 只换卡的新版本没有卡就毫无意义：不落盘，指针留在 v1
    expect(await loadBrief(topic.id, 2, dataDir)).toBeNull();
    expect((await loadLatestBrief(topic.id, dataDir))!.revision).toBe(1);
  });

  it("没有生效简报 → no_brief（绝不拿磁盘上那份没被采纳的顶上）", async () => {
    const topic = await newTopic();
    const outcome = await makeRunJob()(anglesJob(topic));
    expect(outcome).toMatchObject({ status: "failed", errorCode: "no_brief", perspectives: [] });
    expect(String(outcome.failReason)).toContain("先跑一轮深调研");
  });

  it("选题正文在上一轮之后改过 → 照跑，但把「基于旧版选题」写进 gaps", async () => {
    const topic = await newTopic();
    const v1 = await seedBrief(topic);
    const renamed = (await updateTopic(topic.id, { title: "AI 编程助手横评（2026 版）" }, dataDir))!;

    const outcome = await makeRunJob()({ ...anglesJob(topic), topicHash: topicHashOf(renamed.title, renamed.description) });
    expect(outcome.status).toBe("succeeded");

    const v2 = (await loadBrief(topic.id, 2, dataDir))!;
    expect(v2.topicHash).toBe(topicHashOf(renamed.title, renamed.description));
    expect(v2.topicHash).not.toBe(v1.topicHash);
    expect(v2.gaps.some((g) => g.includes("仍基于旧版选题"))).toBe(true);
  });
});
