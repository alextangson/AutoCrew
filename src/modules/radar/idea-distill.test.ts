/**
 * 碎片灵感提炼测试:断言结构与不变量（总分服务端重算、截断、null 契约），
 * 不对模型文案做精确匹配——文案本身是非确定性的。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult } from "../../engine/loop.js";
import { distillIdeaTopic } from "./idea-distill.js";

let dir: string;

const OK_RESULT: LoopResult = { finalMessage: "ok", turns: 1, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-idea-distill-"));
  await fs.writeFile(
    path.join(dir, "engine.json"),
    JSON.stringify({
      apiKey: "sk-test",
      strongModel: "main",
      fastModel: "fast",
      routes: { scout: { baseUrl: "https://code.newcli.com/claude/ultra", model: "claude-sonnet-5", protocol: "anthropic" } },
    }),
  );
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** 让假 runLoop 用给定的 args 调一次 submit_topic;顺带把 options 交出来供断言 */
function submitWith(args: Record<string, unknown>, seen: { options?: LoopOptions; config?: EngineConfig }) {
  return async (config: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
    seen.config = config;
    seen.options = options;
    const tool = options.tools?.find((t) => t.name === "submit_topic");
    if (tool) await tool.execute(args);
    return OK_RESULT;
  };
}

describe("distillIdeaTopic", () => {
  it("合法提交:走 scout 路由,总分服务端重算,原文进 prompt", async () => {
    const seen: { options?: LoopOptions; config?: EngineConfig } = {};
    const runLoopImpl = submitWith(
      {
        title: "  我们用 Claude Code 重写了排班系统  ",
        summary: "团队把排班系统交给 AI 重写，两周上线。",
        angles: ["踩过的坑", " 成本账 ", "", "选型对比", "多出来的第四个角度"],
        audience_fit: 28,
        material_richness: 20,
        novelty: 22,
        timeliness: 15,
      },
      seen,
    );

    const result = await distillIdeaTopic("我最近让 Claude Code 把公司排班系统重写了一遍，两周就上线了，中间踩了不少坑。", dir, { runLoopImpl });

    expect(seen.config?.baseUrl).toBe("https://code.newcli.com/claude/ultra");
    expect(seen.options?.model).toBe("claude-sonnet-5");
    expect(seen.options?.userMessage).toContain("排班系统重写");
    expect(result).not.toBeNull();
    expect(result?.title).toBe("我们用 Claude Code 重写了排班系统"); // trim
    expect(result?.totalScore).toBe(85); // 28+20+22+15，不信模型自报
    expect(result?.scoreBreakdown).toEqual({ audienceFit: 28, materialRichness: 20, novelty: 22, timeliness: 15 });
    expect(result?.angles).toEqual(["踩过的坑", "成本账", "选型对比"]); // 空串滤掉、trim、最多 3 个
    expect(result?.summary.length).toBeGreaterThan(0);
  });

  it("越界四维分被夹到上限,标题超长截断", async () => {
    const seen: { options?: LoopOptions } = {};
    const runLoopImpl = submitWith(
      {
        title: "长".repeat(100),
        summary: "x",
        angles: [],
        audience_fit: 999,
        material_richness: -5,
        novelty: 25,
        timeliness: 20,
      },
      seen,
    );
    const result = await distillIdeaTopic("一段够长的碎片想法，用来触发提炼。", dir, { runLoopImpl });
    expect(result?.title).toHaveLength(60);
    expect(result?.scoreBreakdown).toEqual({ audienceFit: 30, materialRichness: 0, novelty: 25, timeliness: 20 });
    expect(result?.totalScore).toBe(75);
    expect(result?.angles).toEqual([]);
  });

  it("超长原文进 prompt 前截断到 4000 字符", async () => {
    const seen: { options?: LoopOptions } = {};
    const runLoopImpl = submitWith(
      { title: "标题", summary: "s", angles: ["a"], audience_fit: 10, material_richness: 10, novelty: 10, timeliness: 10 },
      seen,
    );
    // 用固定标记字符计数,避免和 prompt 里的固定文案串味
    await distillIdeaTopic("z".repeat(6000), dir, { runLoopImpl });
    expect(seen.options?.userMessage.match(/z/g) ?? []).toHaveLength(4000);
  });

  it("档案里的定位/受众/目标注入 prompt", async () => {
    await fs.writeFile(
      path.join(dir, "creator-profile.json"),
      JSON.stringify({
        industry: "AI 工具实战",
        audiencePersona: { core: { name: "独立开发者", coreAnxiety: "怕被 AI 淘汰" } },
        goal: { statement: "半年内公众号 1 万粉", setAt: "2026-01-01T00:00:00.000Z" },
      }),
    );
    const seen: { options?: LoopOptions } = {};
    const runLoopImpl = submitWith(
      { title: "标题", summary: "s", angles: ["a"], audience_fit: 10, material_richness: 10, novelty: 10, timeliness: 10 },
      seen,
    );
    await distillIdeaTopic("一段够长的碎片想法，用来触发提炼。", dir, { runLoopImpl });
    expect(seen.options?.userMessage).toContain("AI 工具实战");
    expect(seen.options?.userMessage).toContain("独立开发者");
    expect(seen.options?.userMessage).toContain("1 万粉");
  });

  it("非法提交（空标题）→ null,工具回错让模型重试", async () => {
    let toolReply = "";
    const runLoopImpl = async (_c: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
      const tool = options.tools?.find((t) => t.name === "submit_topic");
      if (tool) toolReply = await tool.execute({ title: "   ", summary: "s", angles: [], audience_fit: 1, material_richness: 1, novelty: 1, timeliness: 1 });
      return OK_RESULT;
    };
    const result = await distillIdeaTopic("一段够长的碎片想法，用来触发提炼。", dir, { runLoopImpl });
    expect(result).toBeNull();
    expect(toolReply).toMatch(/^Error:/);
  });

  it("非法提交（四维分不是数字）→ null", async () => {
    const seen: { options?: LoopOptions } = {};
    const runLoopImpl = submitWith(
      { title: "标题", summary: "s", angles: ["a"], audience_fit: "很高", material_richness: 10, novelty: 10, timeliness: 10 },
      seen,
    );
    expect(await distillIdeaTopic("一段够长的碎片想法，用来触发提炼。", dir, { runLoopImpl })).toBeNull();
  });

  it("模型没调工具 → null（调用方照原文落库）", async () => {
    const runLoopImpl = async (): Promise<LoopResult> => ({ finalMessage: "唠叨", turns: 4, totalTokens: 10, toolCallCount: 0, stopReason: "max_turns" });
    expect(await distillIdeaTopic("一段够长的碎片想法，用来触发提炼。", dir, { runLoopImpl })).toBeNull();
  });

  it("runLoop 抛错 → null,不外抛", async () => {
    const runLoopImpl = async (): Promise<LoopResult> => {
      throw new Error("relay 502");
    };
    expect(await distillIdeaTopic("一段够长的碎片想法，用来触发提炼。", dir, { runLoopImpl })).toBeNull();
  });

  it("空原文 → null,不调引擎", async () => {
    let called = false;
    const runLoopImpl = async (): Promise<LoopResult> => {
      called = true;
      return OK_RESULT;
    };
    expect(await distillIdeaTopic("   ", dir, { runLoopImpl })).toBeNull();
    expect(called).toBe(false);
  });
});
