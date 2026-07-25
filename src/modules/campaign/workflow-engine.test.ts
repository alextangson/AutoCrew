import { describe, expect, it } from "vitest";
import type { Campaign, CampaignTask } from "./domain.js";
import {
  createCampaignWorkflow,
  decideCampaignWorkflowPatch,
  normalizeCampaignWorkflow,
  proposeCampaignWorkflowPatch,
  recordCampaignHostedCycle,
  setCampaignAutonomy,
} from "./workflow-engine.js";

const NOW = "2026-07-25T02:00:00.000Z";

function task(overrides: Partial<CampaignTask> = {}): CampaignTask {
  return {
    id: "task-v1-research",
    title: "研究证据",
    description: "收集并验证当前市场证据",
    assigneeRole: "market_researcher",
    status: "completed",
    dependsOn: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function campaign(autonomy: "manual" | "supervised" | "managed" = "manual"): Campaign {
  return {
    schemaVersion: 2,
    id: "campaign-1-demo",
    name: "Dynamic Workflow",
    mode: "managed_growth",
    status: "active",
    brief: {
      businessDescription: "内容增长业务",
      goals: ["持续产出并更新内容"],
      channels: ["content"],
      constraints: [],
    },
    team: {
      id: "team-1",
      planner: "rules_v1",
      version: 1,
      agents: [
        {
          id: "agent-market-researcher",
          role: "market_researcher",
          name: "市场研究员",
          mission: "验证证据",
          capabilities: ["research"],
          approvalRequiredFor: [],
        },
        {
          id: "agent-copywriter",
          role: "copywriter",
          name: "文案",
          mission: "生产内容",
          capabilities: ["writing"],
          approvalRequiredFor: ["external_publish"],
        },
      ],
      createdAt: NOW,
    },
    tasks: [task()],
    runs: [],
    artifacts: [],
    approvals: [],
    metrics: [],
    workflow: createCampaignWorkflow(NOW, autonomy),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const addDraft = {
  baseRevision: 0,
  reason: "市场研究完成，需要生产一篇基于证据的内容",
  proposedBy: "agent" as const,
  operations: [
    {
      op: "add_task" as const,
      key: "write-evidence-post",
      title: "撰写证据型内容",
      description: "根据已完成研究产出可审核的渠道母稿",
      assigneeRole: "copywriter" as const,
      channel: "content" as const,
      dependsOn: ["task-v1-research"],
    },
  ],
};

describe("campaign dynamic workflow engine", () => {
  it("keeps manual patches pending, then applies an approved DAG-safe change", () => {
    const proposed = proposeCampaignWorkflowPatch(campaign(), addDraft, NOW);
    expect(proposed.patch.status).toBe("proposed");
    expect(proposed.campaign.workflow.revision).toBe(0);

    const applied = decideCampaignWorkflowPatch(
      proposed.campaign,
      proposed.patch.id,
      true,
      "批准",
      "2026-07-25T02:01:00.000Z",
    );
    expect(applied.workflow.revision).toBe(1);
    expect(applied.workflow.patches[0].status).toBe("applied");
    expect(applied.tasks.find((item) => item.id === "task-dyn-r1-write-evidence-post")).toMatchObject({
      status: "ready",
      assigneeRole: "copywriter",
    });
  });

  it("auto-applies safe managed patches but still gates destructive changes", () => {
    const managed = campaign("managed");
    const safe = proposeCampaignWorkflowPatch(managed, addDraft, NOW);
    expect(safe.patch.status).toBe("applied");
    expect(safe.campaign.workflow.revision).toBe(1);

    const destructive = proposeCampaignWorkflowPatch(
      safe.campaign,
      {
        baseRevision: 1,
        reason: "新内容任务不再需要，需要明确人工确认后取消",
        proposedBy: "agent",
        operations: [
          {
            op: "cancel_task",
            taskId: "task-dyn-r1-write-evidence-post",
            reason: "渠道计划已经变化",
          },
        ],
      },
      "2026-07-25T02:02:00.000Z",
    );
    expect(destructive.patch.status).toBe("proposed");
    expect(destructive.patch.requiresApproval).toBe(true);
    expect(destructive.campaign.workflow.revision).toBe(1);
  });

  it("rejects revision conflicts, cycles and mutation of completed tasks", () => {
    expect(() =>
      proposeCampaignWorkflowPatch(campaign(), { ...addDraft, baseRevision: 9 }, NOW),
    ).toThrow(/revision 冲突/);

    expect(() =>
      proposeCampaignWorkflowPatch(
        campaign(),
        {
          baseRevision: 0,
          reason: "尝试错误地修改已经完成的任务说明",
          proposedBy: "agent",
          operations: [
            {
              op: "update_task",
              taskId: "task-v1-research",
              description: "不应允许修改完成任务",
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/completed/);

    const pending = campaign();
    pending.tasks.push(
      task({
        id: "task-v1-draft",
        title: "草稿",
        description: "等待研究完成后开始草稿",
        status: "pending",
        dependsOn: ["task-v1-research"],
      }),
    );
    expect(() =>
      proposeCampaignWorkflowPatch(
        pending,
        {
          baseRevision: 0,
          reason: "尝试制造一个无效的循环依赖用于验证",
          proposedBy: "agent",
          operations: [
            {
              op: "replace_dependencies",
              taskId: "task-v1-draft",
              dependsOn: ["task-v1-draft"],
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/依赖自身|循环依赖/);
  });

  it("normalizes old campaigns and records autonomy changes", () => {
    const workflow = normalizeCampaignWorkflow(undefined, NOW);
    expect(workflow).toMatchObject({
      revision: 0,
      autonomy: "manual",
      schedule: { intervalMinutes: 1440 },
    });
    const changed = setCampaignAutonomy({ ...campaign(), workflow }, "supervised", NOW);
    expect(changed.workflow.autonomy).toBe("supervised");
    expect(changed.workflow.schedule.nextRunAt).toBe(NOW);
    expect(changed.workflow.events.at(-1)?.type).toBe("autonomy_changed");

    const rescheduled = setCampaignAutonomy(changed, "supervised", NOW, 360);
    expect(rescheduled.workflow.schedule.intervalMinutes).toBe(360);
    expect(rescheduled.workflow.events.at(-1)?.type).toBe("host_schedule_changed");

    const completed = recordCampaignHostedCycle(
      rescheduled,
      { status: "idle", summary: "当前没有可执行任务" },
      NOW,
    );
    expect(completed.workflow.schedule).toMatchObject({
      lastCycleAt: NOW,
      lastCycleStatus: "idle",
      nextRunAt: "2026-07-25T08:00:00.000Z",
    });
  });
});
