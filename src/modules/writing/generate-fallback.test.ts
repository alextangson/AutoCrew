/**
 * 写稿那条链路的报病与留痕（P2 spec §4.2 / §4.3）。
 * 断两件事：中断稿的 lastError 说的是「哪条线怎么坏的」而不是原始报错；
 * 兜底发生过就必须在稿子上留痕（`Content.usedFallback`）——没留痕等于兜底从没发生过。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateScript } from "./generate-script.js";
import { getContent, listContents } from "../../storage/local-store.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult, LoopTool } from "../../engine/loop.js";

let testDir: string;
const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

const ENGINE_V2 = {
  version: 2,
  providers: [
    { id: "newcli", name: "newcli 中转", baseUrl: "https://code.newcli.com/claude/ultra", apiKey: "sk-relay", models: ["claude-opus-4-8"] },
    { id: "deepseek", name: "DeepSeek 官方", baseUrl: "https://api.deepseek.com", apiKey: "sk-ds", models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
  ],
  main: { provider: "deepseek", strong: "deepseek-v4-pro", fast: "deepseek-v4-flash" },
  assignments: { writer: { provider: "newcli", model: "claude-opus-4-8" } },
};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-gen-fallback-"));
  await fs.writeFile(path.join(testDir, "engine.json"), JSON.stringify(ENGINE_V2));
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

const REVIEW_ABSTAIN: LoopResult = {
  finalMessage: "审稿替身不出手",
  turns: 1,
  totalTokens: 0,
  toolCallCount: 0,
  stopReason: "no_tool_calls",
};
const isWriterLoop = (opts: LoopOptions): boolean => (opts.tools ?? []).some((t: LoopTool) => t.name === "submit_script");

const GOOD_PAYLOAD = {
  title: "普通人怎么用AI赚钱",
  hook: "你知道吗，身边有人靠AI接私活，已经辞掉了工作",
  body: "AI工具让普通人也能做到这些事情，关键是选对方向",
  cta: "关注我，每周分享AI变现实战",
  hashtags: ["#AI赚钱"],
};

const REQ = { topic: "AI时代普通人赚钱", platform: "douyin" as const };

describe("写稿失败的人话（§4.2）", () => {
  it("上游连不上：中断稿 lastError 说「写稿专线 …（主机名）连不上」，不含原始 fetch failed", async () => {
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
      throw new Error("fetch failed");
    };
    await expect(generateScript(REQ, testDir, { runLoopImpl, onWarn: () => {} })).rejects.toThrow();

    const [placeholder] = (await listContents(testDir)).filter((c) => c.status === "drafting");
    const content = await getContent(placeholder.id, testDir);
    expect(content!.title).toContain("［生成中断］");
    expect(content!.lastError).toContain("写稿专线");
    expect(content!.lastError).toContain("code.newcli.com");
    expect(content!.lastError).not.toContain("fetch failed");
  });

  it("不是线路的病（模型没提交）就原样说：不套「写稿专线连不上」的确定语气", async () => {
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
      return { finalMessage: "我不写", turns: 1, totalTokens: 5, toolCallCount: 0, stopReason: "no_tool_calls" };
    };
    await expect(generateScript(REQ, testDir, { runLoopImpl, onWarn: () => {} })).rejects.toThrow();

    const [placeholder] = (await listContents(testDir)).filter((c) => c.status === "drafting");
    const content = await getContent(placeholder.id, testDir);
    expect(content!.lastError).toContain("submit_script");
    expect(content!.lastError).not.toContain("写稿专线");
  });
});

describe("兜底留痕（§4.3）", () => {
  it("写稿轮报告用了备用 → Content.usedFallback 落盘，稿卡才有「备用顶上」可画", async () => {
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
      const submit = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
      await submit.execute(GOOD_PAYLOAD);
      return {
        finalMessage: "脚本已提交",
        turns: 2,
        totalTokens: 100,
        toolCallCount: 1,
        stopReason: "no_tool_calls",
        usedFallback: { role: "writer", from: "claude-opus-4-8", to: "deepseek-v4-pro", error: "429 rate limited" },
      };
    };
    const out = await generateScript(REQ, testDir, { runLoopImpl, onWarn: () => {} });
    const content = await getContent(out.contentId, testDir);
    expect(content!.usedFallback).toMatchObject({ role: "writer", from: "claude-opus-4-8", to: "deepseek-v4-pro" });
    expect(content!.usedFallback?.error).toContain("429");
  });

  it("没切过备用就没有这个字段（不许留一个恒真的徽章）", async () => {
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
      const submit = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
      await submit.execute(GOOD_PAYLOAD);
      return { finalMessage: "脚本已提交", turns: 2, totalTokens: 100, toolCallCount: 1, stopReason: "no_tool_calls" };
    };
    const out = await generateScript(REQ, testDir, { runLoopImpl, onWarn: () => {} });
    const content = await getContent(out.contentId, testDir);
    expect(content!.usedFallback).toBeUndefined();
  });
});
