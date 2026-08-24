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

/** 一张合法角度卡；差异性靠 thesis+anti_scope，改这两处才能造出「同角度换皮」 */
function angleCard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    angle: "算一笔维护账",
    thesis: "省下的编码时间被维护成本吃回去了，净收益接近于零",
    core_evidence_ids: ["ev-1"],
    anti_scope: "不写工具横评、不写怎么写 prompt",
    audience_pain: "老板拿提效数字压 KPI，自己却在给 AI 擦屁股",
    hold_trigger: "看到自己上周那笔返工账被算了出来",
    hook_draft: "提效 55% 是真的，只是账没算完。",
    ...over,
  };
}

const CARD_B = {
  angle: "从翻车案例倒推",
  thesis: "翻车集中在重构类任务，说明它擅长的是补全不是设计",
  anti_scope: "不做成本测算、不谈团队管理",
  audience_pain: "以为是自己不会用，其实是任务类型选错了",
  hold_trigger: "第一个案例就是他昨天踩过的那种坑",
  hook_draft: "同一个工具，写新函数很神，一动老代码就废。",
};

function briefArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "工具已经普及，真正的分歧在维护成本。",
    tensions: [],
    angle_suggestions: ["算一笔维护账", "从翻车案例倒推"],
    angle_cards: [angleCard(), angleCard(CARD_B)],
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

// ─── 角度卡（角度卡 spec §1.2）──────────────────────────────────────────────
//
// 断言全在确定性层：id 由代码按位置编、证据引用由代码验存在性、张数与差异性由代码判。
// 卡上的文字是 LLM 写的，一个字都不断言。

describe("角度卡产出与校验", () => {
  it("合法两张 → id 按位置编（angle-1/angle-2），字段原样进简报", async () => {
    const cap = newCapture();
    const res = await synth([briefArgs()], cap);
    if (res.status !== "succeeded") throw new Error("应当成功");

    const cards = res.payload.angleCards ?? [];
    expect(cards.map((c) => c.id)).toEqual(["angle-1", "angle-2"]);
    expect(cards[0].coreEvidenceIds).toEqual(["ev-1"]);
    expect(cards[0].tensionId).toBeUndefined(); // 张力点为空 → 不硬编
    for (const c of cards) {
      for (const field of [c.angle, c.thesis, c.antiScope, c.audiencePain, c.holdTrigger, c.hookDraft]) {
        expect(field.length).toBeGreaterThan(0);
      }
    }
    expect(cap.results[0]).not.toMatch(/^Error/);
  });

  it("张数不足 2 / 超过 4：不足打回，超出只取前 4 张", async () => {
    const one = newCapture();
    const res = await synth([briefArgs({ angle_cards: [angleCard()] })], one);
    expect(one.results[0]).toContain("angle_cards 需 2-4 张");
    expect(res.status).toBe("failed");

    // 五张里前四张两两不同 → 收下前 4 张,不为「多交了」耗修复轮
    const five = newCapture();
    const variants = [
      { thesis: "省下的编码时间被维护成本吃回去了", anti_scope: "不写工具横评" },
      { thesis: "翻车集中在重构类任务，它擅长补全不擅长设计", anti_scope: "不做成本测算" },
      { thesis: "真正被替代的是初级岗位的练手机会", anti_scope: "回避一切技术细节" },
      { thesis: "买单的是老板，承担返工的是工程师", anti_scope: "别谈模型能力边界" },
      { thesis: "开源方案两年内会把这一层利润抹平", anti_scope: "不讲个人使用技巧" },
    ].map((over) => angleCard(over));
    const many = await synth([briefArgs({ angle_cards: variants })], five);
    if (many.status !== "succeeded") throw new Error("应当成功");
    expect(many.payload.angleCards).toHaveLength(4);
  });

  it("core_evidence_ids 指向不存在的证据 → 打回并说清有几条可引", async () => {
    const cap = newCapture();
    const res = await synth([briefArgs({ angle_cards: [angleCard({ core_evidence_ids: ["ev-7"] }), angleCard(CARD_B)] })], cap);
    expect(cap.results[0]).toContain("ev-7");
    expect(cap.results[0]).toContain("只有 1 条证据");
    expect(res.status).toBe("failed");
  });

  it("一条证据都不引 → 打回（没有证据的论点是臆测）", async () => {
    const cap = newCapture();
    await synth([briefArgs({ angle_cards: [angleCard({ core_evidence_ids: [] }), angleCard(CARD_B)] })], cap);
    expect(cap.results[0]).toContain("至少要引 1 条证据");
  });

  it("tension_id 引不到 → 打回；简报有张力点时引得到就收下", async () => {
    const bad = newCapture();
    await synth([briefArgs({ angle_cards: [angleCard({ tension_id: "tension-1" }), angleCard(CARD_B)] })], bad);
    expect(bad.results[0]).toContain("tension-1");

    const good = newCapture();
    const res = await synth(
      [
        briefArgs({
          tensions: ["厂商宣称提效 55%，独立评测只测到 12%"],
          angle_cards: [angleCard({ tension_id: "tension-1" }), angleCard(CARD_B)],
        }),
      ],
      good,
    );
    if (res.status !== "succeeded") throw new Error("应当成功");
    expect(res.payload.angleCards?.[0].tensionId).toBe("tension-1");
  });

  it("两张卡是同一个角度换皮 → 差异性粗筛打回", async () => {
    const cap = newCapture();
    const twin = angleCard({
      // 只把「吃回去」换成「抵消掉」：论点与禁区几乎逐字相同 = 五卡一角度的典型形态
      thesis: "省下的编码时间被维护成本抵消掉了，净收益接近于零",
    });
    const res = await synth([briefArgs({ angle_cards: [angleCard(), twin] })], cap);

    expect(cap.results[0]).toContain("同一个角度换套说法");
    expect(res.status).toBe("failed");
  });

  it("字段缺一 → 打回并点名是哪一张", async () => {
    const cap = newCapture();
    await synth([briefArgs({ angle_cards: [angleCard({ anti_scope: "  " }), angleCard(CARD_B)] })], cap);
    expect(cap.results[0]).toContain("angle_cards[0]");
    expect(cap.results[0]).toContain("anti_scope");
  });

  it("一条证据都没挑出来 → 不硬出角度卡（§1.8），缺席进 gaps 且简报照常成立", async () => {
    const cap = newCapture();
    const res = await synth([briefArgs({ evidence: [], angle_cards: [] })], cap);

    expect(cap.results[0]).not.toMatch(/^Error/);
    if (res.status !== "succeeded") throw new Error("应当成功");
    expect(res.payload.angleCards).toBeUndefined();
    expect(res.payload.gaps.join("；")).toContain("未产出角度卡");
  });
});
