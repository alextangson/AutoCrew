/**
 * script-review.test.ts — AI 审稿收敛循环（审稿 spec §2），全注入零网络零真睡。
 *
 * 墙钟一律靠注入的 nowImpl 推进：真睡会让「超时」变成一条随机失败的测试。
 */
import { describe, it, expect } from "vitest";
import { reviewAndConverge } from "./script-review.js";
import type { ReviewInput } from "./script-review.js";
import type { SubmitPayload } from "./script-payload.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult } from "../../engine/loop.js";
import type { QualityGateSpec } from "../packs/pack-schema.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CONFIG: EngineConfig = {
  apiKey: "sk-test",
  baseUrl: "https://engine.test",
  strongModel: "m-strong",
  fastModel: "m-fast",
};

const PAYLOAD: SubmitPayload = {
  title: "普通人怎么用 AI 赚钱",
  hook: "开头一句话",
  body: "正文讲了三件事，每件都配了具体数字。",
  cta: "关注我",
  hashtags: ["#AI"],
};

/** 组装 + humanize 后的终稿形态（审稿读的就是它） */
const TEXT = `${PAYLOAD.hook}\n\n${PAYLOAD.body}\n\n${PAYLOAD.cta}`;

const INPUT: ReviewInput = {
  payload: PAYLOAD,
  humanizedText: TEXT,
  system: "写稿时的 system prompt",
  user: "写稿时的 user prompt",
  voiceSamples: ["我说话就是这个调子。"],
  platform: "douyin",
};

const BLOCKER = {
  severity: "blocker",
  quote: "开头一句话",
  rule: "空转折",
  instruction: "把开头换成一个具体场景",
};

const ADVISORY = {
  severity: "advisory",
  quote: "关注我",
  rule: "结尾升华",
  instruction: "结尾可以再具体一点",
};

/** 修订稿：钩子换了、开头那句引文仍在正文里（下一轮 quote 还能定位到） */
const REVISED: Record<string, unknown> = {
  ...PAYLOAD,
  hook: "去年三月我亏了两万块",
  body: "正文讲了三件事，每件都配了具体数字。开头一句话也留着。",
};

/** 一次 loop 调用内的若干次工具调用；"throw" = 这一轮引擎直接炸 */
type LoopScript = Array<Record<string, unknown>> | "throw";

interface Seen {
  reviewOpts: LoopOptions[];
  reviseOpts: LoopOptions[];
  execResults: string[];
}

/**
 * 剧本化 loop 替身：按工具带认自己扮演哪一轮（submit_review = 审稿，submit_script = 修订），
 * 从对应队列取下一份剧本。队列空 = 测试写漏了，直接炸出来而不是静默通过。
 */
function makeLoop(script: { reviews: LoopScript[]; revisions?: LoopScript[] }) {
  const reviews = [...script.reviews];
  const revisions = [...(script.revisions ?? [])];
  const seen: Seen = { reviewOpts: [], reviseOpts: [], execResults: [] };
  const impl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    const isReview = (opts.tools ?? []).some((t) => t.name === "submit_review");
    (isReview ? seen.reviewOpts : seen.reviseOpts).push(opts);
    const queue = isReview ? reviews : revisions;
    const next = queue.shift();
    if (next === undefined) throw new Error(`替身没有下一轮${isReview ? "审稿" : "修订"}剧本`);
    if (next === "throw") throw new Error("relay 断流：ECONNRESET");
    const tool = (opts.tools ?? [])[0];
    for (const args of next) seen.execResults.push(await tool.execute(args));
    return {
      finalMessage: "ok",
      turns: 1,
      totalTokens: 10,
      toolCallCount: next.length,
      stopReason: "no_tool_calls",
    };
  };
  return { impl, seen };
}

/** 什么都不干的一轮（模型没调工具） */
const SILENT: LoopResult = {
  finalMessage: "我不想调工具",
  turns: 2,
  totalTokens: 5,
  toolCallCount: 0,
  stopReason: "max_turns",
};

// ─── 收敛路径 ────────────────────────────────────────────────────────────────

describe("reviewAndConverge — 收敛", () => {
  it("一轮过：status passed，rounds 0，稿子一个字没动", async () => {
    const { impl, seen } = makeLoop({ reviews: [[{ verdict: "pass", issues: [] }]] });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl });

    expect(out.review.status).toBe("passed");
    expect(out.review.rounds).toBe(0);
    expect(out.review.fixed).toBe(0);
    expect(out.review.issues).toEqual([]);
    expect(out.payload).toEqual(PAYLOAD);
    expect(out.humanizedText).toBe(TEXT);
    expect(Number.isNaN(Date.parse(out.review.reviewedAt))).toBe(false);
    expect(seen.reviseOpts).toHaveLength(0); // 没 blocker 就不该有修订轮
  });

  it("run-log 归属：审稿轮 agent=reviewer，修订轮复用写稿的 system prompt", async () => {
    const { impl, seen } = makeLoop({
      reviews: [[{ verdict: "revise", issues: [BLOCKER] }], [{ verdict: "pass", issues: [] }]],
      revisions: [[REVISED]],
    });
    await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl, runId: "run-x" });

    expect(seen.reviewOpts[0].logMeta).toMatchObject({ agent: "reviewer", runId: "run-x" });
    expect(seen.reviewOpts[0].model).toBe("m-strong"); // 无专属路由 → 落强模型
    expect(seen.reviseOpts[0].systemPrompt).toBe(INPUT.system);
    expect(seen.reviseOpts[0].userMessage).toContain(BLOCKER.instruction);
    expect(seen.reviseOpts[0].userMessage).toContain(INPUT.user); // 同批材料跟着进修订轮
  });

  it("revise → 修订 → 重过 gate → 再审 pass：status revised，最终文本是修订版", async () => {
    const { impl, seen } = makeLoop({
      reviews: [[{ verdict: "revise", issues: [BLOCKER] }], [{ verdict: "pass", issues: [] }]],
      revisions: [[REVISED]],
    });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl });

    expect(out.review.status).toBe("revised");
    expect(out.review.rounds).toBe(1);
    expect(out.review.fixed).toBe(1);
    expect(out.payload.hook).toBe("去年三月我亏了两万块");
    expect(out.humanizedText).toContain("去年三月我亏了两万块");
    expect(out.gateFailures).toEqual([]); // 换稿了就带上修订稿自己的 gate 结果
    expect(seen.reviseOpts).toHaveLength(1);
  });

  it("只有 advisory：不打回，status passed，issues 照样留痕", async () => {
    const { impl, seen } = makeLoop({ reviews: [[{ verdict: "revise", issues: [ADVISORY] }]] });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl });

    expect(out.review.status).toBe("passed");
    expect(out.review.rounds).toBe(0);
    expect(out.review.issues).toHaveLength(1);
    expect(out.review.issues[0]).toMatchObject({ severity: "advisory", rule: "结尾升华" });
    expect(seen.reviseOpts).toHaveLength(0); // advisory 不触发修订（防无限润色）
  });

  it("轮次耗尽（2 轮）仍有 blocker → failed，残留 issues 留在结论里", async () => {
    const { impl, seen } = makeLoop({
      reviews: [
        [{ verdict: "revise", issues: [BLOCKER] }],
        [{ verdict: "revise", issues: [BLOCKER] }],
        [{ verdict: "revise", issues: [BLOCKER] }],
      ],
      revisions: [[REVISED], [REVISED]],
    });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl, onWarn: () => {} });

    expect(out.review.status).toBe("failed");
    expect(out.review.rounds).toBe(2);
    expect(out.review.fixed).toBe(2);
    expect(out.review.issues.filter((i) => i.severity === "blocker")).toHaveLength(1);
    expect(seen.reviseOpts).toHaveLength(2); // 上限 2 轮，不许有第三轮
  });
});

// ─── 引文校验与自纠 ──────────────────────────────────────────────────────────

describe("reviewAndConverge — 引文必须能定位", () => {
  it("quote 在稿内找不到 → 打回自纠，改对了照常收敛", async () => {
    const { impl, seen } = makeLoop({
      reviews: [
        [
          { verdict: "revise", issues: [{ ...BLOCKER, quote: "这句话稿子里根本没有" }] },
          { verdict: "pass", issues: [] },
        ],
      ],
    });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl });

    expect(seen.execResults[0]).toContain("找不到");
    expect(seen.execResults[1]).toBe("已收到审稿结论");
    expect(out.review.status).toBe("passed");
  });

  it("自纠一轮后仍是幻觉引文 → skipped，稿子原样转正，不抛", async () => {
    const warns: string[] = [];
    const { impl, seen } = makeLoop({
      reviews: [
        [
          { verdict: "revise", issues: [{ ...BLOCKER, quote: "稿子里没有的第一句" }] },
          { verdict: "revise", issues: [{ ...BLOCKER, quote: "稿子里没有的第二句" }] },
        ],
      ],
    });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl, onWarn: (m) => warns.push(m) });

    expect(seen.execResults[1]).toContain("本轮审稿作废");
    expect(out.review.status).toBe("skipped");
    expect(out.payload).toEqual(PAYLOAD);
    expect(warns.some((w) => w.includes("未经 AI 审稿"))).toBe(true);
  });

  it("空 instruction / 非法 severity 一并打回（结论不合格 = 整份重交）", async () => {
    const { impl, seen } = makeLoop({
      reviews: [
        [
          { verdict: "revise", issues: [{ ...BLOCKER, instruction: "  " }] },
          { verdict: "revise", issues: [{ ...BLOCKER, severity: "critical" }] },
        ],
      ],
    });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl, onWarn: () => {} });

    expect(seen.execResults[0]).toContain("instruction 为空");
    expect(out.review.status).toBe("skipped");
  });

  it("verdict=revise 却没给 issue → 打回（空结论不是 pass）", async () => {
    const { impl, seen } = makeLoop({
      reviews: [[{ verdict: "revise", issues: [] }, { verdict: "pass", issues: [] }]],
    });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl });

    expect(seen.execResults[0]).toContain("至少一条 issue");
    expect(out.review.status).toBe("passed");
  });
});

// ─── 降级（审稿是增益，不许弄死写作） ────────────────────────────────────────

describe("reviewAndConverge — 降级", () => {
  it("审稿引擎抛错 → skipped，不抛，原稿原样返回", async () => {
    const warns: string[] = [];
    const { impl } = makeLoop({ reviews: ["throw"] });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl, onWarn: (m) => warns.push(m) });

    expect(out.review.status).toBe("skipped");
    expect(out.review.rounds).toBe(0);
    expect(out.payload).toEqual(PAYLOAD);
    expect(out.humanizedText).toBe(TEXT);
    expect(warns.some((w) => w.includes("ECONNRESET"))).toBe(true);
  });

  it("审稿模型没调工具 → skipped", async () => {
    const out = await reviewAndConverge(INPUT, CONFIG, {
      runLoopImpl: async () => SILENT,
      onWarn: () => {},
    });
    expect(out.review.status).toBe("skipped");
  });

  it("修订轮抛错 → failed（审出问题但没修成），回退到审稿前那版", async () => {
    const { impl } = makeLoop({
      reviews: [[{ verdict: "revise", issues: [BLOCKER] }]],
      revisions: ["throw"],
    });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl, onWarn: () => {} });

    expect(out.review.status).toBe("failed");
    expect(out.review.rounds).toBe(0);
    expect(out.payload).toEqual(PAYLOAD);
    expect(out.review.issues).toHaveLength(1);
  });

  it("修订稿仍未过 Quality Gate → 整轮作废，回退到修订前那版", async () => {
    const gate: QualityGateSpec = { minChars: 40 };
    const warns: string[] = [];
    const { impl, seen } = makeLoop({
      reviews: [[{ verdict: "revise", issues: [BLOCKER] }]],
      revisions: [[{ ...PAYLOAD, hook: "太短", body: "短", cta: "短" }]],
    });
    const out = await reviewAndConverge({ ...INPUT, gate }, CONFIG, {
      runLoopImpl: impl,
      onWarn: (m) => warns.push(m),
    });

    // [0] 是审稿结论回执，[1] 才是修订轮 submit_script 的回执
    expect(seen.execResults[1]).toContain("QUALITY GATE 未通过");
    expect(out.review.status).toBe("failed");
    expect(out.payload).toEqual(PAYLOAD); // 改坏了就不要这一版
    expect(out.humanizedText).toBe(TEXT);
    expect(warns.some((w) => w.includes("Quality Gate"))).toBe(true);
  });

  it("修订轮没提交成稿 → failed，不换稿", async () => {
    const { impl } = makeLoop({
      reviews: [[{ verdict: "revise", issues: [BLOCKER] }]],
      revisions: [[]], // 一次工具都没调
    });
    const out = await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl, onWarn: () => {} });

    expect(out.review.status).toBe("failed");
    expect(out.payload).toEqual(PAYLOAD);
  });
});

// ─── 墙钟（注入时钟，零真睡） ────────────────────────────────────────────────

describe("reviewAndConverge — 墙钟", () => {
  it("首轮就到点 → skipped，一次引擎调用都不发", async () => {
    const { impl, seen } = makeLoop({ reviews: [[{ verdict: "pass", issues: [] }]] });
    const out = await reviewAndConverge(INPUT, CONFIG, {
      runLoopImpl: impl,
      deadlineMs: 0,
      onWarn: () => {},
    });

    expect(out.review.status).toBe("skipped");
    expect(seen.reviewOpts).toHaveLength(0);
  });

  it("修订跑到一半到点 → 丢弃在途修订，failed，用最后一版过 gate 的稿", async () => {
    let clock = 0;
    const warns: string[] = [];
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      const tool = (opts.tools ?? [])[0];
      if (tool.name === "submit_review") {
        await tool.execute({ verdict: "revise", issues: [BLOCKER] });
      } else {
        clock += 9_000; // 修订跑了 9 秒，墙钟只有 5 秒
        await tool.execute(REVISED);
      }
      return { finalMessage: "ok", turns: 1, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
    };

    const out = await reviewAndConverge(INPUT, CONFIG, {
      runLoopImpl,
      deadlineMs: 5_000,
      nowImpl: () => clock,
      onWarn: (m) => warns.push(m),
    });

    expect(out.review.status).toBe("failed");
    expect(out.review.rounds).toBe(0);
    expect(out.payload).toEqual(PAYLOAD); // 在途修订作废
    expect(warns.some((w) => w.includes("丢弃在途修订"))).toBe(true);
  });

  it("第二轮开始前已到点 → 不再发起修订，failed", async () => {
    let clock = 0;
    const { impl, seen } = makeLoop({ reviews: [[{ verdict: "revise", issues: [BLOCKER] }]] });
    const runLoopImpl = async (cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      const result = await impl(cfg, opts);
      clock += 9_000; // 审稿本身就烧完了整段墙钟
      return result;
    };

    const out = await reviewAndConverge(INPUT, CONFIG, {
      runLoopImpl,
      deadlineMs: 5_000,
      nowImpl: () => clock,
      onWarn: () => {},
    });

    expect(out.review.status).toBe("failed");
    expect(seen.reviseOpts).toHaveLength(0);
  });
});

// ─── 材料缺省（§2.4：没给材料的维度不判） ────────────────────────────────────

describe("reviewAndConverge — 审稿材料", () => {
  it("有调研材料 → 材料进 prompt，深度维度启用", async () => {
    const { impl, seen } = makeLoop({ reviews: [[{ verdict: "pass", issues: [] }]] });
    await reviewAndConverge({ ...INPUT, researchSlot: "【调研简报】三个数字" }, CONFIG, { runLoopImpl: impl });

    expect(seen.reviewOpts[0].userMessage).toContain("三个数字");
    expect(seen.reviewOpts[0].systemPrompt).toContain("洞察深度（本稿带了调研材料");
  });

  it("无调研材料 → prompt 明说不判证据深度，只判 AI 味", async () => {
    const { impl, seen } = makeLoop({ reviews: [[{ verdict: "pass", issues: [] }]] });
    await reviewAndConverge(INPUT, CONFIG, { runLoopImpl: impl });

    expect(seen.reviewOpts[0].systemPrompt).toContain("本轮**不判**");
    expect(seen.reviewOpts[0].userMessage).toContain("不判证据深度");
    expect(seen.reviewOpts[0].userMessage).toContain(PAYLOAD.body); // 终稿全文进审稿
    expect(seen.reviewOpts[0].userMessage).toContain("我说话就是这个调子。"); // 声音样本进审稿
  });
});
