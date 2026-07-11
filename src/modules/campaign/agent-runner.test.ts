import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig } from "../../engine/config.js";
import type { runLoop } from "../../engine/loop.js";
import { buildCampaignTeam, createCampaign, getCampaign } from "../../storage/campaign-store.js";
import { executeCampaignAgentTask, sanitizeCampaignArtifact } from "./agent-runner.js";

let dataDir: string;
let campaignId: string;

const config: EngineConfig = {
  apiKey: "test",
  baseUrl: "https://example.invalid",
  strongModel: "test-model",
  fastModel: "test-model",
};

function submittingLoop(captured: { userMessage?: string }): typeof runLoop {
  return (async (_config, options) => {
    captured.userMessage = options.userMessage;
    const tool = options.tools?.find((item) => item.name === "submit_campaign_artifact");
    await tool?.execute({ title: "测试产物", markdown: "证据、结论、待验证项与下一步。".repeat(40) });
    return { finalMessage: "", turns: 1, totalTokens: 123, toolCallCount: 1, stopReason: "no_tool_calls" };
  }) as typeof runLoop;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-campaign-runner-"));
  const campaign = await createCampaign({
    name: "Runner 测试",
    mode: "managed_growth",
    brief: {
      targetUrl: "https://example.com/",
      businessDescription: "测试 SaaS",
      goals: ["获取注册"],
      channels: ["content"],
      constraints: [],
    },
  }, dataDir);
  campaignId = campaign.id;
  await buildCampaignTeam(campaignId, dataDir);
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("campaign agent runner", () => {
  it("removes relay thinking blocks from persisted artifacts", () => {
    expect(sanitizeCampaignArtifact("结论\n<thinking>内部推理</thinking>\n\n证据")).toBe("结论\n\n证据");
    expect(sanitizeCampaignArtifact("<analysis>secret</analysis>报告")).toBe("报告");
  });

  it("audits the target page and forces a structured local artifact", async () => {
    const campaign = await getCampaign(campaignId, dataDir);
    const task = campaign!.tasks.find((item) => item.id.includes("business-audit"))!;
    const captured: { userMessage?: string } = {};
    const output = await executeCampaignAgentTask(campaignId, task, "run-test-1", dataDir, {
      configLoader: async () => config,
      fetchPageImpl: vi.fn().mockResolvedValue({ title: "Demo", text: "真实站点证据", truncated: false }),
      runLoopImpl: submittingLoop(captured),
    });
    expect(output).toMatchObject({ title: "测试产物", kind: "research", tokensUsed: 123 });
    expect(captured.userMessage).toContain("真实站点证据");
  });

  it("uses configured search evidence for market research", async () => {
    const campaign = await getCampaign(campaignId, dataDir);
    const task = campaign!.tasks.find((item) => item.id.includes("market-research"))!;
    const captured: { userMessage?: string } = {};
    const output = await executeCampaignAgentTask(campaignId, task, "run-test-2", dataDir, {
      configLoader: async () => config,
      searchConfigLoader: async () => ({ provider: "tavily", apiKey: "test" }),
      searchImpl: vi.fn().mockResolvedValue([{ title: "竞品证据", url: "https://competitor.example", snippet: "用户痛点" }]),
      runLoopImpl: submittingLoop(captured),
    });
    expect(output.kind).toBe("research");
    expect(captured.userMessage).toContain("竞品证据");
    expect(captured.userMessage).toContain("https://competitor.example");
  });

  it("accepts a validated long final response when a compatible relay omits the tool call", async () => {
    const campaign = await getCampaign(campaignId, dataDir);
    const task = campaign!.tasks.find((item) => item.id.includes("business-audit"))!;
    const output = await executeCampaignAgentTask(campaignId, task, "run-test-3", dataDir, {
      configLoader: async () => config,
      fetchPageImpl: vi.fn().mockResolvedValue({ title: "Demo", text: "真实站点证据", truncated: false }),
      runLoopImpl: (async () => ({
        finalMessage: "# 完整业务审计\n\n证据、结论、待验证项和下一步。".repeat(30),
        turns: 1,
        totalTokens: 321,
        toolCallCount: 0,
        stopReason: "no_tool_calls",
      })) as typeof runLoop,
    });
    expect(output.title).toBe(task.title);
    expect(output.markdown).toContain("完整业务审计");
  });
});
