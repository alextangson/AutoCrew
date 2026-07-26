import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult } from "../../engine/loop.js";
import { judgeRelevance } from "./relevance.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-relevance-"));
  await fs.writeFile(
    path.join(dir, "engine.json"),
    JSON.stringify({
      apiKey: "sk-test",
      strongModel: "main",
      fastModel: "fast",
      routes: {
        scout: {
          baseUrl: "https://code.newcli.com/claude/ultra",
          model: "claude-sonnet-5",
          protocol: "anthropic",
        },
      },
    }),
  );
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("judgeRelevance (两阶段)", () => {
  it("Stage1 数字粗筛 + Stage2 中文精修:走 scout 路由,四维总分服务端重算", async () => {
    let stage1Options: LoopOptions | undefined;
    let seenConfig: EngineConfig | undefined;
    const runLoopImpl = async (config: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
      seenConfig = config;
      const scoreTool = options.tools?.find((t) => t.name === "submit_scores");
      const contentTool = options.tools?.find((t) => t.name === "submit_content");
      if (scoreTool) {
        stage1Options = options;
        await scoreTool.execute({
          scores: [
            { index: 0, audience_fit: 29, material_richness: 22, novelty: 24, timeliness: 18 }, // 93 → 入选
            { index: 1, audience_fit: 5, material_richness: 5, novelty: 5, timeliness: 5 }, // 20 → 低于门槛,不精修
          ],
        });
      } else if (contentTool) {
        // 只应收到 Stage1 里过门槛的 index 0
        expect(options.userMessage).toContain("New debugger for agents");
        expect(options.userMessage).not.toContain("楼市周报");
        await contentTool.execute({
          items: [
            { index: 0, title_zh: "AI Agent 调试工具实测", summary_zh: "一款新的 Agent 调试工具。", angles: ["安装", "调试", "选型"], reason: "适合当前受众" },
          ],
        });
      }
      return { finalMessage: "ok", turns: 1, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
    };

    const result = await judgeRelevance(
      "AI 工具",
      "独立开发者",
      [
        { title: "New debugger for agents", source: "HN", description: "Tool-call tracing" },
        { title: "楼市周报", source: "36氪", description: "本周房价" },
      ],
      dir,
      { runLoopImpl },
    );

    expect(seenConfig?.baseUrl).toBe("https://code.newcli.com/claude/ultra");
    expect(stage1Options?.model).toBe("claude-sonnet-5");
    expect(stage1Options?.userMessage).toContain("Tool-call tracing");
    // 只返回过门槛且精修出中文标题的那条
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      index: 0,
      totalScore: 93,
      score: 9.3,
      titleZh: "AI Agent 调试工具实测",
      scoreBreakdown: { audienceFit: 29, materialRichness: 22, novelty: 24, timeliness: 18 },
    });
  });

  it("Stage1 全部低于门槛 → 返回空数组(正常,不触发精修/不回退)", async () => {
    let contentCalled = false;
    const runLoopImpl = async (_c: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
      const scoreTool = options.tools?.find((t) => t.name === "submit_scores");
      if (scoreTool) await scoreTool.execute({ scores: [{ index: 0, audience_fit: 5, material_richness: 5, novelty: 5, timeliness: 5 }] });
      if (options.tools?.some((t) => t.name === "submit_content")) contentCalled = true;
      return { finalMessage: "ok", turns: 1, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
    };
    const result = await judgeRelevance("AI 工具", "", [{ title: "泛泛新闻", source: "HN" }], dir, { runLoopImpl });
    expect(result).toEqual([]);
    expect(contentCalled).toBe(false); // 没够格的就不该进精修
  });

  it("Stage1 没提交(模型没调工具) → null,调用方回退关键词", async () => {
    const runLoopImpl = async (): Promise<LoopResult> => ({ finalMessage: "唠叨", turns: 4, totalTokens: 10, toolCallCount: 0, stopReason: "max_turns" });
    const result = await judgeRelevance("AI 工具", "", [{ title: "X", source: "HN" }], dir, { runLoopImpl });
    expect(result).toBeNull();
  });
});
