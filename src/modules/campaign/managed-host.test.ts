import { describe, expect, it, vi } from "vitest";
import type {
  Campaign,
  CampaignAutonomyMode,
  CampaignTaskStatus,
} from "./domain.js";
import { createCampaignWorkflow } from "./workflow-engine.js";
import { runManagedCampaignHostTick } from "./managed-host.js";
import type { replanCampaign } from "./replanner.js";

const NOW = "2026-07-25T08:00:00.000Z";

function campaign(
  id: string,
  autonomy: CampaignAutonomyMode,
  taskStatus: CampaignTaskStatus = "ready",
): Campaign {
  return {
    schemaVersion: 2,
    id,
    name: id,
    mode: "personal",
    status: "active",
    brief: {
      businessDescription: "持续内容更新",
      goals: ["稳定更新"],
      channels: ["content"],
      constraints: [],
    },
    team: {
      id: `team-${id}`,
      planner: "rules_v1",
      version: 1,
      agents: [
        {
          id: "agent-copywriter",
          role: "copywriter",
          name: "文案",
          mission: "写作",
          capabilities: ["writing"],
          approvalRequiredFor: [],
        },
      ],
      createdAt: NOW,
    },
    tasks: [
      {
        id: "task-v1-draft",
        title: "写草稿",
        description: "产出一份可审核的内容草稿",
        assigneeRole: "copywriter",
        status: taskStatus,
        dependsOn: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    runs: [],
    artifacts:
      taskStatus === "completed"
        ? [
            {
              id: "artifact-1-demo",
              taskId: "task-v1-draft",
              kind: "content",
              title: "首轮内容",
              uri: "artifacts/artifact-1-demo.md",
              createdAt: NOW,
            },
          ]
        : [],
    approvals: [],
    metrics: [],
    workflow: createCampaignWorkflow(NOW, autonomy),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("managed campaign host", () => {
  it("never runs manual campaigns and does not replan supervised campaigns", async () => {
    const manual = campaign("campaign-1-manual", "manual");
    const supervised = campaign("campaign-2-supervised", "supervised");
    const runReady = vi.fn(async () => ({
      campaignId: supervised.id,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    }));
    const replan = vi.fn();
    const recordCycle = vi.fn(async () => supervised);

    const results = await runManagedCampaignHostTick(
      undefined,
      {
        list: async () => [manual, supervised],
        get: async () => supervised,
        runReady,
        replan,
        recordCycle,
      },
      new Date(NOW),
    );

    expect(results).toHaveLength(1);
    expect(runReady).toHaveBeenCalledWith(
      supervised.id,
      { maxTasks: supervised.workflow.policy.maxTasksPerCycle },
      undefined,
    );
    expect(replan).not.toHaveBeenCalled();
    expect(recordCycle).toHaveBeenCalledWith(
      supervised.id,
      expect.objectContaining({ status: "idle" }),
      undefined,
      NOW,
    );
  });

  it("replans a completed managed workflow and persists the hosted cycle", async () => {
    const managed = campaign("campaign-3-managed", "managed", "completed");
    const appliedPatch: Campaign["workflow"]["patches"][number] = {
      id: "patch-1-next",
      baseRevision: 0,
      reason: "首轮内容已经完成，需要基于表现信号规划下一轮更新",
      proposedBy: "agent",
      operations: [],
      status: "applied",
      requiresApproval: false,
      createdAt: NOW,
    };
    const replan = vi.fn(
      async () =>
        ({
          campaign: managed,
          patch: appliedPatch,
          runtime: "pi-agent",
        }) as Awaited<ReturnType<typeof replanCampaign>>,
    );
    const recordCycle = vi.fn(async () => managed);

    const [result] = await runManagedCampaignHostTick(
      "/tmp/autocrew-host-test",
      {
        list: async () => [managed],
        get: async () => managed,
        runReady: async () => ({
          campaignId: managed.id,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          results: [],
        }),
        replan,
        recordCycle,
      },
      new Date(NOW),
    );

    expect(replan).toHaveBeenCalledWith(managed.id, "/tmp/autocrew-host-test");
    expect(result).toMatchObject({ campaignId: managed.id, status: "succeeded" });
    expect(recordCycle).toHaveBeenCalledWith(
      managed.id,
      expect.objectContaining({ status: "succeeded" }),
      "/tmp/autocrew-host-test",
      NOW,
    );
  });

  it("stops at approvals instead of letting managed mode bypass them", async () => {
    const managed = campaign("campaign-4-approval", "managed", "awaiting_approval");
    managed.tasks[0].requiredApproval = "external_publish";
    const replan = vi.fn();
    const recordCycle = vi.fn(async () => managed);

    const [result] = await runManagedCampaignHostTick(
      undefined,
      {
        list: async () => [managed],
        get: async () => managed,
        runReady: async () => ({
          campaignId: managed.id,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          results: [],
        }),
        replan,
        recordCycle,
      },
      new Date(NOW),
    );

    expect(result.status).toBe("attention");
    expect(result.summary).toContain("风险审批");
    expect(replan).not.toHaveBeenCalled();
  });
});
