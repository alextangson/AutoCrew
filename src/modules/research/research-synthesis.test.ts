/**
 * research-synthesis.test.ts — 综合子运行（深调研 §5）。
 *
 * 引擎打桩、broker 是真 broker（假 search/fetch 喂料）。断言集中在确定性层：
 * id→URL 解析、去重、gaps 合成、张力允许为空、伪造证据被打回。
 */
import { describe, it, expect } from "vitest";

import { createResearchBroker, type ResearchBrokerDeps, type ResearchBroker } from "./research-broker.js";
import { buildSynthesisUserMessage, runSynthesis, type SynthesisInput } from "./research-synthesis.js";
import type { PerspectiveOutput } from "./brief-store.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult, runLoop } from "../../engine/loop.js";

const CONFIG: EngineConfig = {
  apiKey: "sk-test",
  baseUrl: "https://main.test",
  strongModel: "m-strong",
  fastModel: "m-fast",
  routes: { scout: { baseUrl: "https://scout.test", model: "m-scout" } },
};

const TOPIC = { title: "AI 编程助手横评", description: "对比主流工具的真实收益与维护成本" };
const PAGE_URL = "https://example.com/survey";
const PAGE_TEXT = "2026 年开发者调查：62% 的人每天使用 AI 编程助手，但维护成本上升了三成。";
const REAL_QUOTE = "62% 的人每天使用 AI 编程助手";
const IMAGE_URL = "https://example.com/chart.png";

function makeBroker(over: Partial<ResearchBrokerDeps> = {}): ResearchBroker {
  return createResearchBroker({
    searchImpl: async () => [{ title: "2026 开发者调查", url: PAGE_URL, snippet: "每天使用比例过半" }],
    fetchImpl: async (url) => ({
      finalUrl: url,
      text: PAGE_TEXT,
      title: "2026 开发者调查",
      imageCandidates: [{ url: IMAGE_URL, sourceAttr: "img" as const }],
    }),
    ...over,
  });
}

/** 先真的走一遍出网，注册表里才有 s1/p1/a1 可供综合引用 */
async function primed(over: Partial<ResearchBrokerDeps> = {}): Promise<ResearchBroker> {
  const broker = makeBroker(over);
  const handle = broker.forPerspective("evidence");
  await handle.search("AI 编程助手 使用率");
  await handle.readPage(PAGE_URL);
  return broker;
}

function perspective(over: Partial<PerspectiveOutput> = {}): PerspectiveOutput {
  return {
    name: "evidence",
    insights: [
      { text: "每天使用的人已过半", sourceIds: ["p1"] },
      { text: "维护成本是真账单", sourceIds: ["s1"] },
    ],
    evidence: [{ claim: "使用率过半", sourceId: "p1", quote: REAL_QUOTE }],
    assetPicks: [{ assetId: "a1", caption: "使用率图" }],
    gaps: ["没找到分语言细分数据"],
    ...over,
  };
}

interface Capture {
  cfg?: EngineConfig;
  opts?: LoopOptions;
  results: string[];
}

function newCapture(): Capture {
  return { results: [] };
}

function scriptedLoop(argsSeq: Array<Record<string, unknown>>, cap: Capture, tokens = 999): typeof runLoop {
  return (async (cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    cap.cfg = cfg;
    cap.opts = opts;
    const tool = (opts.tools ?? []).find((t) => t.name === "submit_brief");
    if (!tool) throw new Error("submit_brief 未挂载");
    for (const args of argsSeq) cap.results.push(await tool.execute(args));
    return {
      finalMessage: "",
      turns: argsSeq.length + 1,
      totalTokens: tokens,
      toolCallCount: argsSeq.length,
      stopReason: "no_tool_calls",
    };
  }) as unknown as typeof runLoop;
}

function briefArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "工具已经普及，真正的分歧在维护成本。",
    tensions: [],
    angle_suggestions: ["算一笔维护账", "从翻车案例倒推"],
    evidence: [{ claim: "使用率过半", source_id: "p1", quote: REAL_QUOTE }],
    asset_picks: [{ asset_id: "a1", caption: "使用率图" }],
    ...over,
  };
}

async function synth(
  argsSeq: Array<Record<string, unknown>>,
  cap: Capture,
  over: Partial<SynthesisInput> = {},
) {
  const broker = over.broker ?? (await primed());
  return runSynthesis({
    topic: TOPIC,
    perspectiveResults: [perspective(), perspective({ name: "counter", gaps: ["没找到硬反驳"] })],
    ...over,
    broker,
    engineConfig: CONFIG,
    runLoopImpl: scriptedLoop(argsSeq, cap),
  });
}

describe("合法输出直通", () => {
  it("张力显式为空合法；sourceId/assetId 由代码解析成 URL", async () => {
    const cap = newCapture();
    const res = await synth([briefArgs()], cap);

    expect(res.status).toBe("succeeded");
    if (res.status !== "succeeded") return;
    expect(res.payload.tensions).toEqual([]);
    expect(res.payload.angleSuggestions).toHaveLength(2);
    expect(res.payload.evidence).toEqual([
      { claim: "使用率过半", quote: REAL_QUOTE, sourceUrl: PAGE_URL },
    ]);
    expect(res.payload.assetPicks).toEqual([
      { url: IMAGE_URL, sourcePageUrl: PAGE_URL, caption: "使用率图" },
    ]);
    expect(res.tokensUsed).toBe(999);
    expect(cap.results[0]).not.toMatch(/^Error/);
  });

  it("各路 gaps 合并去重进简报（代码合成，不问模型要）", async () => {
    const cap = newCapture();
    const res = await synth([briefArgs()], cap);
    if (res.status !== "succeeded") throw new Error("应当成功");
    expect(res.payload.gaps).toEqual(["没找到分语言细分数据", "没找到硬反驳"]);
  });

  it("同一条证据被多路交上来只留一条", async () => {
    const cap = newCapture();
    const dup = { claim: "使用率过半", source_id: "p1", quote: REAL_QUOTE };
    const res = await synth([briefArgs({ evidence: [dup, { ...dup, claim: "换个说法" }] })], cap);
    if (res.status !== "succeeded") throw new Error("应当成功");
    expect(res.payload.evidence).toHaveLength(1);
  });

  it("summary 超长按上限截断，不为长度浪费修复轮", async () => {
    const cap = newCapture();
    const res = await synth([briefArgs({ summary: "长".repeat(400) })], cap);
    if (res.status !== "succeeded") throw new Error("应当成功");
    expect(res.payload.summary).toHaveLength(200);
    expect(cap.results[0]).not.toMatch(/^Error/);
  });

  it("走 scout 路由，输入含各路产出与检索用量", async () => {
    const cap = newCapture();
    await synth([briefArgs()], cap);
    expect(cap.cfg!.baseUrl).toBe("https://scout.test");
    expect(cap.opts!.model).toBe("m-scout");
    expect(cap.opts!.userMessage).toContain("证据与数据");
    expect(cap.opts!.userMessage).toContain("反方");
    expect(cap.opts!.userMessage).toContain("检索用量");
  });

  it("综合输入里的引文逐字保留（否则模型没法原样重交）", async () => {
    const broker = await primed();
    const message = buildSynthesisUserMessage({
      topic: TOPIC,
      perspectiveResults: [perspective()],
      broker,
    });
    expect(message).toContain(REAL_QUOTE);
  });
});

describe("伪造与降级", () => {
  it("伪造 quote → 打回并带 broker 原因 → 改对即成功", async () => {
    const cap = newCapture();
    const res = await synth(
      [briefArgs({ evidence: [{ claim: "编的", source_id: "p1", quote: "97% 的人已放弃" }] }), briefArgs()],
      cap,
    );
    expect(cap.results[0]).toMatch(/^Error/);
    expect(cap.results[0]).toContain("找不到");
    expect(res.status).toBe("succeeded");
  });

  it("解析不到的 assetId 丢弃并计入 gaps——素材是尽力而为，不为它耗修复轮", async () => {
    const cap = newCapture();
    const res = await synth([briefArgs({ asset_picks: [{ asset_id: "a99", caption: "并不存在" }] })], cap);

    expect(cap.results[0]).not.toMatch(/^Error/);
    if (res.status !== "succeeded") throw new Error("应当成功");
    expect(res.payload.assetPicks).toEqual([]);
    expect(res.payload.gaps.join("；")).toContain("a99");
  });

  it("angle_suggestions 少于 2 条 → 打回（下限补不出来只能退回）", async () => {
    const cap = newCapture();
    const res = await synth([briefArgs({ angle_suggestions: ["只有一个"] })], cap);
    expect(cap.results[0]).toContain("angle_suggestions");
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.errorCode).toBe("invalid_output");
  });

  it("summary 缺失 → 打回", async () => {
    const cap = newCapture();
    await synth([briefArgs({ summary: "  " })], cap);
    expect(cap.results[0]).toContain("summary");
  });

  it("配额耗尽在 gaps 点名（§9.4）", async () => {
    const broker = await primed({ quotas: { searchPerJob: 1, searchPerPerspective: 1 } });
    const cap = newCapture();
    const res = await synth([briefArgs()], cap, { broker });
    if (res.status !== "succeeded") throw new Error("应当成功");
    expect(res.payload.gaps.join("；")).toContain("配额已用尽");
  });

  it("模型没提交 → failed(no_submit)；引擎抛错 → failed(engine_failed)", async () => {
    const cap = newCapture();
    const none = await synth([], cap);
    expect(none.status).toBe("failed");
    if (none.status === "failed") expect(none.errorCode).toBe("no_submit");

    const boom = await runSynthesis({
      topic: TOPIC,
      perspectiveResults: [perspective()],
      broker: await primed(),
      engineConfig: CONFIG,
      runLoopImpl: (async () => {
        throw new Error("502 upstream");
      }) as unknown as typeof runLoop,
    });
    expect(boom.status).toBe("failed");
    if (boom.status === "failed") expect(boom.errorCode).toBe("engine_failed");
  });
});
