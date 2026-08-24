/**
 * style-distiller.test.ts — 全 mock，零网络
 *
 * 假 runLoopImpl 实际调用 submit_rules 工具的 execute 处理器，
 * 这是捕获机制的关键：execute 闭包把 rules 写进外部变量。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  distillStyleRules,
  analyzeStyleSamples,
  shouldDistillStyle,
  verifyVerbatimExcerpts,
  fallbackExcerpts,
} from "./style-distiller.js";
import { recordDiff, listDiffs } from "./diff-tracker.js";
import { loadProfile, addWritingRule } from "../profile/creator-profile.js";
import type { LoopResult, LoopTool, LoopOptions } from "../../engine/loop.js";
import type { EngineConfig } from "../../engine/config.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;

const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-style-test-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "sk-test", strongModel: "m-strong", fastModel: "m-fast" }),
  );
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/**
 * Write a distill-state.json with the given ISO timestamp.
 * Pass "" to write an empty object (= no previous distillation).
 */
async function writeDistillState(lastDistilledAt: string): Promise<void> {
  const dir = path.join(testDir, "learnings");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "distill-state.json"),
    JSON.stringify(lastDistilledAt ? { lastDistilledAt } : {}),
  );
}

async function readDistillState(): Promise<{ lastDistilledAt?: string }> {
  try {
    const raw = await fs.readFile(path.join(testDir, "learnings", "distill-state.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Build a fake runLoopImpl that calls submit_rules with the given rule payloads.
 * Each execute return value is pushed into execResults.
 */
function makeRunLoop(
  ruleBatches: Array<Array<{ rule: string; evidence: string; confidence: number; scope?: string }>>,
  execResults: string[] = [],
): (_cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult> {
  return async (_cfg, opts) => {
    const submitTool = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_rules");
    if (!submitTool) throw new Error("submit_rules tool not found in opts");

    for (const rules of ruleBatches) {
      execResults.push(await submitTool.execute({ rules }));
    }

    return {
      finalMessage: "规则已提交",
      turns: ruleBatches.length + 1,
      totalTokens: 100,
      toolCallCount: ruleBatches.length,
      stopReason: "no_tool_calls",
    } satisfies LoopResult;
  };
}

/**
 * Variant that also exposes callCount.
 */
function makeRunLoopWithCount(
  ruleBatches: Array<Array<{ rule: string; evidence: string; confidence: number }>>,
): {
  impl: (_cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult>;
  getCallCount: () => number;
} {
  let callCount = 0;
  const impl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    callCount++;
    const submitTool = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_rules");
    if (!submitTool) throw new Error("submit_rules tool not found in opts");

    for (const rules of ruleBatches) {
      await submitTool.execute({ rules });
    }

    return {
      finalMessage: "规则已提交",
      turns: ruleBatches.length + 1,
      totalTokens: 100,
      toolCallCount: ruleBatches.length,
      stopReason: "no_tool_calls",
    } satisfies LoopResult;
  };
  return { impl, getCallCount: () => callCount };
}

const GOOD_RULES = [
  { rule: "用口语化短句，避免书面长句", evidence: "before: 鉴于...因此 after: 说白了...", confidence: 0.9 },
  { rule: "段落不超过三行", evidence: "before: 5行段落 after: 2行段落", confidence: 0.8 },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("distillStyleRules", () => {
  // 1. Happy path
  it("happy path: 2 new diffs + 2 rules → profile updated, state written, summary correct", async () => {
    // Record 2 diffs
    await recordDiff("c1", "body", "鉴于某某原因，因此可以考虑", "说白了，直接做就行", testDir);
    await recordDiff("c1", "body", "首先其次最后罗列", "三点建议：一 二 三", testDir);

    const runLoopImpl = makeRunLoop([GOOD_RULES]);
    const result = await distillStyleRules(testDir, { runLoopImpl });

    expect(result.newRules).toHaveLength(2);
    expect(result.diffsAnalyzed).toBe(2);
    expect(result.skippedDuplicates).toBe(0);
    expect(result.summary).toContain("2");

    // Rules written to profile
    const profile = await loadProfile(testDir);
    expect(profile!.writingRules).toHaveLength(2);
    expect(profile!.writingRules.every((r) => r.source === "auto_distilled")).toBe(true);
    expect(profile!.writingRules[0].confidence).toBe(0.9);

    // State written
    const state = await readDistillState();
    expect(state.lastDistilledAt).toBeTruthy();
  });

  // 2. Self-correction: confidence out of range → error, then valid → success
  it("self-correction: confidence 1.5 → execute returns error, valid retry succeeds", async () => {
    await recordDiff("c1", "body", "before text", "after text", testDir);

    const execResults: string[] = [];
    const badRules = [{ rule: "测试规则", evidence: "证据", confidence: 1.5 }];
    const runLoopImpl: (_cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult> = async (
      _cfg,
      opts,
    ) => {
      const submitTool = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_rules");
      if (!submitTool) throw new Error("submit_rules tool not found");

      // First call rejected (out-of-range confidence), second call valid — self-correction channel
      execResults.push(await submitTool.execute({ rules: badRules }));
      execResults.push(await submitTool.execute({ rules: GOOD_RULES }));

      return {
        finalMessage: "done",
        turns: 3,
        totalTokens: 120,
        toolCallCount: 2,
        stopReason: "no_tool_calls",
      } satisfies LoopResult;
    };

    const result = await distillStyleRules(testDir, { runLoopImpl });

    expect(execResults[0]).toContain("请修正");
    expect(result.newRules).toHaveLength(2);
  });

  // 3. Exact-duplicate guard: rule matches existing → skippedDuplicates=1
  it("exact duplicate: 1 rule same as existing → skippedDuplicates=1, not re-added", async () => {
    await recordDiff("c1", "body", "before", "after", testDir);
    // Pre-seed profile with the same rule text
    const existingRule = GOOD_RULES[0].rule;
    await addWritingRule({ rule: existingRule, source: "user_explicit", confidence: 1 }, testDir);

    const runLoopImpl = makeRunLoop([GOOD_RULES]); // submits 2 rules, 1 is duplicate
    const result = await distillStyleRules(testDir, { runLoopImpl });

    expect(result.skippedDuplicates).toBe(1);
    expect(result.newRules).toHaveLength(1);

    const profile = await loadProfile(testDir);
    // 1 pre-existing + 1 new = 2 total
    expect(profile!.writingRules).toHaveLength(2);
  });

  // 3b. Evidence attribution: duplicate dropped mid-array must not shift evidences (I1)
  it("evidence attribution: [dup, 新A, 新B] → summary pairs each new rule with its own evidence", async () => {
    await recordDiff("c1", "body", "before", "after", testDir);
    const dupRule = "已有规则：保持简短";
    await addWritingRule({ rule: dupRule, source: "user_explicit", confidence: 1 }, testDir);

    const submitted = [
      { rule: dupRule, evidence: "重复证据", confidence: 0.9 },
      { rule: "新规则A：开头用提问", evidence: "证据A：before陈述 after提问", confidence: 0.8 },
      { rule: "新规则B：结尾留钩子", evidence: "证据B：after新增悬念句", confidence: 0.7 },
    ];
    const runLoopImpl = makeRunLoop([submitted]);
    const result = await distillStyleRules(testDir, { runLoopImpl });

    expect(result.skippedDuplicates).toBe(1);
    expect(result.newRules).toHaveLength(2);
    expect(result.summary).toContain("新规则A：开头用提问（依据：证据A：before陈述 after提问）");
    expect(result.summary).toContain("新规则B：结尾留钩子（依据：证据B：after新增悬念句）");
    expect(result.summary).not.toContain("重复证据");
  });

  // 2b. NaN confidence must be rejected at the trust boundary (I2)
  it("confidence NaN → execute returns 自纠 error", async () => {
    await recordDiff("c1", "body", "before", "after", testDir);

    const execResults: string[] = [];
    const nanRules = [{ rule: "测试规则", evidence: "证据", confidence: NaN }];
    const runLoopImpl = makeRunLoop([nanRules, GOOD_RULES], execResults);
    const result = await distillStyleRules(testDir, { runLoopImpl });

    expect(execResults[0]).toContain("请修正");
    expect(result.newRules).toHaveLength(2);
  });

  // 4. No new diffs → model not called, state unchanged
  it("no new diffs → model not called (callCount=0), state unchanged", async () => {
    // Record a diff, then set lastDistilledAt in the future so it counts as already distilled
    await recordDiff("c1", "body", "before", "after", testDir);
    await writeDistillState(new Date(Date.now() + 60000).toISOString());

    const { impl: runLoopImpl, getCallCount } = makeRunLoopWithCount([]);
    const result = await distillStyleRules(testDir, { runLoopImpl });

    expect(getCallCount()).toBe(0);
    expect(result.newRules).toHaveLength(0);
    expect(result.diffsAnalyzed).toBe(0);
    // State should remain as-is (not updated)
    const state = await readDistillState();
    expect(state.lastDistilledAt).toBeTruthy();
  });

  // 5. Truncation: 5 rules submitted → only 3 stored
  it("truncation: fake submits 5 rules → only 3 stored", async () => {
    await recordDiff("c1", "body", "before", "after", testDir);

    const fiveRules = Array.from({ length: 5 }, (_, i) => ({
      rule: `规则${i + 1}：具体要求${i + 1}`,
      evidence: `证据${i + 1}`,
      confidence: 0.8,
    }));
    const runLoopImpl = makeRunLoop([fiveRules]);
    const result = await distillStyleRules(testDir, { runLoopImpl });

    expect(result.newRules).toHaveLength(3);
    const profile = await loadProfile(testDir);
    expect(profile!.writingRules).toHaveLength(3);
  });

  // 6. Never submits → throws, state not updated
  it("never submits → throws, state not updated", async () => {
    await recordDiff("c1", "body", "before", "after", testDir);

    const runLoopImpl: (_cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult> = async () => {
      return {
        finalMessage: "不想调工具",
        turns: 3,
        totalTokens: 50,
        toolCallCount: 0,
        stopReason: "max_turns",
      } satisfies LoopResult;
    };

    await expect(distillStyleRules(testDir, { runLoopImpl })).rejects.toThrow(
      /submit_rules|未提交|规则/,
    );

    // State must not be written
    const state = await readDistillState();
    expect(state.lastDistilledAt).toBeUndefined();
  });

  // 7. shouldDistillStyle: 2 new diffs → false; 3 new diffs → true
  it("shouldDistillStyle: 2 diffs → false; 3 diffs → true", async () => {
    await recordDiff("c1", "body", "before", "after", testDir);
    await recordDiff("c2", "body", "before", "after", testDir);
    expect(await shouldDistillStyle(testDir)).toBe(false);

    await recordDiff("c3", "body", "before", "after", testDir);
    expect(await shouldDistillStyle(testDir)).toBe(true);
  });
});

describe("analyzeStyleSamples", () => {
  // 8. Happy path: samples analyzed, no state change
  it("happy path: 2 samples → rules returned, distill-state not written", async () => {
    const runLoopImpl = makeRunLoop([GOOD_RULES]);
    const result = await analyzeStyleSamples(
      ["爆款样本1：今天分享三个绝绝子的用法", "爆款样本2：你们有没有发现这个细节"],
      testDir,
      { runLoopImpl },
    );

    expect(result.newRules).toHaveLength(2);
    expect(result.diffsAnalyzed).toBe(2); // samplesAnalyzed reuses diffsAnalyzed field
    expect(result.summary).toBeTruthy();

    // distill-state must NOT be touched
    const state = await readDistillState();
    expect(state.lastDistilledAt).toBeUndefined();
  });

  // 9. Empty samples → throws parameter error
  it("empty samples array → throws parameter error", async () => {
    const runLoopImpl = makeRunLoop([]);
    await expect(analyzeStyleSamples([], testDir, { runLoopImpl })).rejects.toThrow(
      /samples|样本/i,
    );
  });

  // 10. Calibration samples always land as voice_core, even if the model tags a platform
  it("forces voice_core scope on sample-derived rules (§4.3: 校准样本 = 声音内核种子)", async () => {
    const scoped = [
      { rule: "标题带数字", evidence: "样本1标题", confidence: 0.9, scope: "platform:wechat_mp" },
    ];
    const runLoopImpl = makeRunLoop([scoped]);
    await analyzeStyleSamples(["样本正文"], testDir, { runLoopImpl });

    const profile = JSON.parse(await fs.readFile(path.join(testDir, "creator-profile.json"), "utf-8"));
    expect(profile.writingRules[0].scope).toBe("voice_core");
  });
});

describe("voice excerpts (V5.7 声音样本)", () => {
  const SAMPLE =
    "创业者找我聊的时候,十有八九第一句话是问该买哪个课。我的答案从来只有一个:先别买,把你上周真实卡住的那个问题写下来。\n\n第二段讲方法论,这里的内容也足够长,超过二十个字没有问题。";

  function makeRunLoopWithExcerpts(
    rules: Array<{ rule: string; evidence: string; confidence: number }>,
    excerpts: string[],
  ): (_cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult> {
    return async (_cfg, opts) => {
      const submitTool = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_rules");
      if (!submitTool) throw new Error("submit_rules tool not found");
      await submitTool.execute({ rules, excerpts });
      return { finalMessage: "done", turns: 2, totalTokens: 100, toolCallCount: 1, stopReason: "no_tool_calls" } satisfies LoopResult;
    };
  }

  it("persists verbatim excerpts, drops fabricated ones", async () => {
    const verbatim = "先别买,把你上周真实卡住的那个问题写下来。";
    const fabricated = "这一段是模型自己编的,样本里根本没有这句话,超过二十个字。";
    const runLoopImpl = makeRunLoopWithExcerpts(GOOD_RULES, [verbatim, fabricated]);

    const result = await analyzeStyleSamples([SAMPLE], testDir, { runLoopImpl });

    const profile = await loadProfile(testDir);
    expect(profile!.voiceSamples).toContain(verbatim);
    expect(profile!.voiceSamples).not.toContain(fabricated);
    expect(result.voiceSamplesSaved).toBeGreaterThan(0);
    expect(result.summary).toContain("声音样本");
  });

  it("falls back to first paragraphs when model submits no usable excerpts", async () => {
    const runLoopImpl = makeRunLoop([GOOD_RULES]);
    await analyzeStyleSamples([SAMPLE], testDir, { runLoopImpl });

    const profile = await loadProfile(testDir);
    expect(profile!.voiceSamples!.length).toBeGreaterThan(0);
    expect(profile!.voiceSamples![0]).toContain("创业者找我聊的时候");
  });

  it("verifyVerbatimExcerpts: tolerates whitespace differences, rejects short/foreign text", () => {
    const samples = ["第一句话。第二句话继续继续继续继续继续继续。"];
    const withNewline = "第一句话。\n第二句话继续继续继续继续继续继续。";
    expect(verifyVerbatimExcerpts([withNewline], samples)).toEqual([withNewline]);
    expect(verifyVerbatimExcerpts(["太短"], samples)).toEqual([]);
    expect(verifyVerbatimExcerpts(["完全不在样本里的一段文字并且长度超过二十个字符啊"], samples)).toEqual([]);
  });

  it("fallbackExcerpts: takes first paragraph ≥20 chars, slices to 200", () => {
    const long = "长".repeat(300);
    const out = fallbackExcerpts([`短段。\n\n${long}`], 2);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(200);
  });
});

describe("创作者原话进 prompt（changeType = 意图的第一依据）", () => {
  /** 捕获真正发给模型的 userMessage——prompt 是可验证结构，不靠事后猜模型看到了什么 */
  function makeCapturingRunLoop(captured: { userMessage?: string; systemPrompt?: string }) {
    return async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      captured.userMessage = opts.userMessage;
      captured.systemPrompt = opts.systemPrompt;
      const submitTool = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_rules")!;
      await submitTool.execute({ rules: GOOD_RULES });
      return { finalMessage: "done", turns: 2, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
    };
  }

  it("带 note 的 diff：原话整句进 userMessage，且排在 before 之前", async () => {
    await recordDiff("c1", "body", "旧正文", "新正文", testDir, "别用书面语，说人话", "wechat_mp");

    const captured: { userMessage?: string; systemPrompt?: string } = {};
    await distillStyleRules(testDir, { runLoopImpl: makeCapturingRunLoop(captured) });

    const msg = captured.userMessage!;
    expect(msg).toContain("创作者的修改要求（原话）：别用书面语，说人话");
    expect(msg.indexOf("创作者的修改要求")).toBeLessThan(msg.indexOf("before："));
    // 系统提示要说清原话与对照的主次关系，否则模型仍会只盯 diff 猜
    expect(captured.systemPrompt).toContain("第一依据");
  });

  it("没有 note 的 diff：不出现原话那一行（不编造意图）", async () => {
    await recordDiff("c1", "body", "旧正文", "新正文", testDir, undefined, "wechat_mp");

    const captured: { userMessage?: string } = {};
    await distillStyleRules(testDir, { runLoopImpl: makeCapturingRunLoop(captured) });

    expect(captured.userMessage).not.toContain("创作者的修改要求");
    expect(captured.userMessage).toContain("before：旧正文");
  });
});

describe("scope routing through distillStyleRules", () => {
  it("persists the scope submitted by the model (纠正记入发生平台)", async () => {
    await recordDiff("c1", "body", "旧正文", "新正文", testDir, undefined, "wechat_mp");

    const scoped = [
      { rule: "公众号正文空行分段", evidence: "diff1", confidence: 0.8, scope: "platform:wechat_mp" },
    ];
    const runLoopImpl = makeRunLoop([scoped]);
    const result = await distillStyleRules(testDir, { runLoopImpl });

    expect(result.newRules).toHaveLength(1);
    expect(result.newRules[0].scope).toBe("platform:wechat_mp");
  });

  it("rejects malformed scope via submit_rules self-correction", async () => {
    await recordDiff("c1", "body", "旧", "新", testDir);

    const bad = [{ rule: "规则", evidence: "e", confidence: 0.5, scope: "wechat_mp" }];
    const execResults: string[] = [];
    const runLoopImpl = makeRunLoop([bad, GOOD_RULES], execResults);
    await distillStyleRules(testDir, { runLoopImpl });

    expect(execResults[0]).toContain("scope");
  });
});
