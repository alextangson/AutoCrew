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
  await fs.rm(dir, { recursive: true, force: true });
});

describe("judgeRelevance", () => {
  it("uses the scout Sonnet 5 route and computes the 100-point total from bounded dimensions", async () => {
    let seenConfig: EngineConfig | undefined;
    let seenOptions: LoopOptions | undefined;
    const runLoopImpl = async (config: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
      seenConfig = config;
      seenOptions = options;
      const tool = options.tools?.find((t) => t.name === "submit_relevance");
      await tool?.execute({
        verdicts: [
          {
            index: 0,
            title_zh: "AI Agent 调试工具实测",
            summary_zh: "一款新的 Agent 调试工具，现有材料足以验证基础工作流。",
            angles: ["安装", "调试", "选型"],
            breakdown: { audience_fit: 29, material_richness: 22, novelty: 24, timeliness: 18 },
            reason: "适合当前受众",
          },
        ],
      });
      return { finalMessage: "ok", turns: 1, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
    };

    const result = await judgeRelevance(
      "AI 工具",
      "独立开发者",
      [{ title: "New debugger for agents", source: "HN", description: "Tool-call tracing" }],
      dir,
      { runLoopImpl },
    );

    expect(seenConfig?.baseUrl).toBe("https://code.newcli.com/claude/ultra");
    expect(seenOptions?.model).toBe("claude-sonnet-5");
    expect(seenOptions?.userMessage).toContain("Tool-call tracing");
    expect(result?.[0]).toMatchObject({
      totalScore: 93,
      score: 9.3,
      titleZh: "AI Agent 调试工具实测",
      scoreBreakdown: { audienceFit: 29, materialRichness: 22, novelty: 24, timeliness: 18 },
    });
  });
});
