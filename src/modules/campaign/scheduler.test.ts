import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCampaignTeam, createCampaign, getCampaign, retryCampaignTask, transitionCampaign } from "../../storage/campaign-store.js";
import { runCampaignReadyTasks } from "./scheduler.js";

let dataDir: string;
let campaignId: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-campaign-scheduler-"));
  const campaign = await createCampaign({
    name: "调度测试",
    mode: "managed_growth",
    brief: { businessDescription: "测试业务", goals: ["验证闭环"], channels: ["content"], constraints: [] },
  }, dataDir);
  campaignId = campaign.id;
  await buildCampaignTeam(campaignId, dataDir);
  await transitionCampaign(campaignId, "active", dataDir);
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("campaign scheduler", () => {
  it("runs a bounded batch and unlocks the next dependency", async () => {
    const executeTask = vi.fn().mockImplementation(async (_id, task) => ({
      title: `产物:${task.title}`,
      markdown: "有证据的完整产物。".repeat(50),
      kind: "research",
      tokensUsed: 100,
    }));
    const batch = await runCampaignReadyTasks(campaignId, { maxTasks: 2 }, dataDir, { executeTask });
    expect(batch).toMatchObject({ attempted: 2, succeeded: 2, failed: 0 });
    const campaign = await getCampaign(campaignId, dataDir);
    expect(campaign?.runs).toHaveLength(2);
    expect(campaign?.artifacts).toHaveLength(2);
    expect(campaign?.tasks.find((task) => task.id.includes("growth-strategy"))?.status).toBe("ready");
  });

  it("records failure without fabricating an artifact and can be retried", async () => {
    const executeTask = vi.fn().mockRejectedValue(new Error("搜索未配置"));
    const batch = await runCampaignReadyTasks(campaignId, { maxTasks: 1 }, dataDir, { executeTask });
    expect(batch).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    const campaign = await getCampaign(campaignId, dataDir);
    const failed = campaign!.tasks.find((task) => task.status === "failed")!;
    expect(campaign?.artifacts).toHaveLength(0);
    await retryCampaignTask(campaignId, failed.id, dataDir);
    expect((await getCampaign(campaignId, dataDir))?.tasks.find((task) => task.id === failed.id)?.status).toBe("ready");
  });
});
