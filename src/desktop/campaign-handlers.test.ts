import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  campaignCreateHandler,
  campaignGetHandler,
  campaignListHandler,
  campaignPatchDecideHandler,
  campaignPatchProposeHandler,
  campaignPlanTeamHandler,
  campaignSetAutonomyHandler,
  campaignTransitionHandler,
} from "./campaign-handlers.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-campaign-handler-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("campaign IPC handlers", () => {
  it("creates a managed-growth campaign from a site and assembles its team", async () => {
    const created = await campaignCreateHandler({
      name: "Demo SaaS 推广",
      mode: "managed_growth",
      target_url: "https://example.com",
      goals: ["30 天获得 100 个注册"],
      channels: ["seo", "xiaohongshu"],
      _dataDir: dataDir,
    });
    expect(created.ok).toBe(true);
    const id = (created.data as { campaign: { id: string } }).campaign.id;

    const planned = await campaignPlanTeamHandler({ id, _dataDir: dataDir });
    expect(planned.ok).toBe(true);
    expect((planned.data as { campaign: { status: string } }).campaign.status).toBe("ready");

    const activated = await campaignTransitionHandler({ id, target_status: "active", _dataDir: dataDir });
    expect(activated.ok).toBe(true);
    expect((activated.data as { campaign: { status: string } }).campaign.status).toBe("active");

    expect((await campaignGetHandler({ id, _dataDir: dataDir })).ok).toBe(true);
    expect(((await campaignListHandler({ _dataDir: dataDir })).data as { campaigns: unknown[] }).campaigns).toHaveLength(1);
  });

  it("rejects unsupported URLs, modes, channels and traversal ids", async () => {
    expect((await campaignCreateHandler({ name: "x", mode: "managed_growth", goals: ["g"], target_url: "file:///etc/passwd", _dataDir: dataDir })).ok).toBe(false);
    expect((await campaignCreateHandler({ name: "x", mode: "unknown", goals: ["g"], business_description: "b", _dataDir: dataDir })).ok).toBe(false);
    expect((await campaignCreateHandler({ name: "x", mode: "personal", goals: ["g"], business_description: "b", channels: ["shell"], _dataDir: dataDir })).ok).toBe(false);
    expect((await campaignGetHandler({ id: "../../secret", _dataDir: dataDir })).ok).toBe(false);
  });

  it("switches autonomy and applies an approved workflow patch", async () => {
    const created = await campaignCreateHandler({
      name: "托管内容",
      mode: "personal",
      business_description: "持续生产内容",
      goals: ["每周稳定更新"],
      channels: ["content"],
      _dataDir: dataDir,
    });
    const id = (created.data as { campaign: { id: string } }).campaign.id;
    const planned = await campaignPlanTeamHandler({ id, _dataDir: dataDir });
    const campaign = (planned.data as {
      campaign: { workflow: { revision: number }; tasks: Array<{ id: string }> };
    }).campaign;

    const autonomy = await campaignSetAutonomyHandler({
      id,
      autonomy: "supervised",
      interval_minutes: 360,
      _dataDir: dataDir,
    });
    expect(
      (autonomy.data as {
        campaign: { workflow: { autonomy: string; schedule: { intervalMinutes: number } } };
      }).campaign.workflow,
    ).toMatchObject({ autonomy: "supervised", schedule: { intervalMinutes: 360 } });

    const proposed = await campaignPatchProposeHandler({
      id,
      base_revision: campaign.workflow.revision,
      reason: "增加一项基于首轮研究证据的内容任务",
      operations: [
        {
          op: "add_task",
          key: "weekly-update",
          title: "生成本周内容更新",
          description: "根据已有业务审计产出一份新的内容更新",
          assigneeRole: "copywriter",
          channel: "content",
          dependsOn: [],
        },
      ],
      _dataDir: dataDir,
    });
    expect(proposed.ok).toBe(true);
    const patch = (proposed.data as { patch: { id: string; status: string } }).patch;
    expect(patch.status).toBe("proposed");

    const decided = await campaignPatchDecideHandler({
      id,
      patch_id: patch.id,
      approved: true,
      _dataDir: dataDir,
    });
    expect(decided.ok).toBe(true);
    const updated = (decided.data as {
      campaign: { tasks: Array<{ id: string }>; workflow: { revision: number } };
    }).campaign;
    expect(updated.tasks.some((task) => task.id.includes("weekly-update"))).toBe(true);
    expect(updated.workflow.revision).toBe(campaign.workflow.revision + 1);
  });
});
