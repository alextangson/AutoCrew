import { loadEngineConfig, resolveEngineRoute, type EngineConfig } from "../../engine/config.js";
import {
  getCampaign,
  proposeCampaignWorkflowPatch,
} from "../../storage/campaign-store.js";
import { piAgentRuntime } from "../../agents/pi-runtime.js";
import type { AgentRuntime } from "../../agents/runtime.js";
import type {
  Campaign,
  CampaignWorkflowPatchOperation,
} from "./domain.js";
import type { CampaignWorkflowPatchDraft } from "./workflow-engine.js";

interface ReplannerDeps {
  runtime?: AgentRuntime;
  configLoader?: (dataDir?: string) => Promise<EngineConfig>;
}

function replanContext(campaign: Campaign): string {
  return JSON.stringify(
    {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        mode: campaign.mode,
        status: campaign.status,
        brief: campaign.brief,
      },
      workflow: {
        revision: campaign.workflow.revision,
        autonomy: campaign.workflow.autonomy,
        policy: campaign.workflow.policy,
      },
      team: campaign.team?.agents.map(({ role, name, mission, capabilities }) => ({
        role,
        name,
        mission,
        capabilities,
      })),
      tasks: campaign.tasks.map(
        ({ id, title, description, assigneeRole, channel, status, dependsOn, requiredApproval }) => ({
          id,
          title,
          description,
          assigneeRole,
          channel,
          status,
          dependsOn,
          requiredApproval,
        }),
      ),
      recentArtifacts: campaign.artifacts.slice(-12).map(({ id, taskId, kind, title, createdAt }) => ({
        id,
        taskId,
        kind,
        title,
        createdAt,
      })),
      recentMetrics: campaign.metrics.slice(-12),
      recentFailures: campaign.runs
        .filter((run) => run.status === "failed")
        .slice(-8)
        .map(({ taskId, attempt, error }) => ({ taskId, attempt, error })),
    },
    null,
    2,
  );
}

function isPatchOperation(value: unknown): value is CampaignWorkflowPatchOperation {
  return Boolean(
    value &&
      typeof value === "object" &&
      "op" in value &&
      ["add_task", "update_task", "replace_dependencies", "cancel_task"].includes(
        String((value as { op?: unknown }).op),
      ),
  );
}

export async function replanCampaign(
  campaignId: string,
  dataDir?: string,
  deps: ReplannerDeps = {},
): Promise<{
  campaign: Campaign;
  patch: Campaign["workflow"]["patches"][number];
  runtime: AgentRuntime["kind"];
}> {
  const campaign = await getCampaign(campaignId, dataDir);
  if (!campaign) throw new Error(`Campaign 不存在:${campaignId}`);
  if (!campaign.team || campaign.tasks.length === 0) throw new Error("Campaign 尚未生成首轮任务图");
  if (!["active", "paused", "ready"].includes(campaign.status)) {
    throw new Error(`Campaign ${campaign.status} 状态不可重规划`);
  }

  const config = await (deps.configLoader ?? loadEngineConfig)(dataDir);
  const route = resolveEngineRoute(config, "analytics", config.strongModel);
  const runtime = deps.runtime ?? piAgentRuntime;
  let draft: CampaignWorkflowPatchDraft | null = null;

  await runtime.run(route.config, {
    model: route.model,
    systemPrompt:
      "你是 AutoCrew Dynamic Workflow 的 Replanner。你只根据提供的 Campaign 状态、产物、指标和失败记录提出必要的最小变更。" +
      "不得修改 running/completed/cancelled 任务，不得删除审批门，不得编造指标。优先新增有明确证据和交付物的任务。" +
      "如果确有必要变更，必须调用 propose_workflow_patch；不要在普通回复中假装已经修改工作流。",
    userMessage:
      `请审查下面的 Campaign，并提出下一轮最小可行工作流 Patch。baseRevision 必须是 ${campaign.workflow.revision}。` +
      "add_task 的 dependsOn 只能引用现有任务 id；一次最多 4 个操作。\n\n" +
      replanContext(campaign),
    tools: [
      {
        name: "propose_workflow_patch",
        description: "提出经过 AutoCrew 校验、可能需要用户审批的结构化工作流 Patch。",
        parameters: {
          type: "object",
          properties: {
            baseRevision: { type: "integer" },
            reason: { type: "string", minLength: 8, maxLength: 1000 },
            operations: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  op: {
                    type: "string",
                    enum: ["add_task", "update_task", "replace_dependencies", "cancel_task"],
                  },
                  key: { type: "string" },
                  taskId: { type: "string" },
                  title: { type: "string" },
                  description: { type: "string" },
                  assigneeRole: { type: "string" },
                  channel: { type: "string" },
                  dependsOn: { type: "array", items: { type: "string" } },
                  requiredApproval: { type: "string" },
                  reason: { type: "string" },
                },
                required: ["op"],
              },
            },
          },
          required: ["baseRevision", "reason", "operations"],
        },
        execute(args) {
          if (
            typeof args.baseRevision !== "number" ||
            typeof args.reason !== "string" ||
            !Array.isArray(args.operations) ||
            !args.operations.every(isPatchOperation)
          ) {
            return "Error: Patch 结构非法，请修正后重新提交";
          }
          draft = {
            baseRevision: args.baseRevision,
            reason: args.reason,
            proposedBy: "agent",
            operations: args.operations,
          };
          return "Patch 提议已接收，最终是否应用由 AutoCrew Policy 决定";
        },
      },
    ],
    maxTurns: 3,
    maxTotalTokens: 16_000,
    logMeta: { agent: "workflow_replanner" },
  });

  if (!draft) throw new Error("Replanner 未提交结构化工作流 Patch");
  const result = await proposeCampaignWorkflowPatch(campaignId, draft, dataDir);
  if (!result) throw new Error("Campaign 在重规划期间消失");
  return { ...result, runtime: runtime.kind };
}
