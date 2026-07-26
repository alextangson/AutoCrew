import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../agents/runtime.js";
import type { EngineConfig } from "../../engine/config.js";
import { buildCampaignTeam, createCampaign } from "../../storage/campaign-store.js";
import { replanCampaign } from "./replanner.js";

let dataDir: string;
let campaignId: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-replanner-"));
  const campaign = await createCampaign(
    {
      name: "内容托管",
      mode: "personal",
      brief: {
        businessDescription: "每周更新产品内容",
        goals: ["稳定产生有证据的内容"],
        channels: ["content"],
        constraints: [],
      },
    },
    dataDir,
  );
  campaignId = campaign.id;
  await buildCampaignTeam(campaignId, dataDir);
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("campaign replanner", () => {
  it("uses the AgentRuntime port and persists the structured patch through workflow policy", async () => {
    const runtime: AgentRuntime = {
      kind: "pi-agent",
      async run(_config, options) {
        const tool = options.tools?.find((item) => item.name === "propose_workflow_patch");
        await tool?.execute({
          baseRevision: 1,
          reason: "需要增加一个定期更新内容的任务以持续达成目标",
          operations: [
            {
              op: "add_task",
              key: "refresh-content",
              title: "更新核心内容",
              description: "根据最新研究证据更新核心内容并交给人工审核",
              assigneeRole: "copywriter",
              channel: "content",
              dependsOn: [],
            },
          ],
        });
        return {
          finalMessage: "",
          turns: 1,
          totalTokens: 100,
          toolCallCount: 1,
          stopReason: "no_tool_calls",
          runtime: "pi-agent",
          sessionId: "session-test",
        };
      },
    };
    const config: EngineConfig = {
      apiKey: "test",
      baseUrl: "https://example.invalid",
      strongModel: "test-model",
      fastModel: "test-model",
    };
    const result = await replanCampaign(campaignId, dataDir, {
      runtime,
      configLoader: async () => config,
    });
    expect(result.runtime).toBe("pi-agent");
    expect(result.patch).toMatchObject({ status: "proposed", proposedBy: "agent" });
    expect(result.campaign.workflow.revision).toBe(1);
  });
});
