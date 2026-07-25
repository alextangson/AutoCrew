import fs from "node:fs/promises";
import path from "node:path";
import {
  canTransitionCampaign,
  type Campaign,
  type CampaignAutonomyMode,
  type CampaignBrief,
  type CampaignAgent,
  type CampaignArtifactKind,
  type CampaignMode,
  type CampaignRun,
  type CampaignStatus,
  type CampaignTask,
} from "../modules/campaign/domain.js";
import { planCampaignTeam } from "../modules/campaign/team-planner.js";
import {
  createCampaignWorkflow,
  decideCampaignWorkflowPatch as decideWorkflowPatch,
  normalizeCampaignWorkflow,
  proposeCampaignWorkflowPatch as proposeWorkflowPatch,
  recordCampaignHostedCycle as recordHostedCycle,
  recordTeamPlanned,
  setCampaignAutonomy as updateCampaignAutonomy,
  type CampaignWorkflowPatchDraft,
} from "../modules/campaign/workflow-engine.js";
import { getDataDir } from "./local-store.js";
import { isCampaignId } from "./entity-id.js";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./json-atomic.js";

export interface CreateCampaignInput {
  name: string;
  mode: CampaignMode;
  brief: CampaignBrief;
  autonomy?: CampaignAutonomyMode;
}

const mutationQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  mutationQueues.set(key, next);
  const cleanup = () => {
    if (mutationQueues.get(key) === next) mutationQueues.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

async function campaignsRoot(dataDir?: string): Promise<string> {
  const root = path.join(getDataDir(dataDir), "campaigns");
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function campaignFile(id: string, dataDir?: string): Promise<string | null> {
  if (!isCampaignId(id)) return null;
  return path.join(await campaignsRoot(dataDir), id, "campaign.json");
}

type StoredCampaign = Omit<Campaign, "schemaVersion" | "workflow"> & {
  schemaVersion: 1 | 2;
  workflow?: Partial<Campaign["workflow"]>;
};

function normalizeCampaignRecord(value: unknown): Campaign | null {
  if (!value || typeof value !== "object") return null;
  const record = value as StoredCampaign;
  if (
    (record.schemaVersion !== 1 && record.schemaVersion !== 2) ||
    !isCampaignId(record.id) ||
    typeof record.name !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !Array.isArray(record.tasks) ||
    !Array.isArray(record.runs) ||
    !Array.isArray(record.artifacts) ||
    !Array.isArray(record.approvals) ||
    !Array.isArray(record.metrics)
  ) {
    return null;
  }
  return {
    ...record,
    schemaVersion: 2,
    workflow: normalizeCampaignWorkflow(record.workflow, record.createdAt),
  };
}

export async function createCampaign(input: CreateCampaignInput, dataDir?: string): Promise<Campaign> {
  const now = new Date().toISOString();
  const id = `campaign-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = await campaignsRoot(dataDir);
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: false });
  const campaign: Campaign = {
    schemaVersion: 2,
    id,
    name: input.name,
    mode: input.mode,
    status: "draft",
    brief: input.brief,
    team: null,
    tasks: [],
    runs: [],
    artifacts: [],
    approvals: [],
    metrics: [],
    workflow: createCampaignWorkflow(now, input.autonomy),
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonAtomic(path.join(dir, "campaign.json"), campaign);
  return campaign;
}

export async function getCampaign(id: string, dataDir?: string): Promise<Campaign | null> {
  const file = await campaignFile(id, dataDir);
  if (!file) return null;
  const campaign = normalizeCampaignRecord(await readJson<unknown>(file));
  return campaign?.id === id ? campaign : null;
}

export async function readCampaignArtifact(
  campaignId: string,
  artifactId: string,
  dataDir?: string,
): Promise<string | null> {
  if (!isCampaignId(campaignId) || !/^artifact-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(artifactId)) return null;
  const campaign = await getCampaign(campaignId, dataDir);
  const artifact = campaign?.artifacts.find((item) => item.id === artifactId);
  if (!artifact || artifact.uri !== `artifacts/${artifactId}.md`) return null;
  try {
    return await fs.readFile(path.join(await campaignsRoot(dataDir), campaignId, artifact.uri), "utf-8");
  } catch {
    return null;
  }
}

export async function listCampaigns(dataDir?: string): Promise<Campaign[]> {
  const root = await campaignsRoot(dataDir);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const campaigns: Campaign[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isCampaignId(entry.name)) continue;
    const campaign = normalizeCampaignRecord(
      await readJson<unknown>(path.join(root, entry.name, "campaign.json")),
    );
    if (campaign?.id === entry.name) campaigns.push(campaign);
  }
  return campaigns.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function mutateCampaign(
  id: string,
  dataDir: string | undefined,
  mutate: (campaign: Campaign) => Campaign | Promise<Campaign>,
): Promise<Campaign | null> {
  if (!isCampaignId(id)) return null;
  const queueKey = `${getDataDir(dataDir)}:${id}`;
  return enqueue(queueKey, async () => {
    const file = await campaignFile(id, dataDir);
    if (!file) return null;
    const current = normalizeCampaignRecord(await readJson<unknown>(file));
    if (!current || current.id !== id) return null;
    const updated = await mutate(current);
    updated.id = current.id;
    updated.schemaVersion = 2;
    updated.createdAt = current.createdAt;
    updated.updatedAt = new Date().toISOString();
    await writeJsonAtomic(file, updated);
    return updated;
  });
}

export interface ClaimedCampaignTask {
  campaign: Campaign;
  task: CampaignTask;
  run: CampaignRun;
  agent: CampaignAgent;
}

const STALE_RUN_MS = 30 * 60 * 1000;

/**
 * Atomically claim one ready task. Stale running tasks are failed and requeued
 * first, so a process crash cannot strand the campaign forever.
 */
export async function claimCampaignTask(
  id: string,
  dataDir?: string,
  now = new Date(),
): Promise<ClaimedCampaignTask | null> {
  let claimed: Omit<ClaimedCampaignTask, "campaign"> | null = null;
  const campaign = await mutateCampaign(id, dataDir, (current) => {
    if (current.status !== "active") throw new Error("Campaign 必须处于 active 才能执行任务");
    const nowIso = now.toISOString();
    const staleBefore = now.getTime() - STALE_RUN_MS;
    for (const task of current.tasks) {
      if (task.status !== "running") continue;
      const run = [...current.runs].reverse().find((item) => item.taskId === task.id && item.status === "running");
      if (!run?.startedAt || new Date(run.startedAt).getTime() > staleBefore) continue;
      run.status = "failed";
      run.finishedAt = nowIso;
      run.error = "进程中断或运行超时，任务已自动重新排队";
      task.status = "ready";
      task.updatedAt = nowIso;
    }

    const task = current.tasks.find((item) => item.status === "ready");
    if (!task || !current.team) return current;
    const agent = current.team.agents.find((item) => item.role === task.assigneeRole);
    if (!agent) throw new Error(`任务 ${task.id} 找不到角色 ${task.assigneeRole}`);
    const attempt = current.runs.filter((item) => item.taskId === task.id).length + 1;
    const run: CampaignRun = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId: task.id,
      agentId: agent.id,
      status: "running",
      attempt,
      startedAt: nowIso,
    };
    task.status = "running";
    task.updatedAt = nowIso;
    current.runs.push(run);
    claimed = { task: { ...task }, run: { ...run }, agent: { ...agent } };
    return current;
  });
  const result = claimed as Omit<ClaimedCampaignTask, "campaign"> | null;
  return campaign && result ? { campaign, ...result } : null;
}

function unlockDependentTasks(campaign: Campaign, now: string): void {
  const completed = new Set(campaign.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  for (const task of campaign.tasks) {
    if (task.status !== "pending" || !task.dependsOn.every((dependency) => completed.has(dependency))) continue;
    task.status = task.requiredApproval ? "awaiting_approval" : "ready";
    task.updatedAt = now;
  }
}

export async function completeCampaignTask(
  campaignId: string,
  runId: string,
  output: {
    title: string;
    markdown: string;
    kind: CampaignArtifactKind;
    runtime?: CampaignRun["runtime"];
    agentSessionId?: string;
  },
  dataDir?: string,
): Promise<Campaign | null> {
  return mutateCampaign(campaignId, dataDir, async (campaign) => {
    const run = campaign.runs.find((item) => item.id === runId);
    if (!run || run.status !== "running") throw new Error("Campaign run 不存在或已结束");
    const task = campaign.tasks.find((item) => item.id === run.taskId);
    if (!task || task.status !== "running") throw new Error("Campaign task 不存在或状态不匹配");
    const now = new Date().toISOString();
    const artifactId = `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const campaignDir = path.join(await campaignsRoot(dataDir), campaign.id);
    const artifactsDir = path.join(campaignDir, "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });
    const relativeUri = `artifacts/${artifactId}.md`;
    await writeTextAtomic(path.join(campaignDir, relativeUri), output.markdown.trim() + "\n");
    campaign.artifacts.push({
      id: artifactId,
      taskId: task.id,
      runId,
      kind: output.kind,
      title: output.title,
      uri: relativeUri,
      createdAt: now,
    });
    run.status = "succeeded";
    if (output.runtime) run.runtime = output.runtime;
    if (output.agentSessionId) run.agentSessionId = output.agentSessionId;
    run.finishedAt = now;
    task.status = "completed";
    task.updatedAt = now;
    unlockDependentTasks(campaign, now);
    return campaign;
  });
}

export async function failCampaignTask(
  campaignId: string,
  runId: string,
  error: string,
  dataDir?: string,
): Promise<Campaign | null> {
  return mutateCampaign(campaignId, dataDir, (campaign) => {
    const run = campaign.runs.find((item) => item.id === runId);
    if (!run || run.status !== "running") throw new Error("Campaign run 不存在或已结束");
    const task = campaign.tasks.find((item) => item.id === run.taskId);
    if (!task || task.status !== "running") throw new Error("Campaign task 不存在或状态不匹配");
    const now = new Date().toISOString();
    run.status = "failed";
    run.finishedAt = now;
    run.error = error.slice(0, 2_000);
    task.status = "failed";
    task.updatedAt = now;
    return campaign;
  });
}

export async function retryCampaignTask(
  campaignId: string,
  taskId: string,
  dataDir?: string,
): Promise<Campaign | null> {
  if (!/^task-(?:v\d+|dyn-r\d+)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(taskId)) return null;
  return mutateCampaign(campaignId, dataDir, (campaign) => {
    const task = campaign.tasks.find((item) => item.id === taskId);
    if (!task || task.status !== "failed") throw new Error("只有 failed 任务可以重试");
    const completed = new Set(campaign.tasks.filter((item) => item.status === "completed").map((item) => item.id));
    if (!task.dependsOn.every((dependency) => completed.has(dependency))) {
      throw new Error("上游依赖尚未完成，不能重试");
    }
    task.status = task.requiredApproval ? "awaiting_approval" : "ready";
    task.updatedAt = new Date().toISOString();
    return campaign;
  });
}

export async function buildCampaignTeam(id: string, dataDir?: string): Promise<Campaign | null> {
  return mutateCampaign(id, dataDir, (campaign) => {
    if (!['draft', 'planning', 'ready'].includes(campaign.status)) {
      throw new Error(`Campaign ${campaign.status} 状态不可重新组队`);
    }
    const { team, tasks } = planCampaignTeam({ ...campaign, status: "planning" });
    return recordTeamPlanned({ ...campaign, status: "ready", team, tasks });
  });
}

export async function setCampaignAutonomy(
  id: string,
  autonomy: CampaignAutonomyMode,
  dataDir?: string,
  intervalMinutes?: number,
): Promise<Campaign | null> {
  return mutateCampaign(id, dataDir, (campaign) =>
    updateCampaignAutonomy(
      campaign,
      autonomy,
      new Date().toISOString(),
      intervalMinutes ?? campaign.workflow.schedule.intervalMinutes,
    ),
  );
}

export async function recordCampaignHostedCycle(
  id: string,
  result: Parameters<typeof recordHostedCycle>[1],
  dataDir?: string,
  now = new Date().toISOString(),
): Promise<Campaign | null> {
  return mutateCampaign(id, dataDir, (campaign) => recordHostedCycle(campaign, result, now));
}

export async function proposeCampaignWorkflowPatch(
  id: string,
  draft: CampaignWorkflowPatchDraft,
  dataDir?: string,
): Promise<{ campaign: Campaign; patch: Campaign["workflow"]["patches"][number] } | null> {
  let proposed: Campaign["workflow"]["patches"][number] | null = null;
  const campaign = await mutateCampaign(id, dataDir, (current) => {
    const result = proposeWorkflowPatch(current, draft);
    proposed = result.patch;
    return result.campaign;
  });
  return campaign && proposed ? { campaign, patch: proposed } : null;
}

export async function decideCampaignWorkflowPatch(
  id: string,
  patchId: string,
  approved: boolean,
  note = "",
  dataDir?: string,
): Promise<Campaign | null> {
  return mutateCampaign(id, dataDir, (campaign) =>
    decideWorkflowPatch(campaign, patchId, approved, note),
  );
}

export async function transitionCampaign(
  id: string,
  target: CampaignStatus,
  dataDir?: string,
): Promise<Campaign | null> {
  return mutateCampaign(id, dataDir, (campaign) => {
    if (!canTransitionCampaign(campaign.status, target)) {
      throw new Error(`Invalid campaign transition: ${campaign.status} → ${target}`);
    }
    if (target === "active" && (!campaign.team || campaign.tasks.length === 0)) {
      throw new Error("Campaign 尚未组建团队，不能启动");
    }
    return { ...campaign, status: target };
  });
}
