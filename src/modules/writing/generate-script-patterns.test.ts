/**
 * generate-script-patterns.test.ts — 写稿链路上的对标拆解卡注入（收件箱设计 §3.5）。
 *
 * 与 generate-script.test.ts 同款全 mock 骨架；单独成文是为了让既有写稿测试
 * 保持原样，也不让单文件继续膨胀。断言的是结构（定界块在不在、归因落没落），
 * 不断言 prompt 全文。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateScript } from "./generate-script.js";
import { PATTERN_BLOCK_START } from "./script-prompt.js";
import { upsertPatternCard } from "../patterns/pattern-store.js";
import type { PatternCardInput } from "../patterns/pattern-store.js";
import { getContent, listContents } from "../../storage/local-store.js";
import type { LoopResult, LoopOptions } from "../../engine/loop.js";
import type { EngineConfig } from "../../engine/config.js";

let testDir: string;

const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-genscript-patterns-"));
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

const GOOD_PAYLOAD = {
  title: "普通人怎么用AI赚钱",
  hook: "你知道吗，身边有人靠AI接私活，已经辞掉了工作",
  body: "AI工具让普通人也能做到这些事情，关键是选对方向",
  cta: "关注我，每周分享AI变现实战",
  hashtags: ["#AI赚钱"],
};

const TEST_REQ = { topic: "AI时代普通人赚钱", platform: "douyin" as const };

const PATTERN_INPUT: PatternCardInput = {
  sourceUrl: "https://www.douyin.com/video/123",
  canonicalUrl: "https://www.douyin.com/video/123",
  sourcePlatform: "douyin",
  applicablePlatforms: ["douyin"],
  title: "三步搞定选题",
  hook: "你以为选题难，其实是没有清单",
  structure: ["抛反常识结论", "给三步清单", "收尾留钩子"],
  whyItWorks: ["反常识开头压住划走"],
  themes: ["AI时代"],
  sourceInboxId: "inbox-001",
};

/** 写稿收束后那轮 AI 审稿（工具带是 submit_review）替身不出手：写稿轮的断言不受影响 */
const REVIEW_ABSTAIN: LoopResult = {
  finalMessage: "审稿替身不出手",
  turns: 1,
  totalTokens: 0,
  toolCallCount: 0,
  stopReason: "no_tool_calls",
};

/** 捕获 loop 入参：注入面（userMessage）与归因面（logMeta）都在这上面验 */
function capturingLoop(seen: { opts?: LoopOptions }) {
  return async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    if (!(opts.tools ?? []).some((t) => t.name === "submit_script")) return REVIEW_ABSTAIN;
    seen.opts = opts;
    const tool = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
    await tool.execute(GOOD_PAYLOAD);
    return { finalMessage: "ok", turns: 2, totalTokens: 100, toolCallCount: 1, stopReason: "no_tool_calls" };
  };
}

describe("generateScript × 拆解卡注入", () => {
  it("相关卡存在 → prompt 带定界块，usedPatternIds 进 run-log 元数据与稿件", async () => {
    const card = await upsertPatternCard(PATTERN_INPUT, testDir);
    const seen: { opts?: LoopOptions } = {};

    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl: capturingLoop(seen) });

    expect(seen.opts!.userMessage).toContain(PATTERN_BLOCK_START);
    expect(seen.opts!.userMessage).toContain(card.hook);
    expect(seen.opts!.logMeta?.usedPatternIds).toEqual([card.id]);

    const savedContent = await getContent(result.contentId, testDir);
    expect(savedContent!.usedPatternIds).toEqual([card.id]);
    expect(savedContent!.status).toBe("draft_ready");
  });

  it("usePatterns:false → 不选卡、不注入、不归因", async () => {
    await upsertPatternCard(PATTERN_INPUT, testDir);
    const seen: { opts?: LoopOptions } = {};

    const result = await generateScript({ ...TEST_REQ, usePatterns: false }, testDir, {
      runLoopImpl: capturingLoop(seen),
    });

    expect(seen.opts!.userMessage).not.toContain(PATTERN_BLOCK_START);
    expect(seen.opts!.logMeta?.usedPatternIds).toBeUndefined();
    const savedContent = await getContent(result.contentId, testDir);
    expect(savedContent!.usedPatternIds).toBeUndefined();
  });

  it("卡与选题主题无交集 → 与无卡时行为一致", async () => {
    await upsertPatternCard({ ...PATTERN_INPUT, themes: ["露营装备"] }, testDir);
    const seen: { opts?: LoopOptions } = {};

    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl: capturingLoop(seen) });

    expect(seen.opts!.userMessage).not.toContain(PATTERN_BLOCK_START);
    expect(seen.opts!.logMeta?.usedPatternIds).toBeUndefined();
    const savedContent = await getContent(result.contentId, testDir);
    expect(savedContent!.usedPatternIds).toBeUndefined();
  });

  it("卡的适用平台不含目标平台 → 不注入", async () => {
    await upsertPatternCard({ ...PATTERN_INPUT, applicablePlatforms: ["xiaohongshu"] }, testDir);
    const seen: { opts?: LoopOptions } = {};

    await generateScript(TEST_REQ, testDir, { runLoopImpl: capturingLoop(seen) });

    expect(seen.opts!.userMessage).not.toContain(PATTERN_BLOCK_START);
    expect(seen.opts!.logMeta?.usedPatternIds).toBeUndefined();
  });

  it("patterns 库不存在（默认工作区）→ 写稿照跑，稿件不带归因字段", async () => {
    const seen: { opts?: LoopOptions } = {};
    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl: capturingLoop(seen) });

    expect(seen.opts!.userMessage).not.toContain(PATTERN_BLOCK_START);
    const savedContent = await getContent(result.contentId, testDir);
    expect(savedContent!.status).toBe("draft_ready");
    expect(savedContent!.usedPatternIds).toBeUndefined();
  });

  it("patterns 库读坏（不是空态）→ 报错中止，不静默当空库继续", async () => {
    // patterns.jsonl 是目录 → EISDIR：库坏了必须炸出来，而不是当成「还没有卡」
    await fs.mkdir(path.join(testDir, "patterns", "patterns.jsonl"), { recursive: true });
    const seen: { opts?: LoopOptions } = {};

    await expect(
      generateScript(TEST_REQ, testDir, { runLoopImpl: capturingLoop(seen) }),
    ).rejects.toThrow();
    expect(seen.opts).toBeUndefined(); // 组稿前就断，没白烧 token

    // 与「引擎未配置」同属准备阶段失败：占位稿留在盘上，没有半成品转正
    const all = await listContents(testDir);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("drafting");
  });
});
