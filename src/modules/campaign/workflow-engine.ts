import {
  isCampaignAutonomyMode,
  isPromotionChannel,
  type Campaign,
  type CampaignAgentRole,
  type CampaignAutonomyMode,
  type CampaignHostedCycleStatus,
  type CampaignTask,
  type CampaignWorkflow,
  type CampaignWorkflowEvent,
  type CampaignWorkflowPatch,
  type CampaignWorkflowPatchOperation,
  type CampaignWorkflowPolicy,
  type GovernedAction,
} from "./domain.js";

const DEFAULT_POLICY: CampaignWorkflowPolicy = {
  maxTasksPerCycle: 2,
  maxRunsPerDay: 20,
  maxPatchOperations: 12,
  maxReplansPerDay: 8,
  maxConsecutiveFailures: 3,
};
export const DEFAULT_HOST_INTERVAL_MINUTES = 24 * 60;
export const MIN_HOST_INTERVAL_MINUTES = 15;
export const MAX_HOST_INTERVAL_MINUTES = 7 * 24 * 60;

const TASK_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID_RE = /^task-(?:v\d+|dyn-r\d+)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const PATCH_ID_RE = /^patch-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const GOVERNED_ACTIONS = new Set<GovernedAction>([
  "external_publish",
  "send_message",
  "paid_spend",
  "change_website",
  "export_customer_data",
]);
const AGENT_ROLES = new Set<CampaignAgentRole>([
  "growth_lead",
  "market_researcher",
  "content_strategist",
  "copywriter",
  "seo_specialist",
  "channel_operator",
  "paid_media_specialist",
  "performance_analyst",
]);

export interface CampaignWorkflowPatchDraft {
  baseRevision: number;
  reason: string;
  proposedBy: CampaignWorkflowPatch["proposedBy"];
  operations: CampaignWorkflowPatchOperation[];
}

function event(
  workflow: CampaignWorkflow,
  input: Omit<CampaignWorkflowEvent, "seq">,
): CampaignWorkflowEvent {
  return { seq: (workflow.events.at(-1)?.seq ?? 0) + 1, ...input };
}

export function createCampaignWorkflow(
  now = new Date().toISOString(),
  autonomy: CampaignAutonomyMode = "manual",
): CampaignWorkflow {
  return {
    revision: 0,
    autonomy,
    policy: { ...DEFAULT_POLICY },
    schedule: {
      intervalMinutes: DEFAULT_HOST_INTERVAL_MINUTES,
      ...(autonomy === "manual" ? {} : { nextRunAt: now }),
    },
    patches: [],
    events: [
      {
        seq: 1,
        type: "campaign_created",
        at: now,
        actor: "human",
        summary: "Campaign workflow 已创建",
      },
    ],
  };
}

/**
 * Read-time migration keeps older campaign.json files usable without making
 * reads perform hidden writes.
 */
export function normalizeCampaignWorkflow(
  value: Partial<CampaignWorkflow> | undefined,
  createdAt: string,
): CampaignWorkflow {
  const autonomy = isCampaignAutonomyMode(value?.autonomy) ? value.autonomy : "manual";
  const policy = value?.policy ?? DEFAULT_POLICY;
  const schedule = value?.schedule;
  const intervalMinutes = boundedInt(
    schedule?.intervalMinutes,
    DEFAULT_HOST_INTERVAL_MINUTES,
    MIN_HOST_INTERVAL_MINUTES,
    MAX_HOST_INTERVAL_MINUTES,
  );
  return {
    revision: Number.isInteger(value?.revision) && (value?.revision ?? -1) >= 0 ? value!.revision! : 0,
    autonomy,
    policy: {
      maxTasksPerCycle: boundedInt(policy.maxTasksPerCycle, DEFAULT_POLICY.maxTasksPerCycle, 1, 10),
      maxRunsPerDay: boundedInt(policy.maxRunsPerDay, DEFAULT_POLICY.maxRunsPerDay, 1, 200),
      maxPatchOperations: boundedInt(policy.maxPatchOperations, DEFAULT_POLICY.maxPatchOperations, 1, 30),
      maxReplansPerDay: boundedInt(policy.maxReplansPerDay, DEFAULT_POLICY.maxReplansPerDay, 1, 50),
      maxConsecutiveFailures: boundedInt(
        policy.maxConsecutiveFailures,
        DEFAULT_POLICY.maxConsecutiveFailures,
        1,
        20,
      ),
    },
    schedule: {
      intervalMinutes,
      ...(autonomy !== "manual"
        ? { nextRunAt: validIsoDate(schedule?.nextRunAt) ?? createdAt }
        : {}),
      ...(validIsoDate(schedule?.lastCycleAt)
        ? { lastCycleAt: validIsoDate(schedule?.lastCycleAt) }
        : {}),
      ...(isHostedCycleStatus(schedule?.lastCycleStatus)
        ? { lastCycleStatus: schedule.lastCycleStatus }
        : {}),
      ...(typeof schedule?.lastCycleSummary === "string" && schedule.lastCycleSummary.trim()
        ? { lastCycleSummary: schedule.lastCycleSummary.trim().slice(0, 500) }
        : {}),
    },
    patches: Array.isArray(value?.patches)
      ? value.patches.filter((patch): patch is CampaignWorkflowPatch => Boolean(patch && PATCH_ID_RE.test(patch.id)))
      : [],
    events:
      Array.isArray(value?.events) && value.events.length > 0
        ? value.events.slice(-500)
        : [
            {
              seq: 1,
              type: "campaign_created",
              at: createdAt,
              actor: "system",
              summary: "旧 Campaign 已迁移到 Dynamic Workflow",
            },
          ],
  };
}

function validIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function isHostedCycleStatus(value: unknown): value is CampaignHostedCycleStatus {
  return ["succeeded", "idle", "attention", "failed"].includes(String(value));
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(min, Math.min(value, max))
    : fallback;
}

function cloneCampaign(campaign: Campaign): Campaign {
  return structuredClone(campaign);
}

function assertText(value: string, label: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${label} 长度必须在 ${min}-${max} 之间`);
  }
  return text;
}

function assertTaskMutable(task: CampaignTask): void {
  if (task.status === "running" || task.status === "completed" || task.status === "cancelled") {
    throw new Error(`任务 ${task.id} 处于 ${task.status}，不可被工作流 Patch 修改`);
  }
}

function assertRole(campaign: Campaign, role: CampaignAgentRole): void {
  if (!AGENT_ROLES.has(role) || !campaign.team?.agents.some((agent) => agent.role === role)) {
    throw new Error(`工作流角色不可用:${role}`);
  }
}

function assertGovernedAction(value: GovernedAction | undefined): void {
  if (value !== undefined && !GOVERNED_ACTIONS.has(value)) {
    throw new Error(`未知审批动作:${String(value)}`);
  }
}

function assertPatchShape(
  campaign: Campaign,
  draft: CampaignWorkflowPatchDraft,
  now: string,
): void {
  if (!Number.isInteger(draft.baseRevision) || draft.baseRevision !== campaign.workflow.revision) {
    throw new Error(
      `工作流 revision 冲突:期望 ${campaign.workflow.revision}，收到 ${String(draft.baseRevision)}`,
    );
  }
  assertText(draft.reason, "Patch 原因", 8, 1_000);
  if (!["human", "agent", "system"].includes(draft.proposedBy)) {
    throw new Error("Patch proposedBy 非法");
  }
  if (
    !Array.isArray(draft.operations) ||
    draft.operations.length === 0 ||
    draft.operations.length > campaign.workflow.policy.maxPatchOperations
  ) {
    throw new Error(`Patch 操作数必须在 1-${campaign.workflow.policy.maxPatchOperations} 之间`);
  }
  const today = now.slice(0, 10);
  const replansToday = campaign.workflow.patches.filter((patch) =>
    patch.createdAt.startsWith(today),
  ).length;
  if (replansToday >= campaign.workflow.policy.maxReplansPerDay) {
    throw new Error(`今日重规划次数已达上限:${campaign.workflow.policy.maxReplansPerDay}`);
  }
}

function applyOperation(
  campaign: Campaign,
  operation: CampaignWorkflowPatchOperation,
  nextRevision: number,
  now: string,
): void {
  if (operation.op === "add_task") {
    if (!TASK_KEY_RE.test(operation.key)) throw new Error(`动态任务 key 非法:${operation.key}`);
    assertRole(campaign, operation.assigneeRole);
    assertGovernedAction(operation.requiredApproval);
    if (operation.channel !== undefined && !isPromotionChannel(operation.channel)) {
      throw new Error(`未知渠道:${String(operation.channel)}`);
    }
    const id = `task-dyn-r${nextRevision}-${operation.key}`;
    if (campaign.tasks.some((task) => task.id === id)) throw new Error(`动态任务重复:${id}`);
    campaign.tasks.push({
      id,
      title: assertText(operation.title, "任务标题", 2, 160),
      description: assertText(operation.description, "任务说明", 8, 2_000),
      assigneeRole: operation.assigneeRole,
      ...(operation.channel ? { channel: operation.channel } : {}),
      status: "pending",
      dependsOn: [...new Set(operation.dependsOn)],
      ...(operation.requiredApproval ? { requiredApproval: operation.requiredApproval } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  if (!TASK_ID_RE.test(operation.taskId)) throw new Error(`任务 id 非法:${operation.taskId}`);
  const task = campaign.tasks.find((item) => item.id === operation.taskId);
  if (!task) throw new Error(`任务不存在:${operation.taskId}`);
  assertTaskMutable(task);

  if (operation.op === "cancel_task") {
    assertText(operation.reason, "取消原因", 4, 500);
    task.status = "cancelled";
    task.updatedAt = now;
    return;
  }

  if (operation.op === "replace_dependencies") {
    task.dependsOn = [...new Set(operation.dependsOn)];
    task.updatedAt = now;
    return;
  }

  if (operation.title !== undefined) task.title = assertText(operation.title, "任务标题", 2, 160);
  if (operation.description !== undefined) {
    task.description = assertText(operation.description, "任务说明", 8, 2_000);
  }
  if (operation.assigneeRole !== undefined) {
    assertRole(campaign, operation.assigneeRole);
    task.assigneeRole = operation.assigneeRole;
  }
  if (operation.channel !== undefined) {
    if (!isPromotionChannel(operation.channel)) throw new Error(`未知渠道:${String(operation.channel)}`);
    task.channel = operation.channel;
  }
  if (operation.requiredApproval !== undefined) {
    assertGovernedAction(operation.requiredApproval);
    // A patch may add or strengthen a gate. It may never remove one because the
    // operation format deliberately has no null/undefined removal semantics.
    task.requiredApproval = operation.requiredApproval;
  }
  task.updatedAt = now;
}

function assertAcyclicAndComplete(tasks: CampaignTask[]): void {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.status === "cancelled") continue;
    for (const dependency of task.dependsOn) {
      const source = taskById.get(dependency);
      if (!source) throw new Error(`任务 ${task.id} 依赖不存在:${dependency}`);
      if (source.status === "cancelled") throw new Error(`任务 ${task.id} 依赖已取消任务:${dependency}`);
      if (dependency === task.id) throw new Error(`任务 ${task.id} 不能依赖自身`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: CampaignTask): void => {
    if (task.status === "cancelled" || visited.has(task.id)) return;
    if (visiting.has(task.id)) throw new Error(`工作流存在循环依赖:${task.id}`);
    visiting.add(task.id);
    for (const dependency of task.dependsOn) visit(taskById.get(dependency)!);
    visiting.delete(task.id);
    visited.add(task.id);
  };
  for (const task of tasks) visit(task);
}

function refreshTaskReadiness(campaign: Campaign, now: string): void {
  const completed = new Set(
    campaign.tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );
  for (const task of campaign.tasks) {
    if (
      task.status === "running" ||
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled"
    ) {
      continue;
    }
    const ready = task.dependsOn.every((dependency) => completed.has(dependency));
    task.status = ready ? (task.requiredApproval ? "awaiting_approval" : "ready") : "pending";
    task.updatedAt = now;
  }
}

function containsDestructiveOperation(operations: CampaignWorkflowPatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.op === "cancel_task" || operation.op === "replace_dependencies",
  );
}

function applyPatch(campaign: Campaign, patch: CampaignWorkflowPatch, now: string): Campaign {
  if (patch.baseRevision !== campaign.workflow.revision) {
    throw new Error(
      `工作流 revision 冲突:期望 ${campaign.workflow.revision}，Patch 基于 ${patch.baseRevision}`,
    );
  }
  const nextRevision = campaign.workflow.revision + 1;
  for (const operation of patch.operations) applyOperation(campaign, operation, nextRevision, now);
  assertAcyclicAndComplete(campaign.tasks);
  refreshTaskReadiness(campaign, now);
  campaign.workflow.revision = nextRevision;
  patch.status = "applied";
  patch.decidedAt = now;
  for (const stale of campaign.workflow.patches) {
    if (stale.id === patch.id || stale.status !== "proposed") continue;
    stale.status = "rejected";
    stale.decidedAt = now;
    stale.decisionNote = `工作流已前进到 revision ${nextRevision}，本 Patch 已过期`;
  }
  campaign.workflow.events.push(
    event(campaign.workflow, {
      type: "patch_applied",
      at: now,
      actor: patch.proposedBy === "human" ? "human" : "system",
      summary: `已应用工作流 Patch:${patch.reason}`,
      patchId: patch.id,
    }),
  );
  campaign.workflow.events = campaign.workflow.events.slice(-500);
  return campaign;
}

export function proposeCampaignWorkflowPatch(
  source: Campaign,
  draft: CampaignWorkflowPatchDraft,
  now = new Date().toISOString(),
): { campaign: Campaign; patch: CampaignWorkflowPatch } {
  const campaign = cloneCampaign(source);
  assertPatchShape(campaign, draft, now);

  // Dry-run on a disposable copy before persisting even a pending proposal.
  const dryRun = cloneCampaign(campaign);
  const dryPatch: CampaignWorkflowPatch = {
    id: "patch-dry-run",
    ...structuredClone(draft),
    status: "proposed",
    requiresApproval: true,
    createdAt: now,
  };
  applyPatch(dryRun, dryPatch, now);

  const requiresApproval =
    campaign.workflow.autonomy !== "managed" || containsDestructiveOperation(draft.operations);
  const patch: CampaignWorkflowPatch = {
    id: `patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    baseRevision: draft.baseRevision,
    reason: draft.reason.trim(),
    proposedBy: draft.proposedBy,
    operations: structuredClone(draft.operations),
    status: "proposed",
    requiresApproval,
    createdAt: now,
  };
  campaign.workflow.patches.push(patch);
  campaign.workflow.events.push(
    event(campaign.workflow, {
      type: "patch_proposed",
      at: now,
      actor: draft.proposedBy,
      summary: `提出工作流 Patch:${patch.reason}`,
      patchId: patch.id,
    }),
  );

  if (!requiresApproval) applyPatch(campaign, patch, now);
  campaign.workflow.events = campaign.workflow.events.slice(-500);
  return { campaign, patch };
}

export function decideCampaignWorkflowPatch(
  source: Campaign,
  patchId: string,
  approved: boolean,
  note = "",
  now = new Date().toISOString(),
): Campaign {
  if (!PATCH_ID_RE.test(patchId)) throw new Error("Patch id 非法");
  const campaign = cloneCampaign(source);
  const patch = campaign.workflow.patches.find((item) => item.id === patchId);
  if (!patch || patch.status !== "proposed") throw new Error("待审 Patch 不存在或已处理");
  if (!approved) {
    patch.status = "rejected";
    patch.decidedAt = now;
    patch.decisionNote = note.trim().slice(0, 500);
    campaign.workflow.events.push(
      event(campaign.workflow, {
        type: "patch_rejected",
        at: now,
        actor: "human",
        summary: `已拒绝工作流 Patch:${patch.reason}`,
        patchId,
      }),
    );
    campaign.workflow.events = campaign.workflow.events.slice(-500);
    return campaign;
  }
  patch.decisionNote = note.trim().slice(0, 500);
  return applyPatch(campaign, patch, now);
}

export function setCampaignAutonomy(
  source: Campaign,
  autonomy: CampaignAutonomyMode,
  now = new Date().toISOString(),
  intervalMinutes = source.workflow.schedule.intervalMinutes,
): Campaign {
  if (!isCampaignAutonomyMode(autonomy)) throw new Error("自治模式非法");
  const campaign = cloneCampaign(source);
  const previous = campaign.workflow.autonomy;
  const previousInterval = campaign.workflow.schedule.intervalMinutes;
  const nextInterval = boundedInt(
    intervalMinutes,
    previousInterval,
    MIN_HOST_INTERVAL_MINUTES,
    MAX_HOST_INTERVAL_MINUTES,
  );
  if (previous === autonomy && previousInterval === nextInterval) return campaign;
  campaign.workflow.autonomy = autonomy;
  campaign.workflow.schedule.intervalMinutes = nextInterval;
  if (autonomy === "manual") {
    delete campaign.workflow.schedule.nextRunAt;
  } else if (
    previous === "manual" ||
    previousInterval !== nextInterval ||
    !campaign.workflow.schedule.nextRunAt
  ) {
    campaign.workflow.schedule.nextRunAt = now;
  }
  campaign.workflow.events.push(
    event(campaign.workflow, {
      type: previous === autonomy ? "host_schedule_changed" : "autonomy_changed",
      at: now,
      actor: "human",
      summary:
        previous === autonomy
          ? `托管周期调整为 ${nextInterval} 分钟`
          : `自治模式:${previous} → ${autonomy}；托管周期 ${nextInterval} 分钟`,
    }),
  );
  campaign.workflow.events = campaign.workflow.events.slice(-500);
  return campaign;
}

export function recordCampaignHostedCycle(
  source: Campaign,
  result: {
    status: CampaignHostedCycleStatus;
    summary: string;
    nextRunInMinutes?: number;
  },
  now = new Date().toISOString(),
): Campaign {
  if (!isHostedCycleStatus(result.status)) throw new Error("托管周期状态非法");
  const campaign = cloneCampaign(source);
  const summary = assertText(result.summary, "托管周期摘要", 2, 500);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("托管周期时间非法");
  campaign.workflow.schedule.lastCycleAt = new Date(nowMs).toISOString();
  campaign.workflow.schedule.lastCycleStatus = result.status;
  campaign.workflow.schedule.lastCycleSummary = summary;
  if (campaign.workflow.autonomy === "manual") {
    delete campaign.workflow.schedule.nextRunAt;
  } else {
    const nextRunInMinutes = boundedInt(
      result.nextRunInMinutes,
      campaign.workflow.schedule.intervalMinutes,
      1,
      campaign.workflow.schedule.intervalMinutes,
    );
    campaign.workflow.schedule.nextRunAt = new Date(
      nowMs + nextRunInMinutes * 60_000,
    ).toISOString();
  }
  campaign.workflow.events.push(
    event(campaign.workflow, {
      type: "host_cycle_completed",
      at: now,
      actor: "system",
      summary,
    }),
  );
  campaign.workflow.events = campaign.workflow.events.slice(-500);
  return campaign;
}

export function recordTeamPlanned(
  source: Campaign,
  now = new Date().toISOString(),
): Campaign {
  const campaign = cloneCampaign(source);
  campaign.workflow.revision += 1;
  for (const stale of campaign.workflow.patches) {
    if (stale.status !== "proposed") continue;
    stale.status = "rejected";
    stale.decidedAt = now;
    stale.decisionNote = `首轮任务图已重新规划到 revision ${campaign.workflow.revision}`;
  }
  campaign.workflow.events.push(
    event(campaign.workflow, {
      type: "team_planned",
      at: now,
      actor: "human",
      summary: `首轮任务图已规划，revision ${campaign.workflow.revision}`,
    }),
  );
  campaign.workflow.events = campaign.workflow.events.slice(-500);
  return campaign;
}
