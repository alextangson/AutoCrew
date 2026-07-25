import {
  getCampaign,
  listCampaigns,
  recordCampaignHostedCycle,
} from "../../storage/campaign-store.js";
import { replanCampaign } from "./replanner.js";
import {
  runCampaignReadyTasks,
  type CampaignBatchResult,
} from "./scheduler.js";
import type {
  Campaign,
  CampaignHostedCycleStatus,
} from "./domain.js";

export interface CampaignHostEvent {
  campaignId: string;
  phase: "cycle_start" | "cycle_done" | "cycle_failed";
  label: string;
}

export interface CampaignHostCycleResult {
  campaignId: string;
  status: CampaignHostedCycleStatus;
  summary: string;
}

interface ManagedCampaignHostDeps {
  list?: (dataDir?: string) => Promise<Campaign[]>;
  get?: (id: string, dataDir?: string) => Promise<Campaign | null>;
  runReady?: (
    id: string,
    opts: { maxTasks?: number; onProgress?: (event: Record<string, unknown>) => void },
    dataDir?: string,
  ) => Promise<CampaignBatchResult>;
  replan?: typeof replanCampaign;
  recordCycle?: typeof recordCampaignHostedCycle;
  onEvent?: (event: CampaignHostEvent, dataDir?: string) => void;
}

interface StartManagedCampaignHostOptions extends ManagedCampaignHostDeps {
  resolveDataDir: () => Promise<string | undefined>;
  tickIntervalMs?: number;
  now?: () => Date;
}

const activeCycles = new Set<string>();

function dueAt(campaign: Campaign, now: Date): boolean {
  if (campaign.status !== "active" || campaign.workflow.autonomy === "manual") return false;
  const nextRun = campaign.workflow.schedule.nextRunAt;
  return Boolean(nextRun && Date.parse(nextRun) <= now.getTime());
}

function attentionReason(campaign: Campaign): string | null {
  const failed = campaign.tasks.filter((task) => task.status === "failed").length;
  if (failed > 0) return `${failed} 个任务失败，已停止自动推进并等待人工处理`;
  const approvals = campaign.tasks.filter((task) => task.status === "awaiting_approval").length;
  if (approvals > 0) return `${approvals} 个任务等待风险审批`;
  const patches = campaign.workflow.patches.filter((patch) => patch.status === "proposed").length;
  if (patches > 0) return `${patches} 个工作流 Patch 等待确认`;
  return null;
}

function allWorkCompleted(campaign: Campaign): boolean {
  const liveTasks = campaign.tasks.filter((task) => task.status !== "cancelled");
  return liveTasks.length > 0 && liveTasks.every((task) => task.status === "completed");
}

async function runOneCycle(
  campaign: Campaign,
  dataDir: string | undefined,
  deps: ManagedCampaignHostDeps,
  now: Date,
): Promise<CampaignHostCycleResult> {
  const runReady = deps.runReady ?? runCampaignReadyTasks;
  const get = deps.get ?? getCampaign;
  const replan = deps.replan ?? replanCampaign;
  const record = deps.recordCycle ?? recordCampaignHostedCycle;
  const lockKey = `${dataDir ?? "default"}:${campaign.id}`;
  if (activeCycles.has(lockKey)) {
    return { campaignId: campaign.id, status: "idle", summary: "上一托管周期仍在运行" };
  }

  activeCycles.add(lockKey);
  deps.onEvent?.(
    { campaignId: campaign.id, phase: "cycle_start", label: `${campaign.name} 开始托管周期` },
    dataDir,
  );
  try {
    const beforeRun = await get(campaign.id, dataDir);
    if (!beforeRun || !dueAt(beforeRun, now)) {
      const summary = "Campaign 状态、自治模式或托管时间已变化，本周期未执行";
      deps.onEvent?.(
        { campaignId: campaign.id, phase: "cycle_done", label: summary },
        dataDir,
      );
      return { campaignId: campaign.id, status: "idle", summary };
    }
    const batch = await runReady(
      campaign.id,
      { maxTasks: campaign.workflow.policy.maxTasksPerCycle },
      dataDir,
    );
    const current = await get(campaign.id, dataDir);
    if (!current) throw new Error("Campaign 在托管周期中消失");

    let status: CampaignHostedCycleStatus = batch.attempted > 0 ? "succeeded" : "idle";
    let summary =
      batch.attempted > 0
        ? `托管周期执行 ${batch.attempted} 项：成功 ${batch.succeeded}，失败 ${batch.failed}`
        : "托管周期没有可执行的 ready 任务";

    const attention = attentionReason(current);
    if (attention) {
      status = "attention";
      summary = attention;
    } else if (
      current.workflow.autonomy === "managed" &&
      allWorkCompleted(current) &&
      current.artifacts.length > 0
    ) {
      const planned = await replan(campaign.id, dataDir);
      status = planned.patch.status === "applied" ? "succeeded" : "attention";
      summary =
        planned.patch.status === "applied"
          ? `PiAgent 已自动应用下一轮安全 Patch：${planned.patch.reason}`
          : `PiAgent 已提出下一轮 Patch，等待人工确认：${planned.patch.reason}`;
    }

    const latest = await get(campaign.id, dataDir);
    const hasMoreReady =
      batch.attempted > 0 &&
      (latest?.tasks.some((task) => task.status === "ready") ?? false);
    await record(
      campaign.id,
      {
        status,
        summary,
        ...(hasMoreReady ? { nextRunInMinutes: 1 } : {}),
      },
      dataDir,
      now.toISOString(),
    );
    deps.onEvent?.(
      { campaignId: campaign.id, phase: "cycle_done", label: summary },
      dataDir,
    );
    return { campaignId: campaign.id, status, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latest = await get(campaign.id, dataDir).catch(() => null);
    if (!latest || latest.status !== "active" || latest.workflow.autonomy === "manual") {
      const summary = "Campaign 已暂停或切回手动，本周期已停止";
      deps.onEvent?.(
        { campaignId: campaign.id, phase: "cycle_done", label: summary },
        dataDir,
      );
      return { campaignId: campaign.id, status: "idle", summary };
    }
    const summary = `托管周期失败：${message.slice(0, 420)}`;
    await record(
      campaign.id,
      { status: "failed", summary },
      dataDir,
      now.toISOString(),
    ).catch(() => {});
    deps.onEvent?.(
      { campaignId: campaign.id, phase: "cycle_failed", label: summary },
      dataDir,
    );
    return { campaignId: campaign.id, status: "failed", summary };
  } finally {
    activeCycles.delete(lockKey);
  }
}

export async function runManagedCampaignHostTick(
  dataDir?: string,
  deps: ManagedCampaignHostDeps = {},
  now = new Date(),
): Promise<CampaignHostCycleResult[]> {
  const campaigns = await (deps.list ?? listCampaigns)(dataDir);
  const due = campaigns.filter((campaign) => dueAt(campaign, now));
  const results: CampaignHostCycleResult[] = [];
  // Deliberately sequential: a local user's campaigns should not create an
  // unbounded burst of model calls when AutoCrew restarts after being offline.
  for (const campaign of due) {
    results.push(await runOneCycle(campaign, dataDir, deps, now));
  }
  return results;
}

export function startManagedCampaignHost(
  options: StartManagedCampaignHostOptions,
): () => void {
  const tickIntervalMs = Math.max(10_000, options.tickIntervalMs ?? 60_000);
  let stopped = false;
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const dataDir = await options.resolveDataDir();
      await runManagedCampaignHostTick(dataDir, options, (options.now ?? (() => new Date()))());
    } catch (error) {
      console.error(
        "[campaign-host] tick 失败:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), tickIntervalMs);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
